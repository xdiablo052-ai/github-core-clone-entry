// GraphQL v4: a small parser and executor covering the documents gh and github-mcp-server send —
// viewer, repository reads, issue/pull connections with cursor paging, the five mutations, node
// lookups, inline fragments, and __type introspection for Issue, PullRequest, Repository and
// the SearchType enum. Unknown fields answer HTTP 200 with an errors array naming the field.

import { computePullDiff } from './rest.ts';
import { buildTreeFromFlat, writeCommit } from './git.ts';
import {
  VIEWER,
  issueNodeId,
  nodeId,
  parseNodeId,
  pullNodeId,
  userByLogin,
  type Forge,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';

// ----------------------------------------------------------------------------------------------
// Parser
// ----------------------------------------------------------------------------------------------

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'str'; value: string }
  | { kind: 'num'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: [string, Value][] };

interface FieldNode {
  alias: string | null;
  name: string;
  args: [string, Value][];
  selection: FieldNode[] | null;
  fragmentSpread: string | null;
  inlineOn: string | null;
}

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selection: FieldNode[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, { on: string; selection: FieldNode[] }>;
}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(ch)) {
      i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}()[]:=@$!'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push(`str:${source.slice(i + 3, end < 0 ? source.length : end)}`);
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push(`str:${out}`);
      i = j + 1;
      continue;
    }
    const match = /^[A-Za-z0-9_.-]+/.exec(source.slice(i));
    if (match !== null) {
      tokens.push(match[0]);
      i += match[0].length;
      continue;
    }
    i += 1;
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: string[];

  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  peek(): string | undefined {
    return this.tokens[this.pos];
  }

  next(): string {
    const token = this.tokens[this.pos] as string;
    this.pos += 1;
    return token;
  }

  expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token}, got ${got}`);
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, { on: string; selection: FieldNode[] }>();
    while (this.pos < this.tokens.length) {
      const head = this.peek() as string;
      if (head === 'query' || head === 'mutation' || head === 'subscription') {
        this.next();
        let name: string | null = null;
        if (this.peek() !== undefined && this.peek() !== '(' && this.peek() !== '{') name = this.next();
        if (this.peek() === '(') this.skipParens();
        // Directives on the operation.
        while (this.peek() === '@') {
          this.next();
          this.next();
          if (this.peek() === '(') this.skipParens();
        }
        const selection = this.parseSelectionSet();
        operations.push({ type: head === 'mutation' ? 'mutation' : 'query', name, selection });
      } else if (head === 'fragment') {
        this.next();
        const fragName = this.next();
        this.expect('on');
        const on = this.next();
        const selection = this.parseSelectionSet();
        fragments.set(fragName, { on, selection });
      } else if (head === '{') {
        operations.push({ type: 'query', name: null, selection: this.parseSelectionSet() });
      } else {
        this.next();
      }
    }
    return { operations, fragments };
  }

  private skipParens(): void {
    let depth = 0;
    do {
      const token = this.next();
      if (token === '(') depth += 1;
      else if (token === ')') depth -= 1;
    } while (depth > 0 && this.pos < this.tokens.length);
  }

  private parseSelectionSet(): FieldNode[] {
    this.expect('{');
    const fields: FieldNode[] = [];
    while (this.peek() !== '}' && this.peek() !== undefined) {
      fields.push(this.parseField());
    }
    this.expect('}');
    return fields;
  }

  private parseField(): FieldNode {
    if (this.peek() === '...') {
      this.next();
      if (this.peek() === 'on') {
        this.next();
        const on = this.next();
        const selection = this.parseSelectionSet();
        return { alias: null, name: '', args: [], selection, fragmentSpread: null, inlineOn: on };
      }
      const spread = this.next();
      return { alias: null, name: '', args: [], selection: null, fragmentSpread: spread, inlineOn: null };
    }
    let name = this.next();
    let alias: string | null = null;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: [string, Value][] = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')' && this.peek() !== undefined) {
        const argName = this.next();
        this.expect(':');
        args.push([argName, this.parseValue()]);
      }
      this.expect(')');
    }
    // Directives.
    while (this.peek() === '@') {
      this.next();
      this.next();
      if (this.peek() === '(') this.skipParens();
    }
    const selection = this.peek() === '{' ? this.parseSelectionSet() : null;
    return { alias, name, args, selection, fragmentSpread: null, inlineOn: null };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token === '$') return { kind: 'var', name: this.next() };
    if (token.startsWith('str:')) return { kind: 'str', value: token.slice(4) };
    if (token === '[') {
      const items: Value[] = [];
      while (this.peek() !== ']' && this.peek() !== undefined) items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields: [string, Value][] = [];
      while (this.peek() !== '}' && this.peek() !== undefined) {
        const key = this.next();
        this.expect(':');
        fields.push([key, this.parseValue()]);
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (/^-?\d+$/.test(token)) return { kind: 'num', value: Number(token) };
    if (/^-?\d*\.\d+$/.test(token)) return { kind: 'num', value: Number(token) };
    if (token === 'true') return { kind: 'bool', value: true };
    if (token === 'false') return { kind: 'bool', value: false };
    if (token === 'null') return { kind: 'null' };
    return { kind: 'enum', value: token };
  }
}

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var':
      return variables[value.name];
    case 'str':
    case 'num':
    case 'bool':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of value.fields) out[k] = resolveValue(v, variables);
      return out;
    }
  }
}

// ----------------------------------------------------------------------------------------------
// Schema (the parts the documents touch, plus introspection data)
// ----------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'user', 'organization', 'search', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'reopenIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue', 'createLabel'],
  User: ['id', 'login', 'name', 'email', 'url', 'databaseId', 'isViewer'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'hasPullRequestsEnabled', 'description', 'isPrivate', 'isFork', 'url',
    'createdAt', 'updatedAt', 'issue', 'issues', 'pullRequest', 'pullRequests', 'label', 'labels',
    'ref', 'refs', 'stargazerCount', 'forkCount',
  ],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'state', 'body', 'bodyText', 'author', 'repository',
    'labels', 'comments', 'createdAt', 'updatedAt', 'closedAt', 'closed', 'url', 'assignees',
    'participants', 'reactions', 'milestone',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeable',
    'headRefName', 'baseRefName', 'headRef', 'baseRef', 'headRepository', 'baseRepository',
    'repository', 'author', 'files', 'commits', 'comments', 'createdAt', 'updatedAt', 'closedAt',
    'closed', 'url', 'mergeCommit', 'additions', 'deletions', 'changedFiles', 'isDraft', 'labels',
    'reviewRequests', 'reviews',
  ],
  Ref: ['id', 'name', 'prefix', 'target', 'repository'],
  IssueComment: ['id', 'databaseId', 'body', 'bodyText', 'author', 'createdAt', 'updatedAt', 'url', 'issue'],
  Label: ['id', 'name', 'color', 'description', 'url'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  RepositoryIssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  RepositoryPullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  Commit: ['id', 'oid', 'message', 'messageHeadline', 'author', 'committedDate', 'tree'],
  CreateIssuePayload: ['clientMutationId', 'issue'],
  CloseIssuePayload: ['clientMutationId', 'issue'],
  CreatePullRequestPayload: ['clientMutationId', 'pullRequest'],
  MergePullRequestPayload: ['clientMutationId', 'pullRequest'],
  AddCommentPayload: ['clientMutationId', 'commentEdge', 'subject'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestFileEdge: ['node', 'cursor'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  FileChangeType: ['ADDED', 'MODIFIED', 'DELETED', 'RENAMED', 'COPIED', 'CHANGED'],
};

const TYPE_KINDS: Record<string, string> = {
  SearchType: 'ENUM',
  IssueState: 'ENUM',
  PullRequestState: 'ENUM',
  MergeableState: 'ENUM',
  PullRequestMergeMethod: 'ENUM',
  IssueOrderField: 'ENUM',
  OrderDirection: 'ENUM',
  FileChangeType: 'ENUM',
};

// ----------------------------------------------------------------------------------------------
// Execution
// ----------------------------------------------------------------------------------------------

interface Ctx {
  forge: Forge;
  errors: { message: string }[];
}

type Val = Record<string, unknown> & { __type: string };

function val(type: string, fields: Record<string, unknown>): Val {
  return { __type: type, ...fields };
}

function userVal(login: string): Val {
  const user = userByLogin(login) ?? VIEWER;
  return val('User', {
    id: nodeId('User', user.id),
    databaseId: user.id,
    login: user.login,
    name: user.name,
    email: user.email,
    isViewer: user.login === VIEWER.login,
    url: `/api/v3/users/${user.login}`,
  });
}

function repoVal(ctx: Ctx, repo: RepoRec): Val {
  const forge = ctx.forge;
  const headSha = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  return val('Repository', {
    __repo: repo,
    id: nodeId('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    description: repo.description,
    isPrivate: repo.private,
    isFork: false,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    hasPullRequestsEnabled: true,
    createdAt: forge.isoOf(repo.tick),
    updatedAt: forge.isoOf(repo.tick),
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    stargazerCount: 0,
    forkCount: 0,
  });
}

function issueVal(ctx: Ctx, repo: RepoRec, issue: IssueRec): Val {
  const forge = ctx.forge;
  return val('Issue', {
    __repo: repo,
    __issue: issue,
    id: issueNodeId(repo.id, issue.number),
    databaseId: repo.id * 1_000_000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    bodyText: issue.body,
    state: issue.state.toUpperCase(),
    closed: issue.state === 'closed',
    createdAt: forge.isoOf(issue.tick),
    updatedAt: forge.isoOf(issue.tick),
    closedAt: issue.state === 'closed' ? forge.isoOf(issue.tick) : null,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  });
}

function pullMergeable(ctx: Ctx, repo: RepoRec, pull: PullRec): string {
  if (pull.merged || pull.state === 'closed') return 'UNKNOWN';
  const diff = computePullDiff(ctx.forge, repo, pull);
  if (diff === null) return 'UNKNOWN';
  return diff.conflict ? 'CONFLICTING' : 'MERGEABLE';
}

function pullVal(ctx: Ctx, repo: RepoRec, pull: PullRec): Val {
  const forge = ctx.forge;
  return val('PullRequest', {
    __repo: repo,
    __pull: pull,
    id: pullNodeId(repo.id, pull.number),
    databaseId: repo.id * 1_000_000 + pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state.toUpperCase(),
    merged: pull.merged,
    mergedAt: pull.merged ? forge.isoOf(pull.mergedTick ?? pull.tick) : null,
    closed: pull.state === 'closed',
    closedAt: pull.state === 'closed' ? forge.isoOf(pull.mergedTick ?? pull.tick) : null,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    isDraft: false,
    createdAt: forge.isoOf(pull.tick),
    updatedAt: forge.isoOf(pull.tick),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pull/${pull.number}`,
  });
}

