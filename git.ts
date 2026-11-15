// The git object engine: content-addressed objects, pack reading and writing, tree and commit
// walking, ancestry and tree diffs. Pure node:zlib + node:crypto, no git binary anywhere.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export const TYPE_CODES: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const CODE_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The git object id of a typed payload: sha1 of "<type> <len>\0" + payload. */
export function objectId(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'latin1');
  return sha1Hex(Buffer.concat([header, data]));
}

export interface StoredObject {
  type: ObjectType;
  data: Buffer;
}

/** An in-memory object database. */
export class ObjectStore {
  readonly objects = new Map<string, StoredObject>();

  has(sha: string): boolean {
    return this.objects.has(sha);
  }

  get(sha: string): StoredObject | undefined {
    return this.objects.get(sha);
  }

  /** Store a payload under its object id; returns the id. Idempotent. */
  write(type: ObjectType, data: Buffer): string {
    const sha = objectId(type, data);
    if (!this.objects.has(sha)) this.objects.set(sha, { type, data });
    return sha;
  }

  /** Store an object whose id is already known (from a received pack). */
  put(sha: string, type: ObjectType, data: Buffer): void {
    if (!this.objects.has(sha)) this.objects.set(sha, { type, data });
  }
}

// ----------------------------------------------------------------------------------------------
// Pack reading
// ----------------------------------------------------------------------------------------------

/** Inflate exactly one pack object payload starting at `offset`, knowing its inflated size. */
function inflateEntry(pack: Buffer, offset: number, expectedSize: number): { data: Buffer; next: number } {
  // inflateSync with {info: true} reports how many input bytes the deflate stream consumed,
  // which is exactly where the next pack entry starts.
  try {
    const result = inflateSync(pack.subarray(offset), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten?: number };
    };
    const consumed = result.engine.bytesWritten;
    if (result.buffer.length === expectedSize && typeof consumed === 'number' && consumed > 0) {
      return { data: result.buffer, next: offset + consumed };
    }
  } catch {
    // Fall through to the search below.
  }
  // Fallback: the minimal prefix that inflates to the expected size is the compressed length.
  let lo = 1;
  let hi = Math.min(pack.length - offset, Math.max(64, expectedSize * 2 + 64));
  const attempt = (len: number): Buffer | null => {
    try {
      const out = inflateSync(pack.subarray(offset, offset + len));
      return out.length === expectedSize ? out : null;
    } catch {
      return null;
    }
  };
  let found: Buffer | null = attempt(hi);
  while (found === null && offset + hi < pack.length) {
    hi = Math.min(pack.length - offset, hi * 2);
    found = attempt(hi);
  }
  if (found === null) throw new Error('pack entry does not inflate');
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (attempt(mid) !== null) hi = mid;
    else lo = mid + 1;
  }
  const data = attempt(lo);
  if (data === null) throw new Error('pack entry does not inflate');
  return { data, next: offset + lo };
}

/** Apply a git delta payload to a base payload. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos] as number;
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos] as number;
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) { offset |= (delta[pos] as number) << (8 * i); pos += 1; }
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) { size |= (delta[pos] as number) << (8 * i); pos += 1; }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op > 0) {
      out.push(delta.subarray(pos, pos + op));
      pos += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== targetSize || result.length !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

export interface PackEntry {
  sha: string;
  type: ObjectType;
  data: Buffer;
}

/** Parse a whole pack (as received in a push) into resolved objects. `external` resolves a
 * ref-delta base that lives outside the pack (a thin pack), when the caller has one. */
