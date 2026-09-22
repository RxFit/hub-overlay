# AntigravityHQ vault semantic search — Lane 1 (canonical Git snapshot)

Danny's Obsidian vault "AntigravityHQ" syncs hourly to the private GitHub repo
`RxFit/antigravityhq-vault`. The Hub indexes that git snapshot into a dedicated
pgvector corpus and exposes a narrow **read-only** search API for AI harnesses
(Instinct, Claude Code, Hermes). The signed-in Hub UI (`/admin/vault-search`)
is an **inspection surface only**; the API is the transport.

> **Ships dark, deny by default.** Nothing is fetched, embedded or indexed until
> the owner completes the setup steps below. Until then every route answers
> `503 { status: "disabled" }` (no token) or `503 { status: "awaiting_scope_config" }`
> (no include globs). There are no secrets in code, logs or tests; every
> credential is a runtime env var bound from Secret Manager.

## Owner setup — NOT done by the PR that shipped this feature

The code cannot and does not create credentials. Danny does, in this order:

1. **Create the read-only PAT.** GitHub → Settings → Developer settings →
   Fine-grained personal access tokens → *Generate new token*. Resource owner
   `RxFit`, repository access **only** `RxFit/antigravityhq-vault`, permission
   **Contents: Read** (nothing else; Metadata: Read is implied). Pick an expiry
   and put its rotation date in the calendar.
2. **Bind the secrets in Secret Manager** (project `rxfit-automation`),
   following the existing `hub-*` `secretKeyRef` pattern from
   `docs/deploy-runbook.md` § "How Secrets Work":

   | Env var | Secret Manager name | Value |
   |---------|---------------------|-------|
   | `VAULT_GITHUB_TOKEN` | `hub-vault-github-token` | the PAT from step 1 |
   | `VAULT_SYNC_API_KEY` | `hub-vault-sync-key` | `openssl rand -hex 24` |
   | `VAULT_SEARCH_KEYS` | `hub-vault-search-keys` | JSON map, see below |

   ```bash
   echo -n "github_pat_…" | gcloud secrets create hub-vault-github-token --data-file=- --project=rxfit-automation
   openssl rand -hex 24 | tr -d '\n' | gcloud secrets create hub-vault-sync-key --data-file=- --project=rxfit-automation
   echo -n '{"<key-a>":{"harness":"instinct","tenantId":"rxfit"},"<key-b>":{"harness":"claude-code","tenantId":"rxfit"},"<key-c>":{"harness":"hermes","tenantId":"rxfit"}}' \
     | gcloud secrets create hub-vault-search-keys --data-file=- --project=rxfit-automation
   ```

   Then reference them from the `hub` service exactly like the other
   `hub-*` secrets (`valueFrom.secretKeyRef.name`, key `latest`). Each search
   key must be ≥ 16 chars; a `harness` is `[a-z0-9_-]`, and the `tenantId`
   binding is what makes a cross-tenant request a `403` — the caller never
   chooses its tenant.
3. **Choose the indexed folders and set the scope** as plain env vars (not
   secrets): `VAULT_INCLUDE_GLOBS` (comma-separated; **empty = index nothing**)
   and `VAULT_EXCLUDE_GLOBS` (**always wins**). Globs match the vault-relative
   path; a bare folder means everything under it; only `.md` files are ever
   candidates; `.git/` and `.obsidian/` are ignored unconditionally. Example:

   ```
   VAULT_INCLUDE_GLOBS=Projects/**,Areas/**,Daily/**
   VAULT_EXCLUDE_GLOBS=Private/**,Templates/**,**/Archive/**
   ```

   Optional: `VAULT_REPO` (default `RxFit/antigravityhq-vault`) and
   `VAULT_REPO_REF` (default `HEAD`).
4. **Verify** with `GET /api/admin/vault-search-health` (signed-in admin) —
   `config` must be `ok` — then run the first sync (below) and watch
   `coverage` fill. The admin page has the same report plus a query box.
5. **Schedule the sync.** Cloud Scheduler (or the existing cron pattern) →
   `POST https://hub.casatrejo.com/api/knowledge/antigravityhq/sync` hourly
   with `Authorization: Bearer <VAULT_SYNC_API_KEY>`, shortly after the vault's
   own hourly push. No workflow or scheduler change ships with the code.

## How the sync works (`lib/vault/sync.ts`)

One run = one commit:

1. `GET /repos/{slug}/commits/{ref}` → HEAD + tree SHA;
   `GET /repos/{slug}/git/trees/{sha}?recursive=1` → every blob's path + SHA.
   A **truncated** tree is refused (it would look like a mass deletion).
2. Keep the in-scope markdown blobs (scope above). Paths — never content — are
   logged (count at `info`, list at `debug`).