function commentVal(ctx: Ctx, repo: RepoRec, comment: { id: number; body: string; authorLogin: string; tick: number }): Val {
  return val('IssueComment', {
    __repo: repo,
    id: nodeId('IssueComment', comment.id),
    databaseId: comment.id,
    body: comment.body,
    bodyText: comment.body,
    createdAt: ctx.forge.isoOf(comment.tick),
    updatedAt: ctx.forge.isoOf(comment.tick),
    __authorLogin: comment.authorLogin,
  });
}

function cursorOf(n: number): string {
  return Buffer.from(`cursor:${n}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

interface Connection {
  items: Val[];
  totalCount: number;
}

function pageConnection(items: Val[], first: number | undefined, after: string | undefined, keyOf: (v: Val) => number): Connection & { endCursor: string | null; hasNextPage: boolean } {
  let start = 0;
  if (after !== undefined && after !== null) {
    const n = numberFromCursor(after);
    if (n !== null) {
      const idx = items.findIndex((v) => keyOf(v) === n);
      if (idx >= 0) start = idx + 1;
    }
  }
  const limit = first === undefined ? items.length : Math.max(0, first);
  const slice = items.slice(start, start + limit);
  return {
    items: slice,
    totalCount: items.length,
    endCursor: slice.length > 0 ? cursorOf(keyOf(slice[slice.length - 1] as Val)) : null,
    hasNextPage: start + slice.length < items.length,
  };
}

function connectionVal(type: string, page: ReturnType<typeof pageConnection>, keyOf: (v: Val) => number): Val {
  return val(type, {
    __items: page.items,
    __keyOf: keyOf,
    totalCount: page.totalCount,
    __pageInfo: { hasNextPage: page.hasNextPage, hasPreviousPage: false, startCursor: page.items.length ? cursorOf(keyOf(page.items[0] as Val)) : null, endCursor: page.endCursor },
  });
}

// Field resolution. Returns a raw value (scalar, Val, array, or null).
function resolveField(ctx: Ctx, parent: Val | null, field: string, args: Record<string, unknown>): unknown {
  const forge = ctx.forge;
  const type = parent === null ? 'Query' : parent.__type;

  if (field === '__type') {
    const name = String(args.name ?? '');
    return typeVal(name);
  }
  if (field === '__schema') return schemaVal();

  if (type === 'Query' || type === 'Mutation') {
    switch (field) {
      case 'viewer':
        return userVal(VIEWER.login);
      case 'repository': {
        const repo = forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo === undefined ? null : repoVal(ctx, repo);
      }
      case 'user': {
        const login = String(args.login ?? '');
        return userByLogin(login) === undefined ? null : userVal(login);
      }
      case 'node': {
        return nodeLookup(ctx, String(args.id ?? ''));
      }
      case 'createIssue': {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = repoFromNodeId(ctx, String(input.repositoryId ?? ''));
        if (repo === null) return null;
        const number = repo.nextNumber;
        repo.nextNumber += 1;
        const issue: IssueRec = {
          number,
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          labels: [],
          comments: [],
          authorLogin: VIEWER.login,
          tick: forge.tick(),
        };
        repo.issues.set(number, issue);
        return val('CreateIssuePayload', { clientMutationId: input.clientMutationId ?? null, __issue: issueVal(ctx, repo, issue), __repo: repo });
      }
      case 'closeIssue': {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = issueFromNodeId(ctx, String(input.issueId ?? ''));
        if (found === null) return null;
        found.issue.state = 'closed';
        return val('CloseIssuePayload', { clientMutationId: input.clientMutationId ?? null, __issue: issueVal(ctx, found.repo, found.issue), __repo: found.repo });
      }
      case 'reopenIssue': {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = issueFromNodeId(ctx, String(input.issueId ?? ''));
        if (found === null) return null;
        found.issue.state = 'open';
        return val('CloseIssuePayload', { clientMutationId: input.clientMutationId ?? null, __issue: issueVal(ctx, found.repo, found.issue), __repo: found.repo });
      }
      case 'createPullRequest': {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = repoFromNodeId(ctx, String(input.repositoryId ?? ''));
        if (repo === null) return null;
        const head = String(input.headRefName ?? '');
        const base = String(input.baseRefName ?? '');
        if (!repo.refs.has(`refs/heads/${head}`) || !repo.refs.has(`refs/heads/${base}`)) return null;
        const number = repo.nextNumber;
        repo.nextNumber += 1;
        const pull: PullRec = {
          number,
          title: String(input.title ?? ''),
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          merged: false,
          headRef: head,
          baseRef: base,
          mergeCommitSha: null,
          authorLogin: VIEWER.login,
          tick: forge.tick(),
          mergedTick: null,
          comments: [],
        };
        repo.pulls.set(number, pull);
        return val('CreatePullRequestPayload', { clientMutationId: input.clientMutationId ?? null, __pull: pullVal(ctx, repo, pull), __repo: repo });
      }
      case 'mergePullRequest': {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = pullFromNodeId(ctx, String(input.pullRequestId ?? ''));
        if (found === null) return null;
        mergePull(ctx, found.repo, found.pull, String(input.mergeMethod ?? 'SQUASH'));
        return val('MergePullRequestPayload', { clientMutationId: input.clientMutationId ?? null, __pull: pullVal(ctx, found.repo, found.pull), __repo: found.repo });
      }
      case 'addComment': {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const subjectId = String(input.subjectId ?? '');
        const bodyText = String(input.body ?? '');
        const issueFound = issueFromNodeId(ctx, subjectId);
        if (issueFound !== null) {
          const comment = { id: forge.nextCommentId(), body: bodyText, authorLogin: VIEWER.login, tick: forge.tick() };
          issueFound.issue.comments.push(comment);
          const node = commentVal(ctx, issueFound.repo, comment);
          return val('AddCommentPayload', { clientMutationId: input.clientMutationId ?? null, __commentNode: node });
        }
        const pullFound = pullFromNodeId(ctx, subjectId);
        if (pullFound !== null) {
          const comment = { id: forge.nextCommentId(), body: bodyText, authorLogin: VIEWER.login, tick: forge.tick() };
          pullFound.pull.comments.push(comment);
          const node = commentVal(ctx, pullFound.repo, comment);
          return val('AddCommentPayload', { clientMutationId: input.clientMutationId ?? null, __commentNode: node });
        }
        return null;
      }
      default:
        return undefined;
    }
  }

  if (parent === null) return undefined;

  switch (type) {
    case 'User':
      return parent[field];
    case 'Repository': {
      const repo = parent.__repo as RepoRec;
      switch (field) {
        case 'owner':
          return userVal(repo.owner);
        case 'defaultBranchRef': {
          const sha = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          if (sha === undefined) return null;
          return val('Ref', { id: nodeId('Ref', repo.id), name: repo.defaultBranch, prefix: 'refs/heads/', __target: sha, __repo: repo });
        }
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return issue === undefined ? null : issueVal(ctx, repo, issue);
        }
        case 'issues': {
          let list = [...repo.issues.values()];
          const states = args.states as string[] | undefined;
          if (Array.isArray(states)) {
            const wanted = states.map((s) => s.toLowerCase());
            list = list.filter((i) => wanted.includes(i.state));
          }
          const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
          const asc = orderBy.direction === 'ASC';
          list.sort((a, b) => (asc ? a.number - b.number : b.number - a.number));
          const items = list.map((i) => issueVal(ctx, repo, i));
          const page = pageConnection(items, args.first as number | undefined, args.after as string | undefined, (v) => (v.__issue as IssueRec).number);
          return connectionVal('RepositoryIssueConnection', page, (v) => (v.__issue as IssueRec).number);
        }
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          return pull === undefined ? null : pullVal(ctx, repo, pull);
        }
        case 'pullRequests': {
          let list = [...repo.pulls.values()];
          const states = args.states as string[] | undefined;
          if (Array.isArray(states)) {
            list = list.filter((p) => states.includes(p.merged ? 'MERGED' : p.state.toUpperCase()));
          }
          list.sort((a, b) => b.number - a.number);
          const items = list.map((p) => pullVal(ctx, repo, p));
          const page = pageConnection(items, args.first as number | undefined, args.after as string | undefined, (v) => (v.__pull as PullRec).number);
          return connectionVal('RepositoryPullRequestConnection', page, (v) => (v.__pull as PullRec).number);
        }
        default:
          return parent[field];
      }
    }
    case 'Issue': {
      const repo = parent.__repo as RepoRec;
      const issue = parent.__issue as IssueRec;
      switch (field) {
        case 'author':
          return userVal(issue.authorLogin);
        case 'repository':
          return repoVal(ctx, repo);
        case 'labels': {
          const items = issue.labels
            .map((name) => repo.labels.get(name))
            .filter((l) => l !== undefined)
            .map((l) => val('Label', { id: nodeId('Label', (l as { id: number }).id), name: (l as { name: string }).name, color: (l as { color: string }).color, description: (l as { description: string | null }).description }));
          const page = pageConnection(items, args.first as number | undefined, undefined, () => 0);
          return connectionVal('IssueConnection', page, () => 0);
        }
        case 'comments': {
          const items = issue.comments.map((c) => commentVal(ctx, repo, c));
          const page = pageConnection(items, args.first as number | undefined, undefined, (v) => v.databaseId as number);
          return connectionVal('IssueConnection', page, (v) => v.databaseId as number);
        }
        default:
          return parent[field];
      }
    }
    case 'PullRequest': {
      const repo = parent.__repo as RepoRec;
      const pull = parent.__pull as PullRec;
      switch (field) {
        case 'author':
          return userVal(pull.authorLogin);
        case 'repository':
          return repoVal(ctx, repo);
        case 'mergeable':
          return pullMergeable(ctx, repo, pull);
        case 'headRef': {
          const sha = repo.refs.get(`refs/heads/${pull.headRef}`);
          return sha === undefined ? null : val('Ref', { id: nodeId('Ref', repo.id), name: pull.headRef, prefix: 'refs/heads/', __target: sha, __repo: repo });
        }
        case 'baseRef': {
          const sha = repo.refs.get(`refs/heads/${pull.baseRef}`);
          return sha === undefined ? null : val('Ref', { id: nodeId('Ref', repo.id), name: pull.baseRef, prefix: 'refs/heads/', __target: sha, __repo: repo });
        }
        case 'files': {
          const diff = computePullDiff(forge, repo, pull);
          const items = (diff?.files ?? []).map((f) =>
            val('PullRequestChangedFile', { path: f.filename, additions: f.additions, deletions: f.deletions, changeType: f.status === 'added' ? 'ADDED' : f.status === 'removed' ? 'DELETED' : 'MODIFIED' }),
          );
          const page = pageConnection(items, args.first as number | undefined, args.after as string | undefined, () => 0);
          return connectionVal('PullRequestFileConnection', page, () => 0);
        }
        case 'comments': {
          const items = pull.comments.map((c) => commentVal(ctx, repo, c));
          const page = pageConnection(items, args.first as number | undefined, undefined, (v) => v.databaseId as number);
          return connectionVal('IssueConnection', page, (v) => v.databaseId as number);
        }
        default:
          return parent[field];
      }
    }
    case 'Ref': {
      if (field === 'target') {
        const sha = parent.__target as string;
        const obj = forge.objects.get(sha);
        if (obj !== undefined && obj.type === 'commit') return val('Commit', { id: nodeId('Commit', 0) + sha, oid: sha });
        return null;
      }
      return parent[field];
    }
    case 'IssueComment': {
      if (field === 'author') return userVal(String(parent.__authorLogin ?? VIEWER.login));
      return parent[field];
    }
    case 'RepositoryIssueConnection':
    case 'RepositoryPullRequestConnection':
    case 'PullRequestFileConnection':
    case 'IssueConnection': {
      const items = parent.__items as Val[];
      const keyOf = parent.__keyOf as (v: Val) => number;
      if (field === 'nodes') return items;
      if (field === 'edges') return items.map((item) => val('IssueEdge', { __node: item, cursor: cursorOf(keyOf(item)) }));
      if (field === 'pageInfo') return val('PageInfo', parent.__pageInfo as Record<string, unknown>);
      return parent[field];
    }
    case 'IssueEdge':
    case 'PullRequestEdge':
    case 'PullRequestFileEdge': {
      if (field === 'node') return parent.__node;
      return parent[field];
    }
    case 'PageInfo':
      return parent[field];
    case 'CreateIssuePayload':
      if (field === 'issue') return parent.__issue;
      return parent[field];
    case 'CloseIssuePayload':
      if (field === 'issue') return parent.__issue;
      return parent[field];
    case 'CreatePullRequestPayload':
      if (field === 'pullRequest') return parent.__pull;
      return parent[field];
    case 'MergePullRequestPayload':
      if (field === 'pullRequest') return parent.__pull;
      return parent[field];
    case 'AddCommentPayload': {
      if (field === 'commentEdge') return val('IssueEdge', { __node: parent.__commentNode, cursor: cursorOf(0) });
      if (field === 'subject') return parent.__commentNode;
      return parent[field];
    }
    default:
      return parent[field];
  }
}

function mergePull(ctx: Ctx, repo: RepoRec, pull: PullRec, method: string): void {
  const forge = ctx.forge;
  if (pull.merged || pull.state === 'closed') return;
  const diff = computePullDiff(forge, repo, pull);
  if (diff === null || diff.conflict || diff.mergedFlat === null) return;
  const tree = buildTreeFromFlat(forge.objects, diff.mergedFlat);
  const tick = forge.tick();
  const line = forge.authorLine(tick);
  let sha: string;
  if (method === 'SQUASH') {
    sha = forge.objects.write('commit', writeCommit({ tree, parents: [diff.baseTip], authorLine: line, committerLine: line, message: `${pull.title} (#${pull.number})` }));
  } else {
    sha = forge.objects.write('commit', writeCommit({ tree, parents: [diff.baseTip, diff.headTip], authorLine: line, committerLine: line, message: `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}` }));
  }
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = sha;
  pull.mergedTick = tick;
}

function repoFromNodeId(ctx: Ctx, raw: string): RepoRec | null {
  const parsed = parseNodeId(raw);
  if (parsed === null) {
    // Also accept a bare numeric id.
    const n = Number(raw);
    if (Number.isSafeInteger(n)) {
      for (const repo of ctx.forge.repos.values()) if (repo.id === n) return repo;
    }
    return null;
  }
  for (const repo of ctx.forge.repos.values()) if (repo.id === parsed.id) return repo;
  return null;
}

function issueFromNodeId(ctx: Ctx, raw: string): { repo: RepoRec; issue: IssueRec } | null {
  // Issue ids encode "Issue:<repoId>:<number>".
  try {
    const text = Buffer.from(raw, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts[0] === 'Issue' && parts.length === 3) {
      const repoId = Number(parts[1]);
      const number = Number(parts[2]);
      for (const repo of ctx.forge.repos.values()) {
        if (repo.id === repoId) {
          const issue = repo.issues.get(number);
          return issue === undefined ? null : { repo, issue };
        }
      }
    }
  } catch {
    // fall through
  }
  return null;
}

function pullFromNodeId(ctx: Ctx, raw: string): { repo: RepoRec; pull: PullRec } | null {
  try {
    const text = Buffer.from(raw, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts[0] === 'PullRequest' && parts.length === 3) {
      const repoId = Number(parts[1]);
      const number = Number(parts[2]);
      for (const repo of ctx.forge.repos.values()) {
        if (repo.id === repoId) {
          const pull = repo.pulls.get(number);
          return pull === undefined ? null : { repo, pull };
        }
      }
    }
  } catch {
    // fall through
  }
  return null;
}

function nodeLookup(ctx: Ctx, raw: string): Val | null {
  const repo = repoFromNodeId(ctx, raw);
  if (repo !== null) {
    // Distinguish by the encoded type prefix.
    try {
      const text = Buffer.from(raw, 'base64').toString('utf8');
      if (text.startsWith('Repository:')) return repoVal(ctx, repo);
    } catch {
      return null;
    }
  }
  const issue = issueFromNodeId(ctx, raw);
  if (issue !== null) return issueVal(ctx, issue.repo, issue.issue);
  const pull = pullFromNodeId(ctx, raw);
  if (pull !== null) return pullVal(ctx, pull.repo, pull.pull);
  const parsed = parseNodeId(raw);
  if (parsed !== null && parsed.type === 'User') {
    for (const login of ['adaiversen', 'quinnkeller', 'olgabauer']) {
      const user = userByLogin(login);
      if (user !== undefined && user.id === parsed.id) return userVal(login);
    }
  }
  return null;
}

// ----------------------------------------------------------------------------------------------
// Introspection values
// ----------------------------------------------------------------------------------------------

function typeRefVal(name: string): Val {
  const kind = TYPE_KINDS[name] ?? (TYPE_FIELDS[name] !== undefined ? 'OBJECT' : 'SCALAR');
  return val('__Type', { name, kind, __ofType: null });
}

function typeVal(name: string): Val | null {
  if (TYPE_FIELDS[name] === undefined && TYPE_KINDS[name] === undefined && !['String', 'Int', 'Boolean', 'ID', 'Float'].includes(name)) {
    return null;
  }
  return val('__Type', {
    name,
    kind: TYPE_KINDS[name] ?? 'OBJECT',
    description: null,
    __fields: TYPE_FIELDS[name] ?? null,
    __enumValues: ENUM_VALUES[name] ?? null,
  });
}

function schemaVal(): Val {
  return val('__Schema', {});
}

function resolveIntrospection(ctx: Ctx, parent: Val, field: string): unknown {
  if (parent.__type === '__Type') {
    if (field === 'name' || field === 'kind' || field === 'description') return parent[field];
    if (field === 'fields') {
      const fields = parent.__fields as string[] | null;
      if (fields === null) return null;
      return fields.map((name) => val('__Field', { name, description: null, __typeName: 'String', isDeprecated: false, deprecationReason: null }));
    }
    if (field === 'enumValues') {
      const values = parent.__enumValues as string[] | null;
      if (values === null) return null;
      return values.map((name) => val('__EnumValue', { name, description: null, isDeprecated: false, deprecationReason: null }));
    }
    if (field === 'ofType') return null;
    if (field === 'possibleTypes') return null;
    if (field === 'inputFields') return null;
    if (field === 'interfaces') return [];
    if (field === 'specifiedByURL') return null;
    return undefined;
  }
  if (parent.__type === '__Field') {
    if (field === 'type') return typeRefVal(String(parent.__typeName ?? 'String'));
    if (field === 'args') return [];
    return parent[field];
  }
  if (parent.__type === '__EnumValue') return parent[field];
  if (parent.__type === '__Schema') {
    if (field === 'types') return Object.keys(TYPE_FIELDS).map((name) => typeVal(name));
    if (field === 'queryType') return typeVal('Query');
    if (field === 'mutationType') return typeVal('Mutation');
    if (field === 'subscriptionType') return null;
    if (field === 'directives') return [];
    return undefined;
  }
  void ctx;
  return undefined;
}

// ----------------------------------------------------------------------------------------------
// Selection execution
// ----------------------------------------------------------------------------------------------

const META_TYPES = new Set(['__Type', '__Field', '__EnumValue', '__Schema', '__InputValue', '__Directive']);

function executeSelection(ctx: Ctx, parent: Val | null, selection: FieldNode[], doc: Document, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const parentType = parent === null ? 'Query' : parent.__type;
  for (const field of selection) {
    if (field.fragmentSpread !== null) {
      const fragment = doc.fragments.get(field.fragmentSpread);
      if (fragment !== undefined && (fragment.on === parentType || parentType === 'Query')) {
        Object.assign(out, executeSelection(ctx, parent, fragment.selection, doc, variables));
      }
      continue;
    }
    if (field.inlineOn !== null) {
      if (field.inlineOn === parentType) {
        Object.assign(out, executeSelection(ctx, parent, field.selection ?? [], doc, variables));
      }
      continue;
    }
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = parentType;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [argName, argValue] of field.args) args[argName] = resolveValue(argValue, variables);
    let raw: unknown;
    if (META_TYPES.has(parentType)) {
      raw = resolveIntrospection(ctx, parent as Val, field.name);
    } else if (field.name === '__type' || field.name === '__schema') {
      raw = resolveField(ctx, parent, field.name, args);
    } else {
      // Validation: unknown field on a known object type.
      const known = TYPE_FIELDS[parentType];
      if (parent !== null && known !== undefined && !known.includes(field.name)) {
        ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${parentType}'` });
        out[key] = null;
        continue;
      }
      raw = resolveField(ctx, parent, field.name, args);
      if (raw === undefined && parent !== null) {
        ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${parentType}'` });
        out[key] = null;
        continue;
      }
    }
    out[key] = completeValue(ctx, raw, field, doc, variables);
  }
  return out;
}

