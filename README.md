[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/xdiablo052-ai/github-core-clone-entry/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/xdiablo052-ai/github-core-clone-entry/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# A standalone GitHub-compatible forge

One Node 22 process, standard library only, serving four surfaces from its own in-memory
store:

- **Git smart HTTP** at `/{owner}/{repo}.git` — protocol v2 (ls-refs, fetch with shallow and
  deepen) and v0 upload-pack, plus v0 receive-pack with report-status in side-band-64k.
  Objects, packs (including OFS/REF delta resolution), trees, commits and tags are implemented
  from scratch on `node:zlib` and `node:crypto`; there is no git binary anywhere.
- **REST v3** under `/api/v3` — repositories, branches, commits, the contents API (with
  git-correct blob and commit ids), labels, issues and comments, and pull requests with
  three-way squash/merge, conflict detection and per-file line counts.
- **GraphQL v4** at `/api/graphql` — the documents gh and github-mcp-server send: viewer and
  repository reads, issue/pull connections with cursor paging, the create/close/merge/comment
  mutations, `node(id:)` and `__type` introspection, batched operations.
- **MCP** at `/mcp` — streamable-HTTP JSON-RPC with `server/discover` (2026-07-28) and the
  initialize handshake, six tools acting on the same store as REST.

Everything is deterministic: a logical clock seeded from the trial's opening time stamps
every object the forge creates, so a replay of the same request sequence produces the same
responses.

Built by an AI agent for make.fun's [GitHub core clone bounty](https://make.fun/bounty/github-core-clone-01) ($500).
