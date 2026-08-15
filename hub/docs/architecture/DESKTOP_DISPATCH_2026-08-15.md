# Desktop-worker dispatch — design (Phase 2.5)

**Status:** design, not built. **Target:** master@90059a8. **Date:** 2026-08-15.

> **Numbering.** The roadmap in `scripts/agy/README.md` already names Phase 3
> "Rewire panel" and Phase 4 "Reborn tooling". Those keep their numbers. This is
> an *unplanned* insertion forced by the finding below, so it slots in as **2.5**
> rather than renumbering canon out from under future sessions.

## Why this exists

Phase 1/2 built the allotment gateway on the premise that Cloud Run could spend
the subscription allotment by replaying the desktop-minted OAuth token. That
premise is dead. Evidence, gathered 2026-08-14/15:

1. The Secret Manager copy (`hub-agy-oauth-token`) and the desktop file are a
   **perfect hash match** — the secret is not mangled.
2. The Phase 0 clean-room container **PASSES on the desktop** — keyring-less
   Linux, same image, same token, marker verified.
3. The same token **auth-fails from Cloud Run**.

The clean room reproduces everything about production *except the egress IP*.
The conclusion — Google refuses consumer-OAuth refresh from datacenter address
space — is a strong inference, not a confirmed mechanism, and the architecture
must not bet on it changing.

So execution moves to the residential IP; orchestration stays on Cloud Run. Note
this makes the arrangement **less** ToS-gray than before: the token stays on the
machine that minted it, doing what a consumer install normally does.

Nothing built so far is wasted — the typed error taxonomy, the `ai_runs` ledger,
the `AGY_CHAT_ENABLED` flag, and the never-stall fallback ladder were all built
for exactly this contingency and are reused verbatim.

---

## 1. Topology & trust boundaries

```
 Browser ──(session cookie; client aborts at 110s)──► Cloud Run "hub"
                                                       │ 1–3 instances, --timeout=120
                                                       │ /api/chat → gemini.ts → tryAgyChat
                                                       │        │
                                                       │        ▼ AGY_DISPATCH_ENABLED
                                                       │   lib/agy-dispatch.ts
                                                       ▼
                                              Cloud SQL Postgres  ◄── the ONLY shared state
                                              dispatch_jobs · dispatch_workers · ai_runs
                                                       ▲
                                     outbound-only HTTPS (desktop is NAT'd; no inbound, no tunnel)
                                                       │
 Danny's Windows desktop (residential IP)              │
   └─ Docker Desktop container `agy-worker` ───────────┘
        built from the local checkout; imports hub/lib/agy.ts via tsx
        └─ agy CLI → subscription allotment
        └─ bind mount: %USERPROFILE%\.gemini\antigravity-cli → /home/agyuser/.gemini/antigravity-cli (rw)
```

| Principal | Holds | Deliberately does NOT hold |
|---|---|---|
| Hub (Cloud Run) | DB creds, `AGY_WORKER_SECRET`, session auth | the OAuth token (dispatch mode never reads `AGY_OAUTH_TOKEN`) |
| Worker (desktop) | the OAuth token, `AGY_WORKER_SECRET`, `HUB_URL` | **DB credentials, Artifact Registry auth, GCP IAM** — it speaks only HTTPS to three `/api/worker/*` routes |
| Browser | NextAuth session | worker secret, token |

**Blast radius, stated plainly.** A stolen worker secret lets an attacker drain
the job queue and return poisoned chat answers — serious, and bounded by the
fact that it cannot reach Postgres, GCP, or the token. A compromised *desktop*
is already game over for the token by construction; that is true today and this
design does not widen it. The reverse direction matters too: a compromised Hub
can make the desktop run arbitrary agy prompts — which is the inherent power of
any dispatch system, bounded by the worker executing **only** `agy -p` with a
prompt string (never shell, never arbitrary argv from the wire).

