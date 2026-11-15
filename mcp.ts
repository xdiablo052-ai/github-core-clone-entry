// MCP over streamable HTTP: JSON-RPC 2.0 with the 2026-07-28 discover flow (and the older
// initialize handshake). The tools act on the same store as REST and return the REST-shaped
// objects both as text content and as structuredContent, so ids agree across surfaces.

import { computePullDiff, issueJson, pullJson, repoJson } from './rest.ts';
import { buildTreeFromFlat, writeCommit } from './git.ts';
import { VIEWER, type Forge, type IssueRec, type PullRec } from './store.ts';

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];

interface ToolDef {
  name: string;
  description: string;
  required: string[];
  properties: Record<string, { type: string; description: string }>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    required: ['name'],
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      owner: { type: 'string', description: 'The account the repository belongs to (defaults to the token owner).' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    required: ['owner', 'repo'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      full_name: { type: 'string', description: 'The owner/repo pair, when given instead of owner and repo.' },
    },
  },
  {
    name: 'create_issue',
    description: 'Open an issue in a repository.',
    required: ['owner', 'repo', 'title'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body text.' },
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    required: ['owner', 'repo'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'open, closed or all (default open).' },
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    required: ['owner', 'repo', 'title', 'head', 'base'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body text.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash), closing it and landing its changes on the base branch.',
    required: ['owner', 'repo', 'pull_number'],
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
    },
  },
];

const TOOLS_JSON = JSON.stringify({
  tools: TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: tool.properties,
      required: tool.required,
      additionalProperties: true,
    },
  })),
});