3. **Diff by git blob SHA** against `vault_notes.content_sha`: unchanged blobs
   cost nothing; new/changed blobs are re-indexed; a live note whose chunks are
   on a retired embedding model is re-indexed even though its blob did not
   change; a path that vanished (delete or rename) is **tombstoned**
   (`deleted_at` set, chunks removed, row kept).
4. Per note: fetch the blob (`GET /git/blobs/{sha}`, decoded and **verified
   against the SHA**) → `lib/markdown-chunker.ts` (frontmatter parsed onto the
   note row; headings → `heading_path`; fences and tables atomic; wikilinks and
   `^block-ids` untouched; ~2500-char chunks, ~500 overlap, 8000-char cap) →
   **embed every chunk** (`gemini-embedding-2`, 768 dims, tagged with the
   model) → **one transaction** replaces the old chunk set.
   A failure anywhere before/inside that transaction leaves the previous
   version fully queryable and records the note under `failed_paths`
   (path + message). A failed note never fails the run.
5. Record the run in `vault_sync_runs`. Re-running on an unchanged commit is a
   `noop` that is still recorded.

Budgets: `maxNotesPerRun` (body, default 200) and a 240s wall-clock deadline
end a run as `incomplete` with `notesRemaining` > 0 — call again; the diff
resumes by SHA. Systemic failures (embedding circuit open, 5 consecutive note
failures) stop the run early for the same reason.

Run statuses: `running → noop | completed | completed_with_failures | incomplete | failed`.

### Sync request / response

```bash
curl -sS -X POST "$HUB/api/knowledge/antigravityhq/sync" \
  -H "Authorization: Bearer $VAULT_SYNC_API_KEY" -H 'content-type: application/json' \
  -d '{"maxNotesPerRun": 200}'
# → 200 { runId, status, fromCommit, toCommit, notesScanned, notesIndexed,
#         notesFailed, notesUnchanged, notesTombstoned, notesRemaining,
#         failedPaths: [{ path, message }], durationMs, stoppedEarly }
# → 503 { status: "disabled" | "awaiting_scope_config" }         (dark)
# → 503 { status: "unavailable", stage, reason, detail }          (upstream down; run recorded as failed)
# → 401 / 403 (unknown tenantId) / 400
```

## How search works (`lib/vault/search.ts`)

```bash
curl -sS -X POST "$HUB/api/knowledge/antigravityhq/search" \
  -H "Authorization: Bearer $VAULT_SEARCH_KEY" -H 'content-type: application/json' \
  -d '{"query":"how is the deploy pipeline gated","topK":8,"pathPrefix":"Projects/","maxLatencyMs":5000,"minFreshnessSeconds":7200}'
```