**Relationship to the AGENTS.md Dispatch contract (named non-overlap).** That
contract governs delegated **code** work — minutes-to-hours, coordinated through
GitHub, merged by Jules, verified via `gh`. This is a **data-plane** dispatch:
seconds-scale chat turns coordinated through Postgres whose output is a chat
answer, not a commit. No code, branch, or PR ever transits `dispatch_jobs`. The
future `work_item` kind straddles both deliberately: this queue is only the
*transport*; any code such a run produces still obeys all five rules, and the
job row records just the resulting PR URL.

---

## 2. Queue contract

Two tables, defined in `hub/lib/schema.ts` **and** as idempotent blocks in
`hub/drizzle/migrate.mjs` (the only deploy path; runs every cold start; failures
are non-fatal, so every query below tolerates the tables not existing).

```sql
CREATE TABLE IF NOT EXISTS dispatch_jobs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind                TEXT NOT NULL,                 -- 'chat_turn' | 'work_item' (open union, like ai_runs.source)
  priority            INTEGER NOT NULL DEFAULT 100,  -- chat_turn=0, work_item=100; claim orders priority ASC
  state               TEXT NOT NULL DEFAULT 'queued',-- queued|leased|succeeded|failed|cancelled|expired
  attempt             INTEGER NOT NULL DEFAULT 0,
  max_attempts        INTEGER NOT NULL DEFAULT 1,    -- chat_turn:1 (at-most-once), work_item:3
  deadline_at         TIMESTAMPTZ NOT NULL,          -- absolute; executing past this is pointless
  payload_text        TEXT,                          -- the prompt. CONTENT — scrubbed, see §2.6
  payload_meta        JSONB,                         -- model/effort/timeout hints; primitives only
  prompt_chars        INTEGER,                       -- provenance skeleton; survives the scrub
  prompt_sha256       TEXT,                          -- 16-hex, same fingerprint convention as ai_runs
  leased_by           TEXT,
  leased_at           TIMESTAMPTZ,
  lease_expires_at    TIMESTAMPTZ,
  cancel_requested_at TIMESTAMPTZ,
  result_text         TEXT,                          -- CONTENT — scrubbed on delivery
  result_meta         JSONB,                         -- model, usage, workerId, prUrl
  error_class         TEXT,                          -- AgyErrorType + no_worker|claim_timeout|lease_expired
  error               TEXT,                          -- flattened, ≤300 chars (truncateAgyError convention)
  latency_ms          INTEGER,
  finished_at         TIMESTAMPTZ,
  delivered_at        TIMESTAMPTZ,
  scrubbed_at         TIMESTAMPTZ,
  request_id          TEXT                           -- threads ai_runs / event_log / telemetry
);
CREATE INDEX IF NOT EXISTS dispatch_jobs_claim_idx   ON dispatch_jobs (state, priority, created_at);
CREATE INDEX IF NOT EXISTS dispatch_jobs_created_idx ON dispatch_jobs (created_at DESC);

CREATE TABLE IF NOT EXISTS dispatch_workers (        -- singleton-per-machine registry
  id            TEXT PRIMARY KEY,                     -- e.g. 'danny-desktop'
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),   -- touched by every claim ⇒ liveness
  version       TEXT,                                 -- worker git SHA (see §4 update story)
  agy_version   TEXT,
  meta          JSONB
);
```

### 2.1 State machine

```
 (Hub enqueue)
      ▼
 ┌─────────┐  claim: FOR UPDATE   ┌────────┐  result ok   ┌───────────┐
 │ queued  │───SKIP LOCKED───────►│ leased │─────────────►│ succeeded │
 └─────────┘                      └────────┘  result err  ├───────────┤
   │   │                            │  │  └─────────────► │  failed   │
   │   │ Hub cancel                 │  │ Hub cancel       ├───────────┤
   │   └──────────────────────────► │  │ ───────────────► │ cancelled │
   │ deadline passed, unclaimed     │  │ lease expires:   ├───────────┤
   └──────────────────────────────► │  │  work_item & attempt<max → queued
                                    │  │  chat_turn, or attempts spent → expired
```