export function parsePack(pack: Buffer, external?: (sha: string) => StoredObject | undefined): PackEntry[] {
  if (pack.length < 12 + 20 || pack.subarray(0, 4).toString('latin1') !== 'PACK') throw new Error('not a pack');
  const count = pack.readUInt32BE(8);
  let pos = 12;
  const raw: { type: ObjectType; data: Buffer; baseSha?: string; baseOffset?: number; start: number }[] = [];
  for (let i = 0; i < count; i += 1) {
    const start = pos;
    let byte = pack[pos] as number;
    pos += 1;
    let typeCode = (byte >> 4) & 7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[pos] as number;
      pos += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseSha: string | undefined;
    let baseOffset: number | undefined;
    if (typeCode === 6) {
      // OFS_DELTA: negative offset varint.
      let b = pack[pos] as number;
      pos += 1;
      let offset = b & 0x7f;
      while (b & 0x80) {
        b = pack[pos] as number;
        pos += 1;
        offset = ((offset + 1) << 7) | (b & 0x7f);
      }
      baseOffset = start - offset;
    } else if (typeCode === 7) {
      baseSha = pack.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    }
    const inflated = inflateEntry(pack, pos, size);
    pos = inflated.next;
    const type = CODE_TYPES[typeCode];
    raw.push({ type: type as ObjectType, data: inflated.data, baseSha, baseOffset, start });
    void typeCode;
  }
  // Resolve deltas (bases may be earlier entries or, for thin packs, store objects handled by caller).
  const byOffset = new Map<number, number>();
  raw.forEach((entry, idx) => byOffset.set(entry.start, idx));
  const resolved: (PackEntry | null)[] = raw.map(() => null);
  const resolve = (idx: number, seen: Set<number>): PackEntry => {
    const done = resolved[idx];
    if (done !== null && done !== undefined) return done;
    if (seen.has(idx)) throw new Error('delta cycle');
    seen.add(idx);
    const entry = raw[idx] as (typeof raw)[number];
    let out: PackEntry;
    if (entry.baseSha === undefined && entry.baseOffset === undefined) {
      out = { sha: objectId(entry.type, entry.data), type: entry.type, data: entry.data };
    } else {
      let base: PackEntry;
      if (entry.baseOffset !== undefined) {
        const baseIdx = byOffset.get(entry.baseOffset);
        if (baseIdx === undefined) throw new Error('ofs-delta base not in pack');
        base = resolve(baseIdx, seen);
      } else {
        let found = -1;
        for (let i = 0; i < raw.length; i += 1) {
          if (resolve(i, new Set()).sha === entry.baseSha) { found = i; break; }
        }
        if (found >= 0) {
          base = resolve(found, seen);
        } else if (external !== undefined) {
          const outside = external(entry.baseSha as string);
          if (outside === undefined) throw new Error('ref-delta base not in pack');
          base = { sha: entry.baseSha as string, type: outside.type, data: outside.data };
        } else {
          throw new Error('ref-delta base not in pack');
        }
      }
      const data = applyDelta(base.data, entry.data);
      out = { sha: objectId(base.type, data), type: base.type, data };
    }
    resolved[idx] = out;
    return out;
  };
  return raw.map((_, idx) => resolve(idx, new Set()));
}

// ----------------------------------------------------------------------------------------------
// Pack writing
// ----------------------------------------------------------------------------------------------

function packEntryHeader(type: ObjectType, size: number): Buffer {
  const bytes: number[] = [];
  let first = (TYPE_CODES[type] << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Build a complete pack holding the given objects, all as full (non-delta) entries. */
export function buildPack(store: ObjectStore, shas: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'latin1');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(shas.length, 8);
  parts.push(header);
  for (const sha of shas) {
    const obj = store.get(sha);
    if (obj === undefined) throw new Error(`pack: missing object ${sha}`);
    parts.push(packEntryHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ----------------------------------------------------------------------------------------------
// Trees and commits
// ----------------------------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const mode = data.subarray(pos, space).toString('latin1');
    const nul = data.indexOf(0x00, space + 1);
    const name = data.subarray(space + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    pos = nul + 21;
  }
  return entries;
}

export function writeTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  authorLine: string;
  committerLine: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let authorLine = '';
  let committerLine = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) authorLine = line.slice(7);
    else if (line.startsWith('committer ')) committerLine = line.slice(10);
  }
  return { tree, parents, authorLine, committerLine, message };
}

export function writeCommit(info: CommitInfo): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.authorLine}`);
  lines.push(`committer ${info.committerLine}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  taggerLine: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const out: TagInfo = { object: '', type: '', tag: '', taggerLine: '', message: split < 0 ? '' : text.slice(split + 2) };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) out.object = line.slice(7).trim();
    else if (line.startsWith('type ')) out.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) out.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) out.taggerLine = line.slice(7);
  }
  return out;
}

