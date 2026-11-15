// REST v3: repositories, branches, commits, contents, labels, issues, comments and pull
// requests (with squash/merge). Shapes follow GitHub's: the suite asserts the fields it reads
// and tolerates the rest, so each object carries the standard fields a real client would use.

import {
  buildTreeFromFlat,
  flattenTree,
  isAncestor,
  lineDiff,
  mergeBase,
  objectId,
  parseCommit,
  parseTree,
  peelToCommit,
  writeCommit,
} from './git.ts';
import { Forge, VIEWER, issueNodeId, nodeId, pullNodeId, userByLogin, type IssueRec, type PullRec, type RepoRec } from './store.ts';

export interface RestResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const ok = (status: number, body: unknown, headers?: Record<string, string>): RestResult => ({ status, body, headers });
const fail = (status: number, message: string): RestResult => ({ status, body: { message } });

export function userJson(login: string): Record<string, unknown> {
  const user = userByLogin(login) ?? VIEWER;
  return { login: user.login, id: user.id, node_id: nodeId('User', user.id), type: 'User', site_admin: false };
}

export function repoJson(forge: Forge, repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: nodeId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private,
    owner: userJson(repo.owner),
    description: repo.description,
    fork: false,
    created_at: forge.isoOf(repo.tick),
    updated_at: forge.isoOf(repo.tick),
    pushed_at: forge.isoOf(repo.tick),
    default_branch: repo.defaultBranch,
    visibility: repo.private ? 'private' : 'public',
    html_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `/${repo.owner}/${repo.name}.git`,
  };
}

function labelJson(forge: Forge, repo: RepoRec, name: string): Record<string, unknown> | null {
  const label = repo.labels.get(name);
  if (label === undefined) return null;
  void forge;
  return { id: label.id, node_id: nodeId('Label', label.id), name: label.name, color: label.color, description: label.description, default: false };
}