Every transition is a single guarded UPDATE (compare-and-set on `state`, plus
`leased_by`/`attempt` where relevant) — the `kpis` version-CAS style applied to
the state column. There are no unguarded writes to `state` anywhere.

### 2.2 Claim

Inside `withTransaction` (`lib/db.ts`), using Drizzle's `.for('update', { skipLocked: true })`
— **verified present in the installed drizzle-orm 0.45.2** (`pg-core/dialect.js`
emits `SKIP LOCKED`):

```sql
SELECT id FROM dispatch_jobs
 WHERE state='queued' AND deadline_at > now() AND kind = ANY($kinds)
 ORDER BY priority ASC, created_at ASC
 LIMIT 1 FOR UPDATE SKIP LOCKED;

UPDATE dispatch_jobs
   SET state='leased', leased_by=$worker, leased_at=now(), attempt=attempt+1,
       lease_expires_at = now() + $leaseMs, updated_at=now()
 WHERE id=$id AND state='queued' RETURNING *;
```

`SKIP LOCKED` makes double-claim impossible by construction — across the 3 Hub
instances today, and across multiple workers later, with no design change.

### 2.3 Delivery semantics, decided per kind (not defaulted)

**`chat_turn` — at-most-once execution.** `max_attempts=1`. If the lease lapses
or the worker dies, the job is **never** requeued: by then the waiting request
has already fallen through to metered and the user has an answer. A retry would
spend allotment producing text nobody reads. Lease 25s, heartbeat 10s.

**`work_item` — at-least-once.** `max_attempts=3`, lease 180s, heartbeat 30s.
Re-execution converges by job-scoped idempotency rather than queue magic: the
job id goes in the branch name (`agy/job-<uuid8>-…`) and attempt >1 begins with
fetch-first discovery of what the previous attempt pushed — which is literally
rule 1 of the AGENTS.md dispatch contract.

### 2.4 Idempotent result posting & the cancellation race

Result posting is a CAS keyed on `(id, leased_by, attempt)`. Four outcomes, all
HTTP 200 with an explicit `outcome` so the worker never retries into ambiguity:

| outcome | meaning | ledger |
|---|---|---|
| `recorded` | normal completion | `ai_runs` row written on the winning transition |
| `discarded_cancelled` | Hub gave up at its budget; worker finished anyway | row written with `meta.discarded:true` — **the allotment was spent and the ledger says so** |
| `discarded_lease_lost` | worker presumed dead, posts late | same, plus tells a zombie `work_item` attempt to stand down |
| `duplicate` | network retry of the same post | byte-identical ack, **no second row** |

**Who wins the cancellation race:** the metered chain owns the user-visible
answer (it already streamed). **Who pays:** both — allotment *and* metered for
that turn. That is the bounded, honest price of the never-stall guarantee, and
it follows the Phase 2 precedent of recording spend even on client abort.
Cancellation reaches a mid-run worker by *pull* (the desktop cannot be pushed
to): the heartbeat response carries `{cancelRequested:true}`, the worker SIGTERMs
the agy child. Worst-case wasted desktop compute: one heartbeat interval.

### 2.5 Lease expiry — lazy, no new cron

Reaping piggybacks on the claim call and on every dispatch-health GET (both
idempotent, both cheap). Critically, the Hub's chat wait-loop treats
`lease_expires_at < now()` on the row it is watching as immediate failure, so
**user latency never depends on the reaper running.**

### 2.6 Retention — content is transient transport

`payload_text` and `result_text` **are content**, which crosses the `ai_runs`
provenance-only line. Policy: content is transient, provenance is durable, and
`ai_runs` stays the only long-lived record.

- On delivery, the same UPDATE that sets `delivered_at` nulls both text columns
  and sets `scrubbed_at`. Content lifetime ≈ seconds.
- On any terminal transition, content is nulled in that transition.
  `prompt_chars`/`prompt_sha256` are computed at enqueue, so nothing is lost.
