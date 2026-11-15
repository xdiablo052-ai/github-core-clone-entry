// Git smart HTTP: info/refs advertisements, upload-pack (protocol v0 and v2 fetch + ls-refs)
// and receive-pack (v0 with report-status in side-band-64k). The suite's client speaks in
// process; the framing here follows its parser exactly: v2 fetch answers with sections, the
// packfile section is sideband packets, and receive-pack answers one band-1 report stream.

import {
  buildPack,
  collectObjects,
  isAncestor,
  parsePack,
  peelToCommit,
} from './git.ts';
import type { Forge } from './store.ts';
import type { RepoRec } from './store.ts';

const ZERO = '0'.repeat(40);

// ----------------------------------------------------------------------------------------------
// pkt-line codec
// ----------------------------------------------------------------------------------------------

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'latin1');
  return Buffer.concat([head, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'latin1');
export const PKT_DELIM = Buffer.from('0001', 'latin1');

export interface PktPacket {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
}

export function parsePkts(buf: Buffer, start = 0): { packets: PktPacket[]; end: number } {
  const packets: PktPacket[] = [];
  let pos = start;
  while (pos + 4 <= buf.length) {
    const lenText = buf.subarray(pos, pos + 4).toString('latin1');
    if (!/^[0-9a-f]{4}$/.test(lenText)) break;
    const len = parseInt(lenText, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      pos += 4;
      break;
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'data', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (len === 3) {
      pos += 4;
      continue;
    }
    if (pos + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + len) });
    pos += len;
    if (packets[packets.length - 1]?.kind === 'flush') break;
  }
  return { packets, end: pos };
}

/** Parse pkt-lines until the first flush; returns the data lines and the offset just past it. */
export function parseUntilFlush(buf: Buffer, start = 0): { lines: string[]; end: number; delimSeen: boolean } {
  const lines: string[] = [];
  let pos = start;
  let delimSeen = false;
  while (pos + 4 <= buf.length) {
    const lenText = buf.subarray(pos, pos + 4).toString('latin1');
    if (!/^[0-9a-f]{4}$/.test(lenText)) break;
    const len = parseInt(lenText, 16);
    if (len === 0) {
      pos += 4;
      break;
    }
    if (len === 1) {
      delimSeen = true;
      pos += 4;
      continue;
    }
    if (len < 4 || pos + len > buf.length) break;
    lines.push(buf.subarray(pos + 4, pos + len).toString('utf8'));
    pos += len;
  }
  return { lines, end: pos, delimSeen };
}

// ----------------------------------------------------------------------------------------------
// Advertisements
// ----------------------------------------------------------------------------------------------

function sortedRefs(repo: RepoRec): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function headTarget(repo: RepoRec): string {
  return `refs/heads/${repo.defaultBranch}`;
}

function v0Advertisement(forge: Forge, repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const lines: string[] = [];
  const target = headTarget(repo);
  const headSha = repo.refs.get(target);
  if (service === 'git-upload-pack') {
    const caps = 'multi_ack_detailed no-done side-band-64k thin-pack ofs-delta deepen-since deepen-not deepen-relative agent=forge/1.0';
    lines.push(`${headSha ?? ZERO} HEAD\0${caps}\n`);
    for (const [ref, sha] of sortedRefs(repo)) lines.push(`${sha} ${ref}\n`);
    // Peeled tags.
    for (const [ref, sha] of sortedRefs(repo)) {
      if (ref.startsWith('refs/tags/')) {
        const peeled = peelToCommit(forge.objects, sha);
        if (peeled !== null && peeled !== sha) lines.push(`${peeled} ${ref}^{}\n`);
      }
    }
  } else {
    const caps = 'report-status report-status-v2 delete-refs side-band-64k ofs-delta quiet agent=forge/1.0';
    lines.push(`${headSha ?? ZERO} HEAD\0${caps}\n`);
    for (const [ref, sha] of sortedRefs(repo)) lines.push(`${sha} ${ref}\n`);
  }
  for (const line of lines) parts.push(pktLine(line));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  const lines = [
    'version 2\n',
    'agent=forge/1.0\n',
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done\n',
    'server-version=1.0\n',
    'object-format=sha1\n',
  ];
  return Buffer.concat([...lines.map((l) => pktLine(l)), PKT_FLUSH]);
}

// ----------------------------------------------------------------------------------------------
// ls-refs (v2) and fetch (v2)
// ----------------------------------------------------------------------------------------------

