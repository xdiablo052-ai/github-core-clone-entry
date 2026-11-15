// The HTTP surface: one server routing git smart HTTP, REST v3, GraphQL and MCP onto the one
// store. Discipline the suite checks: JSON everywhere (never HTML), a non-empty
// X-GitHub-Request-Id on every REST reply, the bearer token refused when missing or wrong, a
// JSON 404 for unknown routes and a 400 for malformed JSON bodies.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { gitInfoRefs, gitService } from './githttp.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, type RestResult } from './rest.ts';
import { Forge } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY = 96 * 1024 * 1024;

let requestSeq = 0;
function requestId(): string {
  requestSeq += 1;
  return `FORGE-${String(requestSeq).padStart(6, '0')}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...extra,
  });
  res.end(text);
}

function sendRest(res: ServerResponse, result: RestResult): void {
  if (result.status === 204 || result.body === undefined) {
    res.writeHead(result.status, { 'x-github-request-id': requestId(), ...(result.headers ?? {}) });
    res.end();
    return;
  }
  sendJson(res, result.status, result.body, result.headers ?? {});
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY) throw new Error('body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function tokenOk(req: IncomingMessage, expected: string): boolean {
  if (expected === '') return true;
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  if (header === expected) return true;
  if (header.startsWith('Bearer ') && header.slice(7) === expected) return true;
  if (header.startsWith('token ') && header.slice(6) === expected) return true;
  return false;
}

export function createApp(forge: Forge = new Forge()): Server {
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        await route(forge, expectedToken, req, res);
      } catch {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      }
    })();
  });
  // The read workload holds one keep-alive connection for thousands of requests: keep it open.
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 130_000;
  return server;
}

async function route(forge: Forge, expectedToken: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  const path = url.pathname;
  const method = req.method ?? 'GET';
  const host = req.headers.host ?? 'localhost';

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch !== null) {
    if (!tokenOk(req, expectedToken)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    const owner = decodeURIComponent(gitMatch[1] as string);
    const repoName = decodeURIComponent(gitMatch[2] as string);
    const repo = forge.getRepo(owner, repoName);
    if (repo === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    const tail = gitMatch[3] as string;
    const protocolHeader = req.headers['git-protocol'];
    const protocolVersion = typeof protocolHeader === 'string' && protocolHeader.includes('version=2') ? 2 : 0;
    if (tail === 'info/refs') {
      const service = url.searchParams.get('service') ?? '';
      const result = gitInfoRefs(forge, repo, service, protocolVersion);
      res.writeHead(result.status, { 'content-type': result.contentType });
      res.end(result.body);
      return;
    }
    const body = await readBody(req);
    const result = gitService(forge, repo, tail, protocolVersion, body);
    res.writeHead(result.status, { 'content-type': result.contentType });
    res.end(result.body);
    return;
  }

  // Everything below needs the token.
  if (!tokenOk(req, expectedToken)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return;
  }

  if (path === '/api/graphql' && method === 'POST') {
    const raw = await readBody(req);
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { errors: [{ message: 'Malformed JSON body' }] });
      return;
    }
    const result = handleGraphql(forge, payload);
    sendJson(res, result.status, result.body);
    return;
  }

  if (path === '/mcp') {
    if (method !== 'POST') {
      res.writeHead(405, { 'content-type': JSON_TYPE, 'x-github-request-id': requestId() });
      res.end(JSON.stringify({ message: 'Method Not Allowed' }));
      return;
    }
    const raw = await readBody(req);
    const result = handleMcp(forge, raw);
    res.writeHead(result.status, { 'content-type': result.contentType, 'x-github-request-id': requestId() });
    res.end(result.body);
    return;
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const raw = await readBody(req);
    let body: Record<string, unknown> | null = null;
    if (raw.length > 0 && (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')) {
      try {
        const parsed = JSON.parse(raw.toString('utf8')) as unknown;
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        body = parsed as Record<string, unknown>;
      } catch {
        sendJson(res, 400, { message: 'Malformed JSON body' });
        return;
      }
    }
    const segments = path
      .slice('/api/v3'.length)
      .split('/')
      .filter((s) => s !== '')
      .map((s) => decodeURIComponent(s));
    const result = handleRest(forge, { method, segments, query: url.searchParams, body, rawBody: raw, host });
    sendRest(res, result);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}