- Safety-net sweep (piggybacked, probabilistic): scrub anything `finished_at <
  now() - 10 minutes` still holding content; hard-DELETE rows older than 7 days.

This is deliberately **stricter** than the `chats`/`chat_messages` precedent:
those store content because conversations are product data. Dispatch rows are
plumbing, so they earn the stricter policy.

### 2.7 Backpressure

Enqueue refuses (⇒ instant metered fallthrough, no user impact) when active
`chat_turn` count ≥ 3 — one per possible concurrent instance-held request is the
honest capacity of a single serial desktop. `work_item` caps at 10 queued.

---

## 3. API surface

**Middleware change (mandatory, one line).** `hub/middleware.ts` 401s every
`/api` path not in its exclusion list; a machine worker can never hold a NextAuth
cookie. Add `api/worker` to the matcher exclusion. This is not optional — the
repo treats `/api/kpis/sync`'s *non*-exclusion as a live landmine, and we do not
copy it.

Every handler still authenticates itself:
`verifyCronSecret(req.headers.get('x-worker-secret'), process.env.AGY_WORKER_SECRET ?? '')`
— constant-time, **503 when unset** (which doubles as a kill switch), 401 on mismatch.

| Route | Purpose |
|---|---|
| `POST /api/worker/claim` | Long-poll claim (`waitMs ≤ 25000`) + liveness upsert + lazy reap. 200 with a job, or 204. `maxDuration = 60`. |
| `POST /api/worker/jobs/[id]/heartbeat` | Extends the lease under a guard; the response carries `cancelRequested` — this is the cancel channel. A failed guard returns `{ok:false, reason:'lease_lost'}` and the worker aborts. |
| `POST /api/worker/jobs/[id]/result` | The CAS of §2.4; writes the `ai_runs` row on the winning transition. |
| `GET /api/admin/dispatch-health` | Session + admin gated. Cheap by default (liveness, version pair, queue depths, last 20 jobs as provenance only). `?probe=1` enqueues a marker job end-to-end — the sibling of `agy-health`'s convention. |

**Hub-internal:** new `hub/lib/agy-dispatch.ts` exporting
`dispatchGenerateText(prompt, opts): Promise<AgyResult>` — the *same* result
shape and the same typed-`agyError` throw contract as `agyGenerateText`, with
the error space widened by `no_worker | claim_timeout | lease_expired |
dispatch_cancelled`. Because `ai_runs.error_class` is open TEXT, this needs
**zero migration**.

---

## 4. Worker runtime on the desktop