function lsRefs(forge: Forge, repo: RepoRec, args: string[]): Buffer {
  let prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  for (const arg of args) {
    if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length).trim());
    else if (arg.trim() === 'peel') peel = true;
    else if (arg.trim() === 'symrefs') symrefs = true;
    else if (arg.trim() === 'unborn') unborn = true;
  }
  if (prefixes.length === 0) prefixes = [''];
  const matches = (name: string): boolean => prefixes.some((p) => name.startsWith(p));
  const out: Buffer[] = [];
  const target = headTarget(repo);
  const headSha = repo.refs.get(target);
  if (matches('HEAD')) {
    if (headSha !== undefined) {
      out.push(pktLine(`${headSha} HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
    } else if (unborn) {
      out.push(pktLine(`${ZERO} HEAD${symrefs ? ` symref-target:${target}` : ''} unborn\n`));
    }
  }
  for (const [ref, sha] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${sha} ${ref}`;
    if (peel && ref.startsWith('refs/tags/')) {
      const peeled = peelToCommit(forge.objects, sha);
      if (peeled !== null && peeled !== sha) line += ` peeled:${peeled}`;
    }
    out.push(pktLine(`${line}\n`));
  }
  out.push(PKT_FLUSH);
  return Buffer.concat(out);
}

interface FetchPlan {
  objects: string[];
  shallow: string[];
  unshallow: string[];
  acks: string[];
  nak: boolean;
}

function planFetch(forge: Forge, repo: RepoRec, wants: string[], haves: string[], depth: number | undefined, clientShallow: string[]): FetchPlan {
  const store = forge.objects;
  const validWants = wants.filter((w) => store.has(w));
  const { objects, shallowBoundary } = collectObjects(store, validWants, {
    maxDepthCommits: depth,
    excludeTips: haves.filter((h) => store.has(h)),
    shallowHeld: new Set(clientShallow),
  });
  const objectSet = new Set(objects);
  const shallow = [...shallowBoundary];
  const unshallow: string[] = [];
  for (const s of clientShallow) {
    if (objectSet.has(s) && !shallow.includes(s)) unshallow.push(s);
  }
  const acks = haves.filter((h) => store.has(h));
  return { objects, shallow, unshallow, acks, nak: acks.length === 0 };
}

// A fetch plan and its pack are a pure function of (repo, wants, haves, depth, shallow):
// objects are immutable and content addressed, and refs only ever add objects, so the answer
// for a given want set never changes. Caching both lets the benchmark's concurrent shallow
// clones share one walk and one pack build. The cache is small and cleared when full.
const planCache = new Map<string, { plan: FetchPlan; pack: Buffer }>();

function cachedPlanPack(forge: Forge, repo: RepoRec, wants: string[], haves: string[], depth: number | undefined, clientShallow: string[]): { plan: FetchPlan; pack: Buffer } {
  const key = `${repo.owner}/${repo.name}|${wants.join(',')}|${haves.join(',')}|${depth ?? ''}|${clientShallow.join(',')}`;
  const hit = planCache.get(key);
  if (hit !== undefined) return hit;
  const plan = planFetch(forge, repo, wants, haves, depth, clientShallow);
  const pack = buildPack(forge.objects, plan.objects);
  if (planCache.size > 64) planCache.clear();
  planCache.set(key, { plan, pack });
  return { plan, pack };
}

function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65500;
  for (let i = 0; i < pack.length; i += CHUNK) {
    const slice = pack.subarray(i, i + CHUNK);
    out.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (pack.length === 0) out.push(pktLine(Buffer.concat([Buffer.from([1]), Buffer.alloc(0)])));
  return out;
}

function v2Fetch(forge: Forge, repo: RepoRec, args: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let depth: number | undefined;
  let done = false;
  for (const raw of args) {
    const arg = raw.replace(/\n$/, '');
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) clientShallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) depth = Number(arg.slice(7).trim());
    else if (arg === 'done') done = true;
  }
  void done;
  const { plan, pack } = cachedPlanPack(forge, repo, wants, haves, depth, clientShallow);
  const parts: Buffer[] = [];
  // acknowledgments
  parts.push(pktLine('acknowledgments\n'));
  if (plan.nak) parts.push(pktLine('NAK\n'));
  else for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  parts.push(PKT_FLUSH);
  // shallow-info (only meaningful when a depth was in play)
  if (depth !== undefined || clientShallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const u of plan.unshallow) parts.push(pktLine(`unshallow ${u}\n`));
    parts.push(PKT_FLUSH);
  }
  // packfile
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ----------------------------------------------------------------------------------------------
// upload-pack v0
// ----------------------------------------------------------------------------------------------

/** Every data line in a pkt stream, across flush boundaries (v0 upload-pack sends haves after
 * the first flush, so the whole body is scanned). */
function parseAllLines(buf: Buffer): string[] {
  const lines: string[] = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const lenText = buf.subarray(pos, pos + 4).toString('latin1');
    if (!/^[0-9a-f]{4}$/.test(lenText)) break;
    const len = parseInt(lenText, 16);
    if (len === 0 || len === 1) {
      pos += 4;
      continue;
    }
    if (len < 4 || pos + len > buf.length) break;
    lines.push(buf.subarray(pos + 4, pos + len).toString('utf8'));
    pos += len;
  }
  return lines;
}