/** Peel a ref target to a commit sha (through annotated tags). */
export function peelToCommit(store: ObjectStore, sha: string): string | null {
  let current = sha;
  for (let i = 0; i < 10; i += 1) {
    const obj = store.get(current);
    if (obj === undefined) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      current = parseTag(obj.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/**
 * All objects reachable from the given tips. `maxDepthCommits` bounds the commit walk the way a
 * shallow clone does: commits at distance < maxDepthCommits from a tip are included, each with its
 * full tree; their parents are not. `excludeTips` subtracts everything reachable from them (the
 * fetch "haves"). Returns the object list plus the shallow-boundary commits (included commits
 * that have parents which were cut).
 */
export function collectObjects(
  store: ObjectStore,
  tips: readonly string[],
  opts: { maxDepthCommits?: number; excludeTips?: readonly string[] } = {},
): { objects: string[]; shallowBoundary: string[] } {
  const excluded = new Set<string>();
  if (opts.excludeTips !== undefined) {
    for (const sha of collectObjects(store, opts.excludeTips).objects) excluded.add(sha);
  }
  const seen = new Set<string>();
  const order: string[] = [];
  const boundary = new Set<string>();
  const addObject = (sha: string): void => {
    if (seen.has(sha) || excluded.has(sha)) return;
    seen.add(sha);
    order.push(sha);
  };
  const addTreeClosure = (treeSha: string): void => {
    const stack = [treeSha];
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (seen.has(sha) || excluded.has(sha)) continue;
      const obj = store.get(sha);
      if (obj === undefined) continue;
      addObject(sha);
      if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) stack.push(entry.sha);
      }
    }
  };
  const commitDepth = new Map<string, number>();
  const queue: { sha: string; depth: number }[] = [];
  for (const tip of tips) queue.push({ sha: tip, depth: 0 });
  while (queue.length > 0) {
    const { sha, depth } = queue.shift() as { sha: string; depth: number };
    const obj = store.get(sha);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      addObject(sha);
      queue.push({ sha: parseTag(obj.data).object, depth });
      continue;
    }
    if (obj.type !== 'commit') continue;
    const known = commitDepth.get(sha);
    if (known !== undefined && known <= depth) continue;
    commitDepth.set(sha, depth);
    if (opts.maxDepthCommits !== undefined && depth >= opts.maxDepthCommits) continue;
    // A commit the client already has is traversed (a deepen may reach past it) but not resent.
    const held = excluded.has(sha);
    if (!held) {
      addObject(sha);
      const commit = parseCommit(obj.data);
      addTreeClosure(commit.tree);
    }
    const commit = parseCommit(obj.data);
    const atBoundary = opts.maxDepthCommits !== undefined && depth === opts.maxDepthCommits - 1;
    if (atBoundary) {
      if (!held && commit.parents.length > 0) boundary.add(sha);
    } else {
      for (const parent of commit.parents) queue.push({ sha: parent, depth: depth + 1 });
    }
  }
  return { objects: order, shallowBoundary: [...boundary] };
}

/** Is `ancestor` an ancestor of (or equal to) `descendant`? */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const sha = queue.pop() as string;
    if (sha === ancestor) return true;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = store.get(sha);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return false;
}

/** A common ancestor of two commits (the first found by BFS from b's history intersected with a's). */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const ancestorsOfA = new Set<string>();
  const queueA = [a];
  while (queueA.length > 0) {
    const sha = queueA.pop() as string;
    if (ancestorsOfA.has(sha)) continue;
    ancestorsOfA.add(sha);
    const obj = store.get(sha);
    if (obj !== undefined && obj.type === 'commit') queueA.push(...parseCommit(obj.data).parents);
  }
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const sha = queue.shift() as string;
    if (ancestorsOfA.has(sha)) return sha;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const obj = store.get(sha);
    if (obj !== undefined && obj.type === 'commit') queue.push(...parseCommit(obj.data).parents);
  }
  return null;
}

/** Flatten a tree into path -> {mode, sha}. */
export function flattenTree(store: ObjectStore, treeSha: string, prefix = ''): Map<string, { mode: string; sha: string }> {
  const out = new Map<string, { mode: string; sha: string }>();
  const obj = store.get(treeSha);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [k, v] of flattenTree(store, entry.sha, path)) out.set(k, v);
    } else {
      out.set(path, { mode: entry.mode, sha: entry.sha });
    }
  }
  return out;
}

/** Build nested trees from a flat path -> blob map; returns the root tree sha. */
export function buildTreeFromFlat(store: ObjectStore, flat: ReadonlyMap<string, { mode: string; sha: string }>): string {
  interface Node {
    files: Map<string, { mode: string; sha: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, info] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i] as string;
      if (!node.dirs.has(part)) node.dirs.set(part, { files: new Map(), dirs: new Map() });
      node = node.dirs.get(part) as Node;
    }
    node.files.set(parts[parts.length - 1] as string, info);
  }
  const emit = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, info] of node.files) entries.push({ mode: info.mode, name, sha: info.sha });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, sha: emit(child) });
    return store.write('tree', writeTree(entries));
  };
  return emit(root);
}

/** Count line additions/deletions between two texts with an LCS over lines. */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  // LCS via dynamic programming on line arrays (files in the suite are small).
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? (dp[i + 1][j + 1] as number) + 1 : Math.max(dp[i + 1][j] as number, dp[i][j + 1] as number);
    }
  }
  const common = dp[0][0] as number;
  return { additions: n - common, deletions: m - common };
}
