# Fixture mini-vault

A tiny Obsidian-style vault used by the offline vault-search tests
(`lib/markdown-chunker.test.ts`, `lib/vault/sync.test.ts`, the route tests).
Nothing here is real: no secrets, no private data. The tests build a fake
GitHub tree from this directory (blob SHAs are computed with the real git
`blob <len>\0` formula) so no network or live repository is ever involved.

Layout mirrors the globs the runbook recommends:

- `Projects/**`, `Daily/**` — in scope
- `Private/**`, `Templates/**` — excluded (excludes always win)
- `attachments/diagram.png` — non-markdown, never indexed
- `README.md` (this file) — top-level note; included only when a glob says so