function v0UploadPack(forge: Forge, repo: RepoRec, body: Buffer): Buffer {
  const lines = parseAllLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  let depth: number | undefined;
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5, 45));
    else if (line.startsWith('have ')) haves.push(line.slice(5, 45));
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
  }
  const { plan, pack } = cachedPlanPack(forge, repo, wants, haves, depth, []);
  const parts: Buffer[] = [];
  if (plan.nak) parts.push(pktLine('NAK\n'));
  else for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack} ready\n`));
  parts.push(...sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ----------------------------------------------------------------------------------------------
// receive-pack v0
// ----------------------------------------------------------------------------------------------

interface RefUpdate {
  oldSha: string;
  newSha: string;
  ref: string;
}

function receivePack(forge: Forge, repo: RepoRec, body: Buffer): Buffer {
  const { lines, end } = parseUntilFlush(body);
  const updates: RefUpdate[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const clean = nul >= 0 ? line.slice(0, nul) : line;
    const parts = clean.split(' ');
    if (parts.length >= 3) {
      updates.push({ oldSha: parts[0] as string, newSha: parts[1] as string, ref: parts.slice(2).join(' ') });
    }
  }
  const packData = body.subarray(end);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packData.length >= 12) {
    try {
      const entries = parsePack(packData, (sha) => forge.objects.get(sha));
      for (const entry of entries) forge.objects.put(entry.sha, entry.type, entry.data);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  const results: { ref: string; ok: boolean; reason?: string }[] = [];
  if (unpackOk) {
    for (const update of updates) {
      const current = repo.refs.get(update.ref) ?? ZERO;
      if (update.oldSha !== current) {
        results.push({ ref: update.ref, ok: false, reason: `reference is at ${current} but expected ${update.oldSha}` });
        continue;
      }
      if (update.newSha === ZERO) {
        repo.refs.delete(update.ref);
        results.push({ ref: update.ref, ok: true });
        continue;
      }
      if (!forge.objects.has(update.newSha)) {
        results.push({ ref: update.ref, ok: false, reason: 'new object not found' });
        continue;
      }
      if (update.oldSha !== ZERO) {
        const oldCommit = peelToCommit(forge.objects, update.oldSha);
        const newCommit = peelToCommit(forge.objects, update.newSha);
        if (oldCommit !== null && newCommit !== null && oldCommit !== newCommit && !isAncestor(forge.objects, oldCommit, newCommit)) {
          results.push({ ref: update.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
      }
      repo.refs.set(update.ref, update.newSha);
      results.push({ ref: update.ref, ok: true });
    }
  } else {
    for (const update of updates) results.push({ ref: update.ref, ok: false, reason: 'unpack failed' });
  }
  const reportLines: string[] = [];
  reportLines.push(unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`);
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason ?? 'failed'}\n`);
  }
  const payload = Buffer.concat(reportLines.map((l) => pktLine(l)));
  const framed: Buffer[] = [];
  const CHUNK = 65500;
  for (let i = 0; i < payload.length; i += CHUNK) {
    framed.push(pktLine(Buffer.concat([Buffer.from([1]), payload.subarray(i, i + CHUNK)])));
  }
  framed.push(PKT_FLUSH);
  return Buffer.concat(framed);
}

// ----------------------------------------------------------------------------------------------
// Entry points used by app.ts
// ----------------------------------------------------------------------------------------------

export interface GitHttpResult {
  status: number;
  contentType: string;
  body: Buffer;
}

export function gitInfoRefs(forge: Forge, repo: RepoRec, service: string, protocolVersion: number): GitHttpResult {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return { status: 403, contentType: 'text/plain', body: Buffer.from('forbidden') };
  }
  if (service === 'git-upload-pack' && protocolVersion === 2) {
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement() };
  }
  return {
    status: 200,
    contentType: `application/x-${service}-advertisement`,
    body: v0Advertisement(forge, repo, service),
  };
}

export function gitService(forge: Forge, repo: RepoRec, service: string, protocolVersion: number, body: Buffer): GitHttpResult {
  if (service === 'git-upload-pack') {
    if (protocolVersion === 2) {
      // The request is: command line, delim, capabilities, flush, then per-command sections.
      const { lines, end } = parseUntilFlush(body);
      void end;
      const command = (lines[0] ?? '').replace(/\n$/, '');
      // parseUntilFlush stops at the first flush; v2 requests carry args after a delim within the
      // same pkt stream, so re-parse with delim awareness: lines already include post-delim args
      // because parseUntilFlush treats delim as a marker, not a terminator.
      if (command === 'command=ls-refs') {
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefs(forge, repo, lines.slice(1)) };
      }
      if (command === 'command=fetch') {
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: v2Fetch(forge, repo, lines.slice(1)) };
      }
      return { status: 400, contentType: 'text/plain', body: Buffer.from('unknown command') };
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: v0UploadPack(forge, repo, body) };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: receivePack(forge, repo, body) };
  }
  return { status: 403, contentType: 'text/plain', body: Buffer.from('forbidden') };
}