export function issueJson(forge: Forge, repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: repo.id * 1_000_000 + issue.number,
    node_id: issueNodeId(repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(forge, repo, name)).filter((x) => x !== null),
    user: userJson(issue.authorLogin),
    author_login: issue.authorLogin,
    comments: issue.comments.length,
    created_at: forge.isoOf(issue.tick),
    updated_at: forge.isoOf(issue.tick),
    closed_at: issue.state === 'closed' ? forge.isoOf(issue.tick) : null,
    html_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullJson(forge: Forge, repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? null;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? null;
  return {
    id: repo.id * 1_000_000 + pull.number,
    node_id: pullNodeId(repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged ? forge.isoOf(pull.mergedTick ?? pull.tick) : null,
    merge_commit_sha: pull.mergeCommitSha,
    user: userJson(pull.authorLogin),
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: headSha,
      repo: repoJson(forge, repo),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: baseSha,
      repo: repoJson(forge, repo),
    },
    created_at: forge.isoOf(pull.tick),
    updated_at: forge.isoOf(pull.tick),
    html_url: `/api/v3/repos/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function commitJson(forge: Forge, sha: string): Record<string, unknown> | null {
  const obj = forge.objects.get(sha);
  if (obj === undefined || obj.type !== 'commit') return null;
  const commit = parseCommit(obj.data);
  const splitLine = (line: string): { name: string; email: string; date: string } => {
    const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
    if (match === null) return { name: line, email: '', date: forge.isoOf(forge.nowTick()) };
    return { name: match[1] as string, email: match[2] as string, date: forge.isoOf(Number(match[3])) };
  };
  return {
    sha,
    node_id: nodeId('Commit', 0) + sha,
    commit: {
      author: splitLine(commit.authorLine),
      committer: splitLine(commit.committerLine),
      message: commit.message,
      tree: { sha: commit.tree },
    },
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

// ----------------------------------------------------------------------------------------------
// Contents helpers
// ----------------------------------------------------------------------------------------------

/** The flat file map of a branch (or empty for an unborn branch). */
export function branchFlat(forge: Forge, repo: RepoRec, branch: string): { tip: string | null; flat: Map<string, { mode: string; sha: string }> } {
  const tip = repo.refs.get(`refs/heads/${branch}`) ?? null;
  if (tip === null) return { tip: null, flat: new Map() };
  const commit = peelToCommit(forge.objects, tip);
  if (commit === null) return { tip, flat: new Map() };
  const commitObj = forge.objects.get(commit);
  if (commitObj === undefined) return { tip, flat: new Map() };
  return { tip, flat: flattenTree(forge.objects, parseCommit(commitObj.data).tree) };
}

/** Commit a new flat map onto a branch; returns the new commit sha. */
export function commitFlat(forge: Forge, repo: RepoRec, branch: string, flat: Map<string, { mode: string; sha: string }>, message: string, parentOverride?: string | null): string {
  const tree = buildTreeFromFlat(forge.objects, flat);
  const tip = parentOverride !== undefined ? parentOverride : repo.refs.get(`refs/heads/${branch}`) ?? null;
  const tick = forge.tick();
  const line = forge.authorLine(tick);
  const commitSha = forge.objects.write('commit', writeCommit({
    tree,
    parents: tip === null ? [] : [tip],
    authorLine: line,
    committerLine: line,
    message,
  }));
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  return commitSha;
}

// ----------------------------------------------------------------------------------------------
// The router
// ----------------------------------------------------------------------------------------------

export interface RestRequest {
  method: string;
  segments: string[]; // path segments after /api/v3
  query: URLSearchParams;
  body: Record<string, unknown> | null;
  rawBody: Buffer;
  host: string;
}

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? '30') || 30));
  return { page, perPage };
}

function paginate<T>(items: T[], query: URLSearchParams, basePath: string, host: string): { page: T[]; headers: Record<string, string> } {
  const { page, perPage } = pageParams(query);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const params = new URLSearchParams(query);
    params.set('page', String(page + 1));
    params.set('per_page', String(perPage));
    headers.link = `<http://${host}${basePath}?${params.toString()}>; rel="next"`;
  }
  return { page: slice, headers };
}

export function handleRest(forge: Forge, req: RestRequest): RestResult {
  const seg = req.segments;
  const method = req.method;

  if (seg.length === 0) {
    if (method !== 'GET') return fail(404, 'Not Found');
    return ok(200, {
      current_user_url: '/api/v3/user',
      user_repositories_url: '/api/v3/user/repos',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      rate_limit_url: '/api/v3/rate_limit',
    }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (seg[0] === 'meta' && seg.length === 1 && method === 'GET') {
    return ok(200, { installed_version: '1.0.0-forge', verifiable_password_authentication: false });
  }
  if (seg[0] === 'rate_limit' && seg.length === 1 && method === 'GET') {
    return ok(200, { rate: { limit: 5000, used: 0, remaining: 5000, reset: forge.nowTick() + 3600 }, resources: {} });
  }
  if (seg[0] === 'user' && seg.length === 1 && method === 'GET') {
    return ok(200, userJson(VIEWER.login));
  }
  if (seg[0] === 'user' && seg[1] === 'repos' && seg.length === 2) {
    if (method === 'GET') {
      const all = forge.reposOf(VIEWER.login).map((repo) => repoJson(forge, repo));
      const { page, headers } = paginate(all, req.query, '/api/v3/user/repos', req.host);
      return ok(200, page, headers);
    }
    if (method === 'POST') {
      const body = req.body ?? {};
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') return fail(422, 'Repository creation failed: name is required');
      if (forge.getRepo(VIEWER.login, name) !== undefined) {
        return { status: 422, body: { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] } };
      }
      const repo = forge.createRepo(VIEWER.login, name, {
        private: body.private === true,
        description: typeof body.description === 'string' ? body.description : '',
        defaultBranch: typeof body.default_branch === 'string' && body.default_branch !== '' ? body.default_branch : 'main',
      });
      return ok(201, repoJson(forge, repo));
    }
    return fail(404, 'Not Found');
  }

  if (seg[0] !== 'repos' || seg.length < 3) return fail(404, 'Not Found');
  const owner = seg[1] as string;
  const name = seg[2] as string;
  const repo = forge.getRepo(owner, name);
  if (repo === undefined) return fail(404, 'Not Found');
  const rest = seg.slice(3);

  if (rest.length === 0) {
    if (method === 'GET') return ok(200, repoJson(forge, repo));
    if (method === 'PATCH') {
      const body = req.body ?? {};
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
      if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
        forge.repos.delete(forge.key(repo.owner, repo.name));
        repo.name = body.name;
        forge.repos.set(forge.key(repo.owner, repo.name), repo);
      }
      return ok(200, repoJson(forge, repo));
    }
    if (method === 'DELETE') {
      forge.deleteRepo(owner, name);
      return { status: 204 };
    }
    return fail(404, 'Not Found');
  }

  return handleRepoSub(forge, repo, rest, req);
}

function handleRepoSub(forge: Forge, repo: RepoRec, rest: string[], req: RestRequest): RestResult {
  const method = req.method;
  const [head, ...tail] = rest as [string, ...string[]];

  if (head === 'branches' && tail.length === 0 && method === 'GET') {
    const branches: Record<string, unknown>[] = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false });
    }
    branches.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return ok(200, branches);
  }

  if (head === 'commits' && tail.length === 0 && method === 'GET') {
    const refName = req.query.get('sha') ?? repo.defaultBranch;
    let tip = repo.refs.get(`refs/heads/${refName}`) ?? (forge.objects.has(refName) ? refName : null);
    if (tip === null) return ok(200, []);
    const peeled = peelToCommit(forge.objects, tip);
    if (peeled === null) return ok(200, []);
    tip = peeled;
    const seen = new Set<string>();
    const list: Record<string, unknown>[] = [];
    const queue = [tip];
    while (queue.length > 0 && list.length < 500) {
      const sha = queue.shift() as string;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const json = commitJson(forge, sha);
      if (json === null) continue;
      list.push(json);
      const obj = forge.objects.get(sha);
      if (obj !== undefined) queue.push(...parseCommit(obj.data).parents);
    }
    const { page, headers } = paginate(list, req.query, `/api/v3/repos/${repo.owner}/${repo.name}/commits`, req.host);
    return ok(200, page, headers);
  }

  if (head === 'git' && tail[0] === 'refs' && method === 'POST' && tail.length === 1) {
    const body = req.body ?? {};
    const ref = typeof body.ref === 'string' ? body.ref : '';
    const sha = typeof body.sha === 'string' ? body.sha : '';
    if (!/^refs\/(heads|tags)\//.test(ref) || !forge.objects.has(sha)) return fail(422, 'Validation Failed');
    repo.refs.set(ref, sha);
    const obj = forge.objects.get(sha);
    return ok(201, { ref, node_id: nodeId('Ref', repo.id), url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${ref}`, object: { type: obj?.type ?? 'commit', sha } });
  }
  if (head === 'git' && tail[0] === 'ref' && method === 'GET') {
    const ref = tail.slice(1).join('/');
    const sha = repo.refs.get(ref);
    if (sha === undefined) return fail(404, 'Not Found');
    const obj = forge.objects.get(sha);
    return ok(200, { ref, node_id: nodeId('Ref', repo.id), object: { type: obj?.type ?? 'commit', sha } });
  }

  if (head === 'contents') {
    return handleContents(forge, repo, tail.join('/'), req);
  }

  if (head === 'labels') {
    if (tail.length === 0 && method === 'POST') {
      const body = req.body ?? {};
      const labelName = typeof body.name === 'string' ? body.name : '';
      if (labelName === '') return fail(422, 'Validation Failed');
      if (!repo.labels.has(labelName)) {
        repo.labels.set(labelName, {
          id: forge.nextLabelId(),
          name: labelName,
          color: typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed',
          description: typeof body.description === 'string' ? body.description : null,
        });
      }
      return ok(201, labelJson(forge, repo, labelName) as Record<string, unknown>);
    }
    if (tail.length === 0 && method === 'GET') {
      return ok(200, [...repo.labels.keys()].map((n) => labelJson(forge, repo, n)).filter((x) => x !== null));
    }
    return fail(404, 'Not Found');
  }

  if (head === 'issues') return handleIssues(forge, repo, tail, req);
  if (head === 'pulls') return handlePulls(forge, repo, tail, req);

  return fail(404, 'Not Found');
}

function handleContents(forge: Forge, repo: RepoRec, path: string, req: RestRequest): RestResult {
  const method = req.method;
  const body = req.body ?? {};
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : (req.query.get('ref') ?? repo.defaultBranch);

  if (method === 'GET') {
    const ref = req.query.get('ref') ?? repo.defaultBranch;
    let tip = repo.refs.get(`refs/heads/${ref}`) ?? null;
    if (tip === null && forge.objects.has(ref)) tip = ref;
    if (tip === null) return fail(404, 'Not Found');
    const commitSha = peelToCommit(forge.objects, tip);
    if (commitSha === null) return fail(404, 'Not Found');
    const commitObj = forge.objects.get(commitSha);
    if (commitObj === undefined) return fail(404, 'Not Found');
    const rootTree = parseCommit(commitObj.data).tree;
    if (path === '') {
      return ok(200, treeListing(forge, repo, rootTree, ''));
    }
    // Walk to the path.
    const parts = path.split('/');
    let current = rootTree;
    for (let i = 0; i < parts.length; i += 1) {
      const treeObj = forge.objects.get(current);
      if (treeObj === undefined || treeObj.type !== 'tree') return fail(404, 'Not Found');
      const entry = parseTree(treeObj.data).find((e) => e.name === parts[i]);
      if (entry === undefined) return fail(404, 'Not Found');
      if (i === parts.length - 1) {
        if (entry.mode === '40000') return ok(200, treeListing(forge, repo, entry.sha, path));
        const blob = forge.objects.get(entry.sha);
        if (blob === undefined) return fail(404, 'Not Found');
        return ok(200, {
          type: 'file',
          encoding: 'base64',
          size: blob.data.length,
          name: entry.name,
          path,
          sha: entry.sha,
          content: blob.data.toString('base64'),
        });
      }
      if (entry.mode !== '40000') return fail(404, 'Not Found');
      current = entry.sha;
    }
    return fail(404, 'Not Found');
  }

  if (method === 'PUT') {
    const message = typeof body.message === 'string' ? body.message : '';
    const contentB64 = typeof body.content === 'string' ? body.content : null;
    if (contentB64 === null) return fail(422, 'Validation Failed');
    const data = Buffer.from(contentB64, 'base64');
    const blobSha = forge.objects.write('blob', data);
    const { flat } = branchFlat(forge, repo, branch);
    const existing = flat.get(path);
    const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
    if (existing !== undefined) {
      if (givenSha === undefined) return fail(422, 'Validation Failed: sha was not supplied');
      if (givenSha !== existing.sha) return fail(409, 'Conflict: sha does not match');
    } else if (givenSha !== undefined) {
      return fail(422, 'Validation Failed: sha supplied for a file that does not exist');
    }
    flat.set(path, { mode: '100644', sha: blobSha });
    const commitSha = commitFlat(forge, repo, branch, flat, message);
    const created = existing === undefined;
    return ok(created ? 201 : 200, {
      content: { type: 'file', encoding: 'base64', size: data.length, name: path.split('/').pop(), path, sha: blobSha },
      commit: { sha: commitSha },
    });
  }

  if (method === 'DELETE') {
    const message = typeof body.message === 'string' ? body.message : '';
    const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
    const { flat } = branchFlat(forge, repo, branch);
    const existing = flat.get(path);
    if (existing === undefined) return fail(404, 'Not Found');
    if (givenSha !== undefined && givenSha !== existing.sha) return fail(409, 'Conflict: sha does not match');
    flat.delete(path);
    const commitSha = commitFlat(forge, repo, branch, flat, message);
    return ok(200, { content: null, commit: { sha: commitSha } });
  }

  return fail(404, 'Not Found');
}

function treeListing(forge: Forge, repo: RepoRec, treeSha: string, prefix: string): Record<string, unknown>[] {
  const obj = forge.objects.get(treeSha);
  if (obj === undefined || obj.type !== 'tree') return [];
  return parseTree(obj.data).map((entry) => {
    const isDir = entry.mode === '40000';
    const blob = isDir ? undefined : forge.objects.get(entry.sha);
    return {
      type: isDir ? 'dir' : 'file',
      size: isDir ? 0 : blob?.data.length ?? 0,
      name: entry.name,
      path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
      sha: entry.sha,
    };
  });
}

function handleIssues(forge: Forge, repo: RepoRec, tail: string[], req: RestRequest): RestResult {
  const method = req.method;
  const body = req.body ?? {};

  if (tail.length === 0) {
    if (method === 'POST') {
      const title = typeof body.title === 'string' ? body.title : '';
      if (title === '') return fail(422, 'Validation Failed');
      const labels = Array.isArray(body.labels) ? body.labels.filter((x): x is string => typeof x === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return fail(422, `Validation Failed: label "${label}" does not exist`);
      }
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const issue: IssueRec = {
        number,
        title,
        body: typeof body.body === 'string' ? body.body : '',
        state: 'open',
        labels,
        comments: [],
        authorLogin: VIEWER.login,
        tick: forge.tick(),
      };
      repo.issues.set(number, issue);
      return ok(201, issueJson(forge, repo, issue));
    }
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const sort = req.query.get('sort') ?? 'created';
      const direction = req.query.get('direction') ?? 'desc';
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((i) => i.state === 'open');
      else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
      void sort;
      list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const items = list.map((i) => issueJson(forge, repo, i));
      const { page, headers } = paginate(items, req.query, `/api/v3/repos/${repo.owner}/${repo.name}/issues`, req.host);
      return ok(200, page, headers);
    }
    return fail(404, 'Not Found');
  }

  const number = Number(tail[0]);
  const issue = Number.isSafeInteger(number) ? repo.issues.get(number) : undefined;

  if (tail.length === 1) {
    if (issue === undefined) return fail(404, 'Not Found');
    if (method === 'GET') return ok(200, issueJson(forge, repo, issue));
    if (method === 'PATCH') {
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (Array.isArray(body.labels)) {
        const labels = body.labels.filter((x): x is string => typeof x === 'string');
        for (const label of labels) if (!repo.labels.has(label)) return fail(422, `Validation Failed: label "${label}" does not exist`);
        issue.labels = labels;
      }
      return ok(200, issueJson(forge, repo, issue));
    }
    return fail(404, 'Not Found');
  }

  if (tail.length === 2 && tail[1] === 'comments') {
    if (issue === undefined) return fail(404, 'Not Found');
    if (method === 'POST') {
      const text = typeof body.body === 'string' ? body.body : '';
      if (text === '') return fail(422, 'Validation Failed');
      const comment = { id: forge.nextCommentId(), body: text, authorLogin: VIEWER.login, tick: forge.tick() };
      issue.comments.push(comment);
      return ok(201, commentJson(forge, repo, issue, comment));
    }
    if (method === 'GET') {
      return ok(200, issue.comments.map((c) => commentJson(forge, repo, issue, c)));
    }
  }
  return fail(404, 'Not Found');
}

function commentJson(forge: Forge, repo: RepoRec, issue: IssueRec, comment: { id: number; body: string; authorLogin: string; tick: number }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: nodeId('IssueComment', comment.id),
    body: comment.body,
    user: userJson(comment.authorLogin),
    created_at: forge.isoOf(comment.tick),
    updated_at: forge.isoOf(comment.tick),
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
  };
}

// ----------------------------------------------------------------------------------------------
// Pull requests
// ----------------------------------------------------------------------------------------------

export interface PullDiff {
  files: { filename: string; status: string; additions: number; deletions: number; changes: number; sha: string }[];
  mergedFlat: Map<string, { mode: string; sha: string }> | null;
  conflict: boolean;
  baseTip: string;
  headTip: string;
  base: string | null;
}

/** Three-way view of a pull: files changed head-side, and the merged flat map (or a conflict). */
export function computePullDiff(forge: Forge, repo: RepoRec, pull: PullRec): PullDiff | null {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return null;
  const headCommit = peelToCommit(forge.objects, headTip);
  const baseCommit = peelToCommit(forge.objects, baseTip);
  if (headCommit === null || baseCommit === null) return null;
  const base = mergeBase(forge.objects, baseCommit, headCommit);
  const flatOf = (commitSha: string): Map<string, { mode: string; sha: string }> => {
    const obj = forge.objects.get(commitSha);
    if (obj === undefined) return new Map();
    return flattenTree(forge.objects, parseCommit(obj.data).tree);
  };
  const baseFlat = flatOf(baseCommit);
  const headFlat = flatOf(headCommit);
  const originFlat = base === null ? new Map<string, { mode: string; sha: string }>() : flatOf(base);

  const changed = (from: Map<string, { mode: string; sha: string }>, to: Map<string, { mode: string; sha: string }>): Map<string, { sha: string } | null> => {
    const out = new Map<string, { sha: string } | null>();
    for (const [path, info] of to) {
      const before = from.get(path);
      if (before === undefined) out.set(path, info);
      else if (before.sha !== info.sha) out.set(path, info);
    }
    for (const path of from.keys()) if (!to.has(path)) out.set(path, null);
    return out;
  };
  const headChanges = changed(originFlat, headFlat);
  const baseChanges = changed(originFlat, baseFlat);

  const files: PullDiff['files'] = [];
  for (const [path, info] of headChanges) {
    const before = originFlat.get(path);
    const oldText = before === undefined ? '' : forge.objects.get(before.sha)?.data.toString('utf8') ?? '';
    const newText = info === null ? '' : forge.objects.get(info.sha)?.data.toString('utf8') ?? '';
    const { additions, deletions } = lineDiff(oldText, newText);
    files.push({
      filename: path,
      status: before === undefined ? 'added' : info === null ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      sha: info?.sha ?? before?.sha ?? '',
    });
  }
  files.sort((a, b) => a.filename.localeCompare(b.filename));

  let conflict = false;
  const mergedFlat = new Map(baseFlat);
  for (const [path, info] of headChanges) {
    const baseChange = baseChanges.get(path);
    if (baseChanges.has(path)) {
      const baseResult = baseChange === undefined ? null : baseChange;
      const same = (baseResult?.sha ?? null) === (info?.sha ?? null);
      if (!same) conflict = true;
    }
    if (info === null) mergedFlat.delete(path);
    else mergedFlat.set(path, { mode: headFlat.get(path)?.mode ?? '100644', sha: info.sha });
  }

  return { files, mergedFlat: conflict ? null : mergedFlat, conflict, baseTip, headTip, base };
}

function handlePulls(forge: Forge, repo: RepoRec, tail: string[], req: RestRequest): RestResult {
  const method = req.method;
  const body = req.body ?? {};

  if (tail.length === 0) {
    if (method === 'POST') {
      const title = typeof body.title === 'string' ? body.title : '';
      const head = typeof body.head === 'string' ? body.head : '';
      const base = typeof body.base === 'string' ? body.base : '';
      const headBranch = head.includes(':') ? (head.split(':').pop() as string) : head;
      if (title === '' || headBranch === '' || base === '') return fail(422, 'Validation Failed');
      if (!repo.refs.has(`refs/heads/${headBranch}`)) return fail(422, `Validation Failed: head branch "${headBranch}" does not exist`);
      if (!repo.refs.has(`refs/heads/${base}`)) return fail(422, `Validation Failed: base branch "${base}" does not exist`);
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const pull: PullRec = {
        number,
        title,
        body: typeof body.body === 'string' ? body.body : '',
        state: 'open',
        merged: false,
        headRef: headBranch,
        baseRef: base,
        mergeCommitSha: null,
        authorLogin: VIEWER.login,
        tick: forge.tick(),
        mergedTick: null,
        comments: [],
      };
      repo.pulls.set(number, pull);
      return ok(201, pullJson(forge, repo, pull));
    }
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state === 'open') list = list.filter((p) => p.state === 'open');
      else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
      list.sort((a, b) => b.number - a.number);
      const items = list.map((p) => pullJson(forge, repo, p));
      const { page, headers } = paginate(items, req.query, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`, req.host);
      return ok(200, page, headers);
    }
    return fail(404, 'Not Found');
  }

  const number = Number(tail[0]);
  const pull = Number.isSafeInteger(number) ? repo.pulls.get(number) : undefined;
  if (pull === undefined) return fail(404, 'Not Found');

  if (tail.length === 1) {
    if (method === 'GET') return ok(200, pullJson(forge, repo, pull));
    if (method === 'PATCH') {
      if (typeof body.title === 'string') pull.title = body.title;
      if (typeof body.body === 'string') pull.body = body.body;
      if (body.state === 'open' || body.state === 'closed') pull.state = body.state;
      return ok(200, pullJson(forge, repo, pull));
    }
    return fail(404, 'Not Found');
  }

  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    const diff = computePullDiff(forge, repo, pull);
    if (diff === null) return fail(404, 'Not Found');
    return ok(200, diff.files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes, sha: f.sha })));
  }

  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    if (pull.merged) return fail(405, 'Pull Request is already merged');
    if (pull.state === 'closed') return fail(405, 'Pull Request is closed');
    const diff = computePullDiff(forge, repo, pull);
    if (diff === null) return fail(404, 'Not Found');
    if (diff.conflict || diff.mergedFlat === null) return fail(405, 'Pull Request is not mergeable: conflict');
    const mergeMethod = typeof body.merge_method === 'string' ? body.merge_method : 'merge';
    const tree = buildTreeFromFlat(forge.objects, diff.mergedFlat);
    const tick = forge.tick();
    const line = forge.authorLine(tick);
    let sha: string;
    if (mergeMethod === 'squash') {
      const message = typeof body.commit_title === 'string' && body.commit_title !== '' ? body.commit_title : `${pull.title} (#${pull.number})`;
      sha = forge.objects.write('commit', writeCommit({ tree, parents: [diff.baseTip], authorLine: line, committerLine: line, message }));
    } else {
      const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
      sha = forge.objects.write('commit', writeCommit({ tree, parents: [diff.baseTip, diff.headTip], authorLine: line, committerLine: line, message }));
    }
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeCommitSha = sha;
    pull.mergedTick = tick;
    return ok(200, { sha, merged: true, message: mergeMethod === 'squash' ? 'Pull Request successfully merged and squashed.' : 'Pull Request successfully merged.' });
  }

  return fail(404, 'Not Found');
}

export { objectId, isAncestor };