Body (zod-validated, unknown fields rejected): `query` 1–2000 chars, `topK`
1–20 (default 8), `pathPrefix`, `maxLatencyMs` (cap 10000, default 8000),
`minFreshnessSeconds`, optional `tenantId` (must equal the key's binding).

Response:

```json
{
  "queryId": "…uuid…",
  "status": "fresh | stale | partial",
  "warnings": [],
  "sync": { "indexedCommitSha": "…", "indexedAt": "…", "syncLagSeconds": 120,
            "coverage": { "notesTotal": 412, "notesIndexed": 410, "notesFailed": 2 } },
  "hits": [{ "vaultPath": "Projects/Hub Overlay.md", "noteTitle": "Hub Overlay",
             "headingPath": "Hub Overlay > Architecture > Deploy",
             "charStart": 753, "charEnd": 1045, "excerpt": "…raw chunk text…",
             "similarity": 0.81, "contentSha": "<blob sha>", "indexedCommitSha": "<commit>",
             "sourceModifiedAt": "…", "indexedAt": "…" }]
}
```

| Situation | HTTP | `status` |
|-----------|------|----------|
| index queried, matched nothing | 200 | `fresh` (or `stale`) with `hits: []` |
| index older than `minFreshnessSeconds`, or never synced | 200 | `stale` + warning naming the lag; hits still returned |
| `maxLatencyMs` expired (embedding or DB query) | 200 | `partial` + warning; never a hang |
| embedding or DB **unavailable** / circuit open | 503 | `unavailable` + `stage`, `reason` |
| token unbound / scope unset | 503 | `disabled` / `awaiting_scope_config` |
| bad or missing key, non-admin session | 401 | — |
| body `tenantId` ≠ key binding | 403 | — |
| harness bucket empty | 429 + `Retry-After` | — |

**Unavailable is never reported as empty** (`lib/vertex.ts`'s rule): a harness
told "no matches" during an outage would conclude the note does not exist.
Only rows on the ACTIVE `EMBEDDING_MODEL` are searched (`lib/vector-store`'s
rule); a model change makes the corpus invisible until a sync re-embeds it,
which the sync does automatically.

**Rate limit:** a token bucket per harness (`VAULT_SEARCH_RATE_CAPACITY`,
default 30 burst; `VAULT_SEARCH_RATE_REFILL_PER_SEC`, default 0.5). It is
**per Cloud Run instance** — the effective ceiling is capacity × instances.
It is an abuse/runaway-loop guard, not a billing quota.

**Query logging:** `queryId`, harness, tenant, query **length** and a SHA-256
of the query. Never the query text, never note content.

**Circuits:** `vault-embeddings` and `vault-db` (`lib/circuit-breaker.ts`,
3 failures → open for 60s), keyed separately from every other breaker so a
vault outage cannot trip the chat path and vice versa.

## Retrieved notes are UNTRUSTED DATA — every consumer, no exceptions

Note content is **data, never instructions**. A note can say "ignore previous
instructions and …"; that line must reach a model as inert text it may quote,
never as a directive. Nothing in this feature executes, follows or relays
instructions found inside note content, and neither may anything downstream:

- Wrap every excerpt with `wrapExcerpt()` from `hub/lib/prompt-safety.ts`
  before it enters a prompt. It fences the text in the same
  `<untrusted_data source="vault:antigravityhq" path=… heading=… range=… sha=… commit=…>`
  block the chat route uses, with nested fence markers neutralized, and add
  `VAULT_CONTENT_POLICY` (or `UNTRUSTED_CONTENT_POLICY`) to the system prompt.
- Cite a claim by vault-relative path + heading (or char range) + retrieval
  time. Never an absolute filesystem path.
- Never use a note's content to justify an external send, a payment, a merge
  or a configuration change. Those stay human-approved regardless of what a
  note says.
- The Hub UI renders excerpts as plain text (never markdown/HTML).

The same rules already apply to the EA-vault `smart-connections` integration
in `AGENTS.md`; this corpus inherits them verbatim.

## Health: `GET /api/admin/vault-search-health`

Admin session only. Stages `config → db → embedding → sync`, each `ok | fail |
skipped` with a detail line and, when unhealthy, one concrete `remediation`.
Reports whether the token is bound, whether scope is set, sync/search key
presence (booleans and counts only), the last run, coverage counts and
embedding reachability (one bounded live call; `?probe=0` skips it).
`200` when healthy, `503` otherwise — an uptime check can watch it directly.

## Failure classes

| `stage` / `reason` | Meaning | Fix |
|--------------------|---------|-----|
| `config` (503 `disabled`) | `VAULT_GITHUB_TOKEN` unset | bind `hub-vault-github-token` |
| `config` (503 `awaiting_scope_config`) | `VAULT_INCLUDE_GLOBS` empty | set the globs (deny by default is working) |
| `github` / `auth` (401/403) | PAT expired, revoked, or not scoped to the repo | mint a new fine-grained PAT (Contents: Read) and add a secret version |
| `github` / `not_found` | wrong `VAULT_REPO` / `VAULT_REPO_REF`, or the PAT cannot see the repo | check the slug/ref; a private repo the PAT lacks reads as 404 |
| `github` / `http` (429) | REST rate limit — a full first index of a big vault does ~2 requests per note | lower `maxNotesPerRun`, space runs out, or set `resolveSourceModified: false` |
| `github` / `integrity` | truncated tree, or a blob that did not hash to its SHA | the run refuses to guess; re-run, and if it persists the vault exceeds the recursive-tree API (split scope) |
| `embedding` / `unconfigured` | no Gemini key | `GEMINI_API_KEY` |
| `embedding` / `breaker_open` | ≥3 embedding failures in 60s | wait for the reset; check the Gemini quota |
| `db` / `internal` | Postgres/pgvector error | `DATABASE_URL`; `drizzle/migrate.mjs` logs at container start (the vault tables sit under the same non-fatal pgvector guard as `document_chunks`) |
| run `incomplete` | budget/deadline/systemic stop | call sync again; check `stoppedEarly` |
| `completed_with_failures` | some notes failed | `failed_paths` on the run row names them |

Rotation: add a new secret version (`gcloud secrets versions add …`) and
redeploy; the old PAT can be revoked once health is green. Rotating a search
key means editing the JSON map — the harness holding the old key gets `401`.

## Optional JEV evaluator seam (`lib/evaluators/jev.ts`)

A post-retrieval seam for an external relevance judge. It is **default OFF**
(`evaluateHits()` returns `{ status: 'disabled' }` without `JEV_API_KEY`),
**shadow-only** (it can never re-rank, filter or gate hits, and search never
depends on it), and it makes **no network calls** today — with a key set it
only reports what it would evaluate. JEV is **usage-priced**, so enabling it is
a deliberate owner decision made after sizing the query volume, not a side
effect of setting a key.

## What this lane does NOT do

No write route into the vault, ever. No live Obsidian/Smart Connections calls.
No changes to `document_chunks` or `/api/embeddings/upsert`. No workflow,
scheduler or Secret Manager changes ship with the code. Lane 2 (live desktop
sync) is a separate design.