**Container, and this is forced rather than preferred:** the pty invariant
(`script -qec`, guarding agy's silent-empty bug) is proven on **Linux only**.
PowerShell 5.1 has no equivalent. Phase 0's clean room already passed on this
exact machine's Docker Desktop and residential IP, so the target is pre-validated.

**Build from the local checkout — do NOT run the Hub image.** Two of the three
independent designs rejected the Hub image for the same reason: it drags
`DATABASE_URL` and Artifact Registry auth onto the desktop, widening a stolen-
desktop from "one OAuth token" to "the whole database". Instead:
`hub/scripts/dispatch-worker.ts` (under `hub/` so the `@/lib/*` alias resolves)
is a ~200-line loop — claim → run → post → repeat, with jittered backoff on Hub
unreachability — that imports `agyGenerateText`, `agyErrorType`,
`truncateAgyError` **wholesale**. All Phase 0 paranoia comes free, it cannot
drift from the gateway, and it is unit-testable in the existing vitest suite so
CI gates worker changes like any other code.

`scripts/agy-worker/` ships `Dockerfile` (derived from `Dockerfile.phase0`:
node:22-slim, util-linux, non-root `agyuser`, auto-update off),
`docker-compose.yml` (`restart: unless-stopped`, env file ACL'd to Danny, exactly
one bind mount), `install.ps1`, and `update.ps1`.

**Token handling.** The bind mount is **read-write** — load-bearing, because agy
refreshes the token *in place*, and that refresh must persist to the host so the
desktop CLI and the worker share one rotating credential instead of forking it.
`AGY_OAUTH_TOKEN` is **not** set in the container, so `agy.ts`'s never-clobber
rule keeps a stale env copy from overwriting the live file. Red line, repeated
wherever tokens appear: **never `agy logout` on this desktop** — it revokes the
grant globally, including the production secret.

**Supervision:** `restart: unless-stopped` covers worker crashes and Docker
restarts. What it cannot cover is Docker Desktop not running after a reboot, so
`install.ps1` registers Scheduled Task `AgyWorkerWatchdog` (the accepted
paperclip-suite pattern, minus its deprecated payload): at logon and every 5
minutes, start Docker if needed, `docker compose up -d`, append one line to a
rotating log. **Honest dependency:** Docker Desktop's Linux VM needs a logged-in
session — a locked screen is fine, a logged-out machine is not. This belongs in
the runbook, and the failure is legible: dispatch-health shows the worker stale
within ~40s and chat silently rides metered.

**Update story (no babysitting):** Scheduled Task `AgyWorkerUpdate`, nightly:
`git fetch && git reset --hard origin/master && docker compose build && up -d`
— fast-forward from master only, i.e. exactly the artifact CI gated and Jules
merged. Rollback is the same command against a known SHA.

> **Gap found during verification:** the Hub currently exposes **no git SHA or
> revision identifier** anywhere, so the version-drift check both designs assumed
> has nothing to compare against. Fix in PR 1: add `GIT_SHA=${{ github.sha }}` to
> the existing `--update-env-vars` list in `deploy.yml` (one line) and echo it in
> the claim response. Without this, drift is invisible until it bites.

---

## 5. Chat-path integration

**The substitution is one line** at `hub/lib/agy-chat.ts:165`:

```ts
const result = isDispatchEnabled()
  ? await dispatchGenerateText(prompt, { budgetMs: agyChatTimeoutMs(), requestId: obs.requestId, signal })
  : await agyGenerateText(prompt, { timeoutMs: agyChatTimeoutMs() })
```

`gemini.ts` is untouched. Everything downstream — the atomic single-chunk yield,
the never-throws contract, badge ordering, `signal.aborted` handling, the
fire-and-forget ledger write, the cooldown tiers — is inherited unchanged.

**Latency arithmetic** (real ceiling 120s per `deploy.yml --timeout=120`; client
aborts at 110s; `service.yaml`'s 300 is stale reference — as is a comment in the
agy-health route, worth fixing on touch):

| step | cost |
|---|---|
| liveness gate: one indexed `SELECT` on `dispatch_workers` (fresh < 45s) | **~5–10 ms**; miss ⇒ `no_worker` ⇒ fallthrough |
| enqueue INSERT, `deadline_at = now() + 45s` | ~10 ms |
| worker (parked in long-poll) claims | ≤ ~1.7 s; not claimed by **5 s** ⇒ `claim_timeout` ⇒ fallthrough |
| agy run (worker timeout = deadline − now − 3s ≈ 41 s) | typical 8–20 s |
| result POST + Hub poll pickup (250 ms then 500 ms granularity) | ≤ ~0.8 s |
| **dispatch overhead vs Phase 2 local** | **≈ 2–3 s** on a served turn |
| **worst case: full budget spent ⇒ fallthrough** | metered chain still gets 110 − 45 = **65 s — numerically identical to today** |

**A dead worker costs a chat turn ~5–10 ms** — one DB read, agreed on by all
three instances instantly. That beats the "bounded few seconds" bar by three
orders of magnitude and is the single most important number in this design.

**Long-poll, not short-poll:** `waitMs=25s` yields ~3,456 worker requests/day vs
43,200 at 2s polling (12.5× fewer) with ≤1s pickup. 25s sits far under the 120s
ceiling, and because the claim doubles as the heartbeat it sets the liveness
window at 25+15 = 40s. A 90s poll would leave a dead worker looking alive for
~105s, during which every turn pays the 5s claim timeout instead of the 5ms gate.

**Flags:** `AGY_CHAT_ENABLED` keeps its Phase 2 meaning ("chat may spend the
allotment"). New `AGY_DISPATCH_ENABLED` selects transport: unset ⇒ Phase 2 local
behavior verbatim (which on Cloud Run auth-fails and self-disables via cooldown);
`true` ⇒ desktop dispatch. `no_worker` deliberately does **not** trip the
cooldown — detection is free, and cooling would blind the Hub to the worker's
return for 5 minutes for no saving.

---

## 6. Observability

- **Ledger, zero migration:** served turns keep the existing `ai_runs` write,
  now with `meta:{dispatch:true, jobId, workerId}`. Discarded/late results are
  written by the result route with `meta.discarded:true`, so allotment accounting
  stays truthful even when the user saw Gemini. "How often does dispatch eat a
  turn?" is `WHERE error_class IN ('no_worker','claim_timeout','lease_expired')`.
- **`request_id`** threads the chat turn → job row → both ledger rows → telemetry.
- **`/api/admin/dispatch-health`**: cheap by default, `?probe=1` to spend and verify.
- **Telemetry:** new `dispatch_enqueued | dispatch_claimed | dispatch_result |
  dispatch_cancelled | dispatch_expired` events on the existing `emit` seam.

---

## 7. Failure modes

| # | Mode | Detection | Blast radius | Recovery |
|---|---|---|---|---|
| 1 | Worker offline (asleep, reboot, Docker down, logged out) | liveness gate, ≤40 s to notice | ~5 ms/turn; all turns metered | watchdog restarts; no cooldown to wait out |
| 2 | Worker died <40 s ago (gate still green) | claim timeout at 5 s | ≤5 s/turn for ≤40 s | gate goes stale on its own |
| 3 | Worker crashes mid-run | missed heartbeat ⇒ lease lapses ≤25 s; wait-loop fails fast | one turn +≤25 s, then metered (≥84 s left) | job terminal, **never re-run** |
| 4 | Hub instance dies mid-wait | client request drops | one turn; desktop finishes uselessly | late result still lands ⇒ spend recorded; sweep scrubs content |
| 5 | Deploy recycles instances | — | queue/leases live in Postgres | long-polls reconnect; liveness back ≤25 s |
| 6 | agy auth dies on desktop | worker posts `errorClass:'auth'` | 30-min cooldown; turns metered | re-mint on desktop — **no Hub deploy needed**, a strict improvement over Phase 1 |
| 7 | Desktop VPN moves egress off residential IP | `auth` errors (looks like #6) | as #6 | runbook: check VPN before re-minting |
| 8 | `AGY_WORKER_SECRET` unset/mismatched | 503/401; liveness decays | as #1 | 503-when-unset is also the kill switch |
| 9 | Tables missing (migrate failed) | `42P01` caught ⇒ `no_worker` | chat unaffected | next cold start re-runs migrate |
| 10 | Result POST lost, worker retries | CAS ⇒ `duplicate` | none — one transition, one ledger row | automatic |
| 11 | Hub cancels while worker mid-run | heartbeat delivers cancel | double spend for that turn | recorded honestly; frequency visible ⇒ tune budget |
| 12 | Stale worker after deploy | SHA pair on dispatch-health (needs the `GIT_SHA` fix) | older-but-working | nightly update task |

**The dominant real-world failure will not be a lease race — it will be the
worker simply not being there.** The 5 ms gate makes absence cheap per turn, but
if the desktop is absent 40% of the time this phase delivers 60% of its value,
and the honest fix is operational (power settings, auto-logon, or a second
worker machine), not architectural.

---

## 8. Rollout

Each step independently verifiable; real non-draft PRs per CLAUDE.md.

1. **PR 1 — substrate, dark.** Tables + migrate blocks, `/api/worker/*` routes,
   middleware exclusion, `lib/agy-dispatch.ts`, the `GIT_SHA` deploy line, unit
   tests (CAS guards, SKIP LOCKED under concurrent transactions, the four result
   outcomes, scrub-on-terminal). `AGY_DISPATCH_ENABLED` unset ⇒ **zero behavior
   change**. Verify: CI green; tables exist; `/api/worker/claim` returns 503;
   dispatch-health shows "no workers".
2. **PR 2 — worker runtime.** `dispatch-worker.ts`, `scripts/agy-worker/`,
   runbook. Verify: set the secret both sides, start the worker, dispatch-health
   goes green with a version pair.
3. **Probe end-to-end, still dark to users:** `dispatch-health?probe=1` round-trips
   a marker job on the residential IP.
4. **Flip `AGY_DISPATCH_ENABLED=true`.** Verify: live turn shows the Antigravity
   badge; ledger rows carry `jobId`; watch fallthrough and discard rates 48 h.
5. **Later — `work_item`:** flip the issue slot on. No schema, queue, or API
   change; the semantics are pre-provisioned above.

**Kill switches, strongest first:** unset `AGY_CHAT_ENABLED` (byte-identical
pre-Phase-2 chat) → unset `AGY_DISPATCH_ENABLED` (dispatch dark) → unset
`AGY_WORKER_SECRET` (routes 503) → stop the desktop container. All four are
env/ops actions requiring **no deploy**.

---

## 9. Rejected alternatives

| Rejected | Why it loses |
|---|---|
| **Push to the desktop** (Cloud Tasks, Pub/Sub push, webhook) | The desktop is NAT'd with no inbound path. Disqualified before merit. |
| **Tunnel** (Tailscale, Cloudflare, ngrok) | Adds a third-party dependency and credential to the trust boundary, still needs a queue for crash-safety and multi-instance correctness, and inverts the outbound-only posture for no win over a 1 s pickup. |
| **WebSocket/SSE from the worker** | The 120 s request ceiling turns any persistent connection into reconnect-managed long-polling; with 1–3 instances a push landing on instance A still reaches the waiting request on B *through Postgres anyway*. |
| **LISTEN/NOTIFY** | Not in the stack; saves ~0.5 s median against a 45 s budget for new connection-lifecycle machinery that pooled connections handle badly. |
| **Google Chat as transport** | Seconds-to-minutes, no delivery guarantee, posts as the operator, and puts prompt content in a human channel. |
| **GitHub as the queue** | Canon scopes GitHub to code artifacts; rate limits and multi-second latency disqualify it for chat turns. |
| **Run the full Hub image as the worker** | Drags DB credentials and Artifact Registry auth onto the desktop for one file's worth of reuse. *(Rejected independently by two of three designs.)* |
| **Relay a fresh token to Cloud Run continuously** | The blocked operation *is* the refresh from a datacenter IP. Hash-identical secrets already proved the secret is not the problem — a relayed token dies at its next refresh. Loses to the physics. |
| **HMAC capability tokens for worker auth** | 5-min TTL fights long-polls and long runs; the jti ledger is per-process so cross-instance replay safety needs the DB anyway — at which point the sanctioned `cron-auth` shared secret does the same job for one trusted machine with a tenth of the parts. |
| **Retry chat turns on lease expiry** | Guaranteed duplicate allotment spend for an answer the user already has. At-most-once is a correctness decision, not a simplification. |

---

## Open questions (flagged, not hand-waved)

1. **Does one agy token tolerate concurrent runs?** Unverified. Until tested, the
   worker executes at most one agy process at a time (chat takes priority; a
   long `work_item` never starves a chat turn because chat falls through rather
   than waits). If concurrency works, the chat/issue slots can run truly parallel.
2. **Do in-request timers hold under Cloud Run CPU throttling?** The wait-loop
   arithmetic assumes 250–500 ms poll timers fire on schedule inside a request.
   True for in-request awaits, but worth confirming under load before trusting
   the 45 s envelope.
3. **Worker availability** is now an SLA input. Worth measuring during step 4's
   48-hour watch before deciding whether a second worker machine is warranted.
