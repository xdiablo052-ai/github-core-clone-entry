// The forge's state: users, repositories with their refs, issues, pull requests, labels and
// comments, all in memory, plus the object database from git.ts. Time is a logical clock seeded
// from MAKEFUN_TRIAL_NOW so two runs of the same request sequence stamp identically.

import { ObjectStore } from './git.ts';

export interface UserRec {
  id: number;
  login: string;
  name: string;
  email: string;
}

/** The trial's cast. The suite's scenario fixes these logins (its viewer is the token owner). */
export const USERS: readonly UserRec[] = Object.freeze([
  { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' },
  { id: 1001, login: 'quinnkeller', name: 'quinn keller', email: 'quinnkeller@example.invalid' },
  { id: 1002, login: 'olgabauer', name: 'olga bauer', email: 'olgabauer@example.invalid' },
  { id: 1003, login: 'dmitriquist', name: 'dmitri quist', email: 'dmitriquist@example.invalid' },
  { id: 1004, login: 'adanovak', name: 'ada novak', email: 'adanovak@example.invalid' },
  { id: 1005, login: 'zanerossi', name: 'zane rossi', email: 'zanerossi@example.invalid' },
  { id: 1006, login: 'pavelcosta', name: 'pavel costa', email: 'pavelcosta@example.invalid' },
  { id: 1007, login: 'wrenkeller', name: 'wren keller', email: 'wrenkeller@example.invalid' },
  { id: 1008, login: 'coraquist', name: 'cora quist', email: 'coraquist@example.invalid' },
  { id: 1009, login: 'elenaulrich', name: 'elena ulrich', email: 'elenaulrich@example.invalid' },
  { id: 1010, login: 'tesssato', name: 'tess sato', email: 'tesssato@example.invalid' },
  { id: 1011, login: 'svenrossi', name: 'sven rossi', email: 'svenrossi@example.invalid' },
]);

export const VIEWER: UserRec = USERS[0] as UserRec;

export function userByLogin(login: string): UserRec | undefined {
  return USERS.find((u) => u.login === login);
}

export interface LabelRec {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface CommentRec {
  id: number;
  body: string;
  authorLogin: string;
  tick: number;
}

export interface IssueRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  authorLogin: string;
  tick: number;
}

export interface PullRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  mergeCommitSha: string | null;
  authorLogin: string;
  tick: number;
  mergedTick: number | null;
  comments: CommentRec[];
}

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  refs: Map<string, string>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  labels: Map<string, LabelRec>;
  nextNumber: number;
  tick: number;
}

function parseTrialNow(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return n > 1e12 ? Math.floor(n / 1000) : n;
  }
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  return 1_735_689_600; // the scenario epoch, 2025-01-01T00:00:00Z
}

export class Forge {
  readonly objects = new ObjectStore();
  readonly repos = new Map<string, RepoRec>();
  private repoIdSeq = 700_000;
  private labelIdSeq = 800_000;
  private commentIdSeq = 900_000;
  private tickSeq = 0;
  private readonly epochSec = parseTrialNow();

  /** The next logical timestamp, in epoch seconds; strictly increasing per call. */
  tick(): number {
    this.tickSeq += 1;
    return this.epochSec + this.tickSeq;
  }

  /** Peek at the current logical time without advancing it. */
  nowTick(): number {
    return this.epochSec + this.tickSeq;
  }

  isoOf(tick: number): string {
    return new Date(tick * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /** A git author/committer line for the viewer at the given tick. */
  authorLine(tick: number): string {
    return `${VIEWER.name} <${VIEWER.email}> ${tick} +0000`;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): RepoRec | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, opts: { private?: boolean; description?: string; defaultBranch?: string }): RepoRec {
    this.repoIdSeq += 1;
    const repo: RepoRec = {
      id: this.repoIdSeq,
      owner,
      name,
      private: opts.private ?? false,
      description: opts.description ?? '',
      defaultBranch: opts.defaultBranch ?? 'main',
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNumber: 1,
      tick: this.tick(),
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  reposOf(owner: string): RepoRec[] {
    return [...this.repos.values()].filter((r) => r.owner === owner).sort((a, b) => a.id - b.id);
  }

  nextCommentId(): number {
    this.commentIdSeq += 1;
    return this.commentIdSeq;
  }

  nextLabelId(): number {
    this.labelIdSeq += 1;
    return this.labelIdSeq;
  }
}

/** Opaque, stable GraphQL node ids: base64 of "<Type>:<numeric id>". */
export function nodeId(type: string, id: number): string {
  return Buffer.from(`${type}:${id}`, 'utf8').toString('base64');
}

export function parseNodeId(raw: string): { type: string; id: number } | null {
  try {
    const text = Buffer.from(raw, 'base64').toString('utf8');
    const split = text.lastIndexOf(':');
    if (split < 0) return null;
    const id = Number(text.slice(split + 1));
    if (!Number.isSafeInteger(id)) return null;
    return { type: text.slice(0, split), id };
  } catch {
    return null;
  }
}

/** Issue node ids share the repo-scoped number space; encode repo id + number. */
export function issueNodeId(repoId: number, number: number): string {
  return Buffer.from(`Issue:${repoId}:${number}`, 'utf8').toString('base64');
}

export function pullNodeId(repoId: number, number: number): string {
  return Buffer.from(`PullRequest:${repoId}:${number}`, 'utf8').toString('base64');
}