export interface McpResult {
  status: number;
  body: string;
  contentType: string;
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function toolResult(payload: unknown, isError = false): Record<string, unknown> {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const out: Record<string, unknown> = { content: [{ type: 'text', text }], isError };
  if (!isError && payload !== null && typeof payload === 'object') out.structuredContent = payload;
  return out;
}

function argError(message: string): Record<string, unknown> {
  return toolResult(message, true);
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function ownerRepo(args: Record<string, unknown>): { owner: string; repo: string } | null {
  let owner = str(args, 'owner');
  let repo = str(args, 'repo') ?? str(args, 'name') ?? undefined;
  const fullName = str(args, 'full_name');
  if ((owner === undefined || repo === undefined) && fullName !== undefined && fullName.includes('/')) {
    const [o, r] = fullName.split('/', 2);
    owner = owner ?? o;
    repo = repo ?? r;
  }
  if (owner === undefined || repo === undefined) return null;
  return { owner, repo };
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> | { rpcError: [number, string] } {
  const canonical = name.toLowerCase();
  const tool = TOOLS.find((t) => canonical === t.name || canonical.endsWith(`__${t.name}`) || canonical.endsWith(t.name));
  if (tool === undefined) return { rpcError: [-32602, `Unknown tool: ${name}`] };

  switch (tool.name) {
    case 'create_repo': {
      const repoName = str(args, 'name') ?? str(args, 'repo');
      if (repoName === undefined) return argError('create_repo requires a name');
      const owner = str(args, 'owner') ?? VIEWER.login;
      const existing = forge.getRepo(owner, repoName);
      if (existing !== undefined) return toolResult(repoJson(forge, existing));
      const repo = forge.createRepo(owner, repoName, {
        private: args.private === true,
        description: str(args, 'description') ?? '',
      });
      return toolResult(repoJson(forge, repo));
    }
    case 'get_repo': {
      const target = ownerRepo(args);
      if (target === null) return argError('get_repo requires owner and repo');
      const repo = forge.getRepo(target.owner, target.repo);
      if (repo === undefined) return argError(`repository ${target.owner}/${target.repo} not found`);
      return toolResult(repoJson(forge, repo));
    }
    case 'create_issue': {
      const target = ownerRepo(args);
      const title = str(args, 'title');
      if (target === null || title === undefined) return argError('create_issue requires owner, repo and title');
      const repo = forge.getRepo(target.owner, target.repo);
      if (repo === undefined) return argError(`repository ${target.owner}/${target.repo} not found`);
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const issue: IssueRec = {
        number,
        title,
        body: str(args, 'body') ?? '',
        state: 'open',
        labels: [],
        comments: [],
        authorLogin: VIEWER.login,
        tick: forge.tick(),
      };
      repo.issues.set(number, issue);
      return toolResult(issueJson(forge, repo, issue));
    }
    case 'list_issues': {
      const target = ownerRepo(args);
      if (target === null) return argError('list_issues requires owner and repo');
      const repo = forge.getRepo(target.owner, target.repo);
      if (repo === undefined) return argError(`repository ${target.owner}/${target.repo} not found`);
      const state = str(args, 'state') ?? 'open';
      let list = [...repo.issues.values()];
      if (state === 'open') list = list.filter((i) => i.state === 'open');
      else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
      list.sort((a, b) => a.number - b.number);
      return toolResult(list.map((i) => issueJson(forge, repo, i)));
    }
    case 'create_pull_request': {
      const target = ownerRepo(args);
      const title = str(args, 'title');
      const head = str(args, 'head');
      const base = str(args, 'base');
      if (target === null || title === undefined || head === undefined || base === undefined) {
        return argError('create_pull_request requires owner, repo, title, head and base');
      }
      const repo = forge.getRepo(target.owner, target.repo);
      if (repo === undefined) return argError(`repository ${target.owner}/${target.repo} not found`);
      const headBranch = head.includes(':') ? (head.split(':').pop() as string) : head;
      if (!repo.refs.has(`refs/heads/${headBranch}`) || !repo.refs.has(`refs/heads/${base}`)) {
        return argError('head or base branch does not exist');
      }
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const pull: PullRec = {
        number,
        title,
        body: str(args, 'body') ?? '',
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
      return toolResult(pullJson(forge, repo, pull));
    }
    case 'merge_pull_request': {
      const target = ownerRepo(args);
      const number = typeof args.pull_number === 'number' ? args.pull_number : typeof args.number === 'number' ? args.number : undefined;
      if (target === null || number === undefined) return argError('merge_pull_request requires owner, repo and pull_number');
      const repo = forge.getRepo(target.owner, target.repo);
      if (repo === undefined) return argError(`repository ${target.owner}/${target.repo} not found`);
      const pull = repo.pulls.get(number);
      if (pull === undefined) return argError(`pull request ${number} not found`);
      const diff = computePullDiff(forge, repo, pull);
      if (diff === null || diff.conflict || diff.mergedFlat === null) return argError('pull request is not mergeable');
      const tree = buildTreeFromFlat(forge.objects, diff.mergedFlat);
      const tick = forge.tick();
      const line = forge.authorLine(tick);
      const sha = forge.objects.write('commit', writeCommit({ tree, parents: [diff.baseTip], authorLine: line, committerLine: line, message: `${pull.title} (#${pull.number})` }));
      repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergeCommitSha = sha;
      pull.mergedTick = tick;
      return toolResult(pullJson(forge, repo, pull));
    }
    default:
      return { rpcError: [-32602, `Unknown tool: ${name}`] };
  }
}

function handleOne(forge: Forge, message: Record<string, unknown>): Record<string, unknown> | null {
  const method = typeof message.method === 'string' ? message.method : '';
  const id = message.id;
  const isNotification = id === undefined || id === null;
  const params = (message.params ?? {}) as Record<string, unknown>;

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        protocolVersion: '2026-07-28',
        serverInfo: SERVER_INFO,
        capabilities: { tools: { listChanged: false } },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25',
        serverInfo: SERVER_INFO,
        capabilities: { tools: { listChanged: false } },
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, JSON.parse(TOOLS_JSON) as unknown);
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const outcome = callTool(forge, name, args);
      if ('rpcError' in outcome) {
        const [code, text] = outcome.rpcError as [number, string];
        return rpcError(id, code, text);
      }
      return rpcResult(id, outcome);
    }
    case 'resources/list':
      return rpcResult(id, { resources: [] });
    case 'prompts/list':
      return rpcResult(id, { prompts: [] });
    default:
      if (isNotification || method.startsWith('notifications/')) return null;
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export function handleMcp(forge: Forge, rawBody: Buffer): McpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return {
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify(rpcError(null, -32700, 'Parse error: body is not JSON')),
    };
  }
  if (Array.isArray(parsed)) {
    const answers = parsed
      .map((entry) => handleOne(forge, (entry ?? {}) as Record<string, unknown>))
      .filter((x) => x !== null);
    return { status: 200, contentType: 'application/json', body: JSON.stringify(answers) };
  }
  const answer = handleOne(forge, (parsed ?? {}) as Record<string, unknown>);
  if (answer === null) return { status: 202, contentType: 'application/json', body: '' };
  return { status: 200, contentType: 'application/json', body: JSON.stringify(answer) };
}
