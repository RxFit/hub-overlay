# Hardening review — the live agy dispatch architecture (2026-08-20)

**Status:** prioritized findings, not built. **System under review:** the full
allotment path as it went live today — Hub (Cloud Run, 1–3 instances) →
Postgres dispatch queue → desktop worker (Windows/Docker Desktop, residential
IP, one consumer OAuth token) → agy CLI — plus its fallback ladder, ledgers,
and supervision. **Method:** five analysts (upstream dependency, desktop as
infrastructure, data over time, security drift, capacity/growth) over the real
code and this project's incident history, then two adversarial judges who
killed 12 findings as duplicates, code-misreads, or wrong-threat-model, and
ranked the survivors. Both judges converged on the same four load-bearing
moves, independently.

**The one-sentence diagnosis:** the never-stall ladder is *too* good — every
failure mode (worker death, token death, envelope drift, cooldown thrash,
future quota exhaustion) degrades silently into metered spend, so the
system's only guaranteed failure detector today is the monthly bill.

---

## The four load-bearing moves

### 1. Make failure push, not pull — one alerting mechanism retires five findings

> **✅ Shipped 2026-08-21** — `healthy` now includes `workerAlive` when
> dispatch is enabled; hourly `.github/workflows/dispatch-alert.yml` →
> `POST /api/cron/dispatch-alert` → Google Chat (`— via HUB`), with the
> workflow's failure email as the fallback push. Ops: the "Push alerting"
> section of `hub/docs/runbooks/agy-gateway.md`. The allotment-collapse
> condition is wired but inert until move 3 ledgers the metered chains.

`dispatch-health`'s `healthy` field **does not include `workerAlive`**
(app/api/admin/dispatch-health/route.ts — it reports `healthy: true` with a
dead worker), and nothing anywhere pushes a signal. The honest answer to
"what does the operator see when the worker dies" is: nothing; chat quietly
costs money again, indefinitely.

- Fold `workerAlive` (when `dispatchEnabled`) into `healthy` — two lines.
- Add one scheduled check with a push path — a GitHub Actions cron or the
  existing scheduled-reports infrastructure hitting `dispatch-health`
  (WITHOUT `?probe=1` — keep it free) and posting to Google Chat via the
  existing `— via HUB` tag convention (or email) when: worker stale, agy
  error-class streaks in `ai_runs`, or allotment-share collapse (see move 3).
- This single mechanism converts worker death, Patch-Tuesday logouts, token
  death, envelope drift, watchdog failure, auth tightening, and eventual
  quota exhaustion from **bill-discovery to same-hour discovery**.

*Effort: small PR + one scheduled job.*

### 2. Pin agy; add a worker boot canary

The worker's agy version is **Docker-cache-controlled, not
operator-controlled**: `scripts/agy-worker/Dockerfile` curl|bash-installs
"latest" in a cached layer, and `update.ps1` builds without `--no-cache` — so
the version only jumps when the cache happens to bust, to whatever the server
serves that day, untested. This is exactly how 1.1.16 arrived and produced
the first-ever dispatch `parse` failure. The sha512 in the release manifest
is also **self-attesting** (same server as the binary).

- Check in a version + sha512 lock (e.g. `scripts/agy/agy-version.lock`);
  Dockerfiles download the exact versioned artifact and verify against the
  **in-repo** hash. Upgrades become a deliberate PR that bumps the pin after
  running the Phase 0 replay test against the new version.
- Boot canary in the worker: on start, run one marker prompt through
  `agyGenerateText`; if `interpretEnvelope` can't extract text, refuse to
  claim jobs and surface a flag — envelope drift caught at worker boot, not
  on a user's chat turn.

*Effort: medium PR. Retires an incident class already observed once.*

### 3. Ledger the metered chain — make fallthrough a number

`recordAiRun` is called from 13 files; **none of them are `gemini.ts` or
`claude.ts`**. Every fallthrough to the metered chain — the system's designed
behavior under any failure — is invisible except on the GCP bill. The
`ai_runs` schema was explicitly designed engine-agnostic for this; zero
migration needed.

- Call `recordAiRun` from the Gemini/Claude success and failure paths
  (`engine: 'gemini' | 'claude'`).
- Surface "allotment-served vs metered-served, last 24h" on dispatch-health —
  the ratio the move-1 alert can threshold on.

*Effort: small PR.*

### 4. Keep the one desktop alive unattended

The worker's real availability ceiling is Windows operations:

- **Patch-Tuesday reboots park the machine at the login screen** (Docker
  Desktop needs a session): enable automatic restart sign-on (ARSO) or
  Autologon + lock-workstation-at-logon; set Docker Desktop "start on
  sign-in". *Env-only, do today.*
- **`update.ps1` fails silently** (17 lines, no error handling, no log): add
  `Start-Transcript`, `$ErrorActionPreference='Stop'`, exit-code checks, and
  change compose's arg default to `${WORKER_GIT_SHA:?run update.ps1}` so a
  manual build can't re-open the `version: "dev"` blindspot (observed day 1).
- **No docker prune anywhere**: nightly rebuilds grow the WSL2 vhdx until the
  disk chokes. Add `docker image prune -f` + bounded builder prune to
  `update.ps1`; watchdog logs free disk per tick.

*Effort: env-only + small PR.*

## Five-minute quick wins (env-only, no deploy)