function completeValue(ctx: Ctx, raw: unknown, field: FieldNode, doc: Document, variables: Record<string, unknown>): unknown {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) return raw.map((item) => completeValue(ctx, item, field, doc, variables));
  if (typeof raw === 'object') {
    const value = raw as Val;
    if (typeof value.__type === 'string') {
      if (field.selection === null) return value.id ?? null;
      return executeSelection(ctx, value, field.selection, doc, variables);
    }
    return raw;
  }
  return raw;
}

// ----------------------------------------------------------------------------------------------
// Entry point
// ----------------------------------------------------------------------------------------------

export interface GraphqlResult {
  status: number;
  body: unknown;
}

export function handleGraphql(forge: Forge, payload: unknown): GraphqlResult {
  if (Array.isArray(payload)) {
    return { status: 200, body: payload.map((entry) => runOne(forge, entry)) };
  }
  return { status: 200, body: runOne(forge, payload) };
}

function runOne(forge: Forge, payload: unknown): Record<string, unknown> {
  const body = (payload ?? {}) as { query?: unknown; variables?: unknown; operationName?: unknown };
  if (typeof body.query !== 'string') {
    return { errors: [{ message: 'Missing query' }] };
  }
  const variables = (body.variables ?? {}) as Record<string, unknown>;
  let doc: Document;
  try {
    doc = new Parser(tokenize(body.query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'Parse error' }] };
  }
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  const operation = doc.operations.find((op) => operationName === null || op.name === operationName) ?? doc.operations[0];
  if (operation === undefined) return { errors: [{ message: 'No operation found' }] };
  const ctx: Ctx = { forge, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const root = val(rootType, {});
  const data = executeSelection(ctx, root, operation.selection, doc, variables);
  const out: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) out.errors = ctx.errors;
  return out;
}