| Action | Why |
|---|---|
| `gcloud run services update hub --region us-central1 --remove-secrets AGY_OAUTH_TOKEN` | Phase 1 residual. Dispatch mode never reads it; it is pure blast radius on Cloud Run. Keep the Secret Manager copy as the re-mint backup. `agy-health` will show `envTokenPresent: false` — correct. |
| Set `WORKER_CHAT_SLOTS=3` in the desktop `.env` (restart container) | Effective allotment concurrency is **1** today while the queue admits 3: the second concurrent turn burns 5s on `claim_timeout` then goes metered. The 2026-08-19 concurrency test covered exactly N=3 (`PARALLEL_OK`). |
| ARSO / auto-login setting (move 4) | The single biggest availability lever, zero code. |

## Soon (1–3 months)

| Finding | Mechanism | Fix | Effort |
|---|---|---|---|
| **Output tails leak model content into `ai_runs`** | `parse`/`auth` errors embed a 200–300-char output tail via `truncateAgyError` → `ai_runs.error` (append-only) + Cloud Logging. First instance already exists (the 2026-08-20 19:01 probe row). | Durable error stays content-free (class + reason); full tails to debug logging only. **Judge-resolved contradiction:** do NOT "log fuller tails to the ledger" for auth diagnosis — keep a per-version corpus of observed auth strings in the test suite instead. | small |
| **`/api/admin/*` role-gating is per-handler discipline** | Middleware excludes prefixes; every handler must remember its own gate; no test enforces conformance. | Add an `/api/admin` role gate in middleware (defense-in-depth) + a vitest conformance test that walks the route tree asserting auth per route. | small |
| **`migrate.mjs` is a hand-written twin of `schema.ts`** | Non-fatal blocks can leave a permanently partial schema; one prior miss recorded. | CI drift check: after `migrateTestDb`, diff `information_schema` against the drizzle schema; fail on divergence. | medium |
| **`sweepStale` starves at low traffic + races unserialized** | 5%-probabilistic invocation on enqueue; at low traffic the 7-day delete and orphan-spend ledgering may not run for weeks; concurrent sweeps can double-ledger. | Advisory-lock the sweep; add a guaranteed invocation from the existing hourly cron route (also decouple `event_log` pruning from kpis/sync there). | small |
| **Quota meter + exhaustion class** | Nothing tracks cumulative allotment burn; the exhaustion error signature is unmapped — it will land in some wrong bucket and thrash 5-min retries for the rest of the month. | Daily usage rollup (tokens/runs by engine) on dispatch-health; characterize the exhaustion output once, add a `quota` class with an hours-long cooldown tier + runbook row. | small |
| **Per-user attribution + policy** | `ai_runs.user_email` is NULL on chat rows; a second allowlisted user already exists and would spend the operator's personal allotment invisibly. | Thread session email into the chat-path `recordAiRun` calls; decide policy (allotment for superadmin only vs shared-and-attributed). | small |
| **Phase 3 pre-work: work_item terminal ledgering** | Deadline/lease-expired work_items write no `ai_runs` row; the panel (whose data source IS the ledger) would show successes only. Worker `workSlots` default 0. | Ledger terminal work_item states from the reap path; Phase 3 rollout checklist: re-run the concurrency test before raising slots. | medium |
| **Worker-secret rotation story** | `AGY_WORKER_SECRET`/`CRON_SECRET` were minted once; no rotation procedure exists anywhere. | Dual-accept (`_NEXT` variant) in `verifyCronSecret` → zero-downtime overlap rotation; runbook section. | small |

## Watch — tripwires, not work

- **Retention tiers** (`ai_runs`, `ai_action_log`, `event_log`, `chats`): append-only, zero DELETEs today. Tripwire: quarterly `pg_total_relation_size` check; decide 12–18-month audit retention when any table crosses ~1GB.
- **`document_chunks` stale-model rows** eroding HNSW recall: run `SELECT embedding_model, count(*) … GROUP BY 1` after any re-embed; delete stale buckets.
- **Gate-token jti replay across instances** (documented residual): tripwire = raising `--max-instances` above 3, any new `consume:true` call site, or Phase 2 tenancy. Fix is the dispatch-store CAS pattern applied to a `gate_jti` table.
- **`— via HUB` tagging is per-call-site**: tripwire = a fourth Chat-sending call site. Fix at the choke point (`sendChatMessage` takes a required `origin` param and tags itself).
- **Shared rw token file** (desktop CLI ↔ worker): tripwire = `auth` errors while the worker shows fresh. Fix: worker gets its own grant in a named volume. Standing rule: `agy logout` on the desktop is one command from an outage.
- **Unknown worker id on dispatch-health**: the only theft signal for the worker secret. Optional cheap layer: `WORKER_ALLOWED_IDS` allow-list + caller IP recorded on `dispatch_workers`.
- **min-instances=1 idle cost**: the long-poll keeps the instance CPU-active 24/7 by design; verify the bill line once, then decide whether ~5s idle-pickup latency is worth `POLL_INTERVAL_MS` backoff.
- **Auth-string drift** (English error text already reworded once, b0e486e): keep every observed per-version auth string in the `agy.test.ts` corpus; a rewording becomes a one-line addition, not archaeology.

## Killed in review (so nobody re-litigates)

12 findings died: eight duplicates across surfaces (the agy-pin and
worker-death-alerting findings were each independently discovered three
times — treat that convergence as severity evidence), one code-misread
(release-endpoint risk overstated for the Cloud Run path, real for the
worker), one wrong-threat-model (stolen-secret prompt-reading as a
standalone project — the allow-list line above is the proportionate
response), and two that were preconditions folded into other items'
checklists (PARALLEL_OK re-testing; jti-under-tenancy).
