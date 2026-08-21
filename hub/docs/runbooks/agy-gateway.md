# agy execution gateway (Phase 1)

`lib/agy.ts` runs single headless prompts through the Antigravity CLI (`agy`)
on the **subscription allotment** (consumer OAuth) instead of metered API
billing. Phase 0 (`scripts/agy/` at the repo root) proved the token replay
assumption; this runbook covers operating the production gateway.

> **Standing caveat:** driving the consumer OAuth token headless rides
> undocumented behavior and may breach Antigravity's terms. The internal
> surface can change without notice. If the gateway starts failing with
> `auth` errors that a fresh token does not fix, assume upstream moved and
> fall back to the metered providers (`lib/gemini.ts` / `lib/claude.ts`).

> ## ⚠️ Read this before debugging an `auth` failure on Cloud Run
>
> **The token does not replay from Cloud Run, and no amount of re-minting will
> fix it.** Established 2026-08-14/15 by three measurements: the Secret Manager
> copy and the desktop file are a **perfect hash match**; the Phase 0 clean-room
> container **PASSES on the desktop** (keyring-less Linux, same image, same
> token); the same token **auth-fails from Cloud Run**. The clean room reproduces
> production in every respect except the egress IP, so the conclusion is that
> Google refuses consumer-OAuth refresh from datacenter address space. It is a
> strong inference rather than a confirmed mechanism — but re-minting, rotating,
> or re-uploading the secret will not change it.
>
> **Correct posture today:** leave `AGY_CHAT_ENABLED` off in production. Chat
> rides the metered chain, which is this runbook's intended fallback working as
> designed — not an outage. The `?probe=1` path will report `errorClass:'auth'`
> from Cloud Run; that is now an *expected* result, not a regression.
>
> **The fix** is Phase 2.5 — the allotment runs on the desktop (residential
> IP) with the Hub dispatching work to it over a Postgres queue: designed in
> [`../architecture/DESKTOP_DISPATCH_2026-08-15.md`](../architecture/DESKTOP_DISPATCH_2026-08-15.md),
> substrate + worker shipped (see § Phase 2.5 below). Local/desktop use of the
> gateway is unaffected and still works.

## How it works

- The binary is provisioned at **runtime**, lazily: the first real run per
  instance downloads it (sha512-verified against the release manifest) to
  `/tmp/agy-cli/agy`. It is deliberately NOT installed at image build time —
  a build-time download coupled `gcloud run deploy` to the undocumented
  third-party release server and broke the deploy pipeline on 2026-08-14.
  `AGY_CLI_DISABLE_AUTO_UPDATE=true` (Dockerfile) keeps a provisioned binary
  from replacing itself mid-request. `scripts/install-agy.mjs` still exists
  for local prebakes (`AGY_CLI_PATH` and `/usr/local/bin/agy` are checked
  before the runtime path).
- **Instance memory cost.** Cloud Run's `/tmp` is tmpfs, so the provisioned
  binary lives in RAM: ~206MB (CLI 1.1.13) held for the life of the instance,
  against the 1Gi limit in `service.yaml`. The ~55MB download archive is
  deleted right after extraction, so the steady-state cost is the binary
  alone. If instances start OOMing after agy adoption, raise the memory limit
  rather than trimming elsewhere — this cost is per-instance and unavoidable
  while provisioning is lazy.
- At request time the gateway materializes the OAuth token file from the
  `AGY_OAUTH_TOKEN` env var to `~/.gemini/antigravity-cli/antigravity-oauth-token`
  (0600, never overwriting an existing file), forces file-based token storage
  via `SSH_*` env vars (no keyring/D-Bus on Cloud Run), and runs
  `agy -p … --output-format json` under a real pseudo-terminal (`script -qec`).
- Empty output is always failure (agy's silent non-TTY drop, upstream #76/#408);
  exit codes are never trusted. Failures carry a typed `agyError` field:
  `not_configured | not_installed | auth | empty | timeout | parse | spawn`.

## One-time setup (new environment or token rotation)

1. **Mint the token on a desktop.** On Windows PowerShell, force file storage
   first, then log in (browser flow):

   ```powershell
   $env:SSH_CONNECTION = "127.0.0.1 0 127.0.0.1 22"
   $env:SSH_CLIENT     = "127.0.0.1 0 22"
   agy logout
   agy login
   Get-Content "$env:USERPROFILE\.gemini\antigravity-cli\antigravity-oauth-token"
   ```

   On Linux/macOS the file lands at `~/.gemini/antigravity-cli/antigravity-oauth-token`.
   Sanity: the JSON must contain `"refresh_token"` and `"auth_method": "consumer"`.

   > **⚠️ Mint LAST, and never `agy logout` on that desktop afterwards.**
   > `agy logout` revokes the OAuth grant itself, which kills every exported
   > copy of the token — including the one in Secret Manager. The server then
   > fails with `auth` errors that look like replay breakage but are really
   > self-inflicted revocation. Do all desktop experimenting (including
   > re-login cycles and Phase 0 replay tests) BEFORE exporting the token, and
   > from then on treat `agy logout` on that machine as "rotate the prod
   > secret" (see Rotation below). Note also that the `SSH_*` env vars are
   > per-terminal: a shell without them uses the OS keyring, a separate
   > session from the token file — alternating between the two looks like
   > agy randomly logging you out.

2. **Store it in Secret Manager** (project `rxfit-automation`):

   ```bash
   gcloud secrets create hub-agy-oauth-token --replication-policy=automatic
   gcloud secrets versions add hub-agy-oauth-token --data-file=antigravity-oauth-token
   ```

3. **Attach it to the Cloud Run service** (one-time; persists across deploys —
   deploy.yml never touches secrets):

   ```bash
   gcloud run services update hub --region us-central1 \
     --update-secrets AGY_OAUTH_TOKEN=hub-agy-oauth-token:latest
   ```

## Verifying

- Cheap check (config + binary, no tokens spent):
  `GET /api/admin/agy-health` (admin only).
- Full end-to-end replay probe (spends a few tokens):
  `GET /api/admin/agy-health?probe=1` — runs a marker prompt and reports
  `markerVerified`, the model used, latency, and `cacheReadTokens`.

## Failure classes

| `errorClass` | Meaning | Action |
|---|---|---|
| `not_configured` | No `AGY_OAUTH_TOKEN` and no token file | Do the one-time setup above |
| `install` | Runtime binary provisioning failed (manifest/download/sha512) | Check egress to the release server from Cloud Run; retry (memo clears on failure); or prebake via `scripts/install-agy.mjs` + `AGY_CLI_PATH` |
| `not_installed` | Binary missing on an unsupported platform | Set `AGY_CLI_PATH` to a manually installed binary |
| `auth` | Token did not replay; agy fell back to interactive OAuth | Re-mint on a desktop and rotate the secret (step 1–2). If a fresh token still fails, upstream likely changed — stop using the gateway |
| `empty` | Silent non-TTY drop or dead run | Check `script` exists in the image; retry once; treat repeats as an incident |
| `timeout` | Run exceeded `AGY_TIMEOUT_MS` (default 120s) | Raise per-call `timeoutMs` for long prompts, or investigate upstream latency |
| `parse` | Output had no/unrecognizable JSON envelope | agy's envelope shape changed — update `interpretEnvelope()` in `lib/agy.ts` |
| `spawn` | Could not start the pty runner | `script` binary missing from the image (bsdutils) |

## Phase 2 — chat traffic on the allotment (`AGY_CHAT_ENABLED`)

`lib/agy-chat.ts` wires the gateway into the chat rotation (`lib/gemini.ts`),
**off by default**. When enabled, non-EXA chat turns try agy FIRST — every turn
it serves is zero metered API spend — and fall through to the normal Gemini
chain on any failure. Guardrails, in the order they engage:

- **EXA mode is excluded.** The EXA toggle stays on Claude Fable 5 (operator
  routing decision in `shouldUseClaude`); agy never sees an `exa_search` turn.
- **Cold instances don't stall chat.** If the binary isn't provisioned yet the
  turn serves from Gemini and `warmAgyBinary()` downloads it in the background;
  agy starts serving from the next turn.
- **One bounded attempt.** `AGY_CHAT_TIMEOUT_MS` (default 45 000 = the ladder's
  per-attempt rung, clamped 5–90 s) caps the run, leaving Gemini most of the
  110 s client budget on failure.
- **Fail-safe fallthrough.** agy emits nothing until its run completes, so a
  failure never leaves a partial answer on the wire — the Gemini chain starts
  clean. A failed gateway cools down (auth-class 30 min, else 5 min) so it
  taxes at most one request per window.
- **Latency tradeoff to know about:** agy does not stream — the full answer
  lands at once, typically tens of seconds in. Interactive feel degrades vs.
  Gemini's token streaming; that is the price of the free allotment.

Rollout (after the `?probe=1` health probe is green):

```bash
gcloud run services update hub --region us-central1 --update-env-vars AGY_CHAT_ENABLED=true
```

Rollback is the reverse (`--remove-env-vars AGY_CHAT_ENABLED`); with the flag
unset the rotation is byte-identical to pre-Phase-2. Watch `ai_complete`
events with `provider: "agy"` vs `ai_fallback` events with `from: "agy"` in
Cloud Logging (or /admin/ai-health) to judge how much traffic the allotment
is actually absorbing.

Every agy attempt — chat turn or health probe, success or failure — also
lands as a row in the `ai_runs` ledger (`lib/runs.ts`): engine, model, typed
error class, latency, token usage, and a prompt fingerprint (length + sha256 —
never the text; same provenance-not-content contract as `ai_action_log`).
`SELECT * FROM ai_runs ORDER BY created_at DESC LIMIT 20` is the quickest
"is the allotment actually serving?" check, and the Phase 3 panel feed reads
from here.

## Rotation / revocation

The refresh token is durable until revoked. To kill it: `agy logout` on the
desktop that minted it (or revoke the Google OAuth grant), then mint + store a
fresh one.

**Rolling a new token onto the service — the traffic trap.** Cloud Run resolves
`secretKeyRef` env vars at *instance start*, and `ensureTokenFile()` returns
early when a token file already exists, so a warm instance keeps serving the
credential it materialized on its first run — forever. `--min-instances=1`
guarantees one such instance is always warm. A rotation therefore requires a
revision that actually **takes traffic**; an earlier version of this runbook
suggested `--no-traffic --tag rotate`, which creates a revision serving 0% and
leaves every probe hitting the OLD token:

```bash
gcloud run services update hub --region us-central1 \
  --update-secrets AGY_OAUTH_TOKEN=hub-agy-oauth-token:latest
gcloud run services update-traffic hub --region us-central1 --to-latest
gcloud run services describe hub --region us-central1 --format='value(status.traffic)'
```

Confirm the new revision is at 100%, then verify delivery *before* spending a
probe: `GET /api/admin/agy-health` returns `config.credential.env.sha256` (a
12-hex fingerprint of the bytes this instance holds) — compare it to
`sha256sum` of your local token file, truncated to 12 characters. If
`config.credential.file` is present with a *different* hash, that instance is
serving a stale on-disk copy and its result is meaningless: roll again.

## Phase 2.5 — desktop dispatch (`AGY_DISPATCH_ENABLED`)

The transport that makes `AGY_CHAT_ENABLED` viable on Cloud Run: chat turns are
enqueued in Postgres (`dispatch_jobs`) and executed by the desktop worker
(`scripts/agy-worker/` — setup, slot policy, and supervision live in its
README). Architecture + failure modes: `docs/architecture/DESKTOP_DISPATCH_2026-08-15.md`.

- **Enable:** `AGY_WORKER_SECRET` in Secret Manager + the desktop `.env`
  (byte-identical), worker running (dispatch-health shows it fresh), then
  `AGY_DISPATCH_ENABLED=true` alongside `AGY_CHAT_ENABLED=true`.
  > **If the update says "serving 0 percent of traffic":** your flip raced a
  > deploy.yml run — its blue-green flow pins traffic during the candidate
  > window, so out-of-band revisions park at 0% (happened live 2026-08-20).
  > Usually self-heals: the workflow's final promote is `--to-latest`, which
  > picks up your (newer) revision. Verify with
  > `gcloud run services describe hub --region us-central1 --format="value(status.traffic)"`
  > — expect the latest revision at 100%; if it still shows an older pinned
  > revision once the Actions run finishes, promote manually with
  > `gcloud run services update-traffic hub --region us-central1 --to-latest`.
- **Verify:** `GET /api/admin/dispatch-health` (admin) — cheap: worker
  liveness/version pair, queue depths, last 20 jobs. `?probe=1` round-trips a
  marker job through enqueue → desktop claim → agy on the residential IP →
  result. That probe is the production replay test of the whole phase.
- **Kill switches, strongest first (all env-only, no deploy):** unset
  `AGY_CHAT_ENABLED` (pre-Phase-2 chat, byte-identical) → unset
  `AGY_DISPATCH_ENABLED` (dispatch dark) → unset `AGY_WORKER_SECRET`
  (worker routes 503) → stop the desktop container.
- **Dispatch failure classes** (in `ai_runs.error_class` and dispatch-health):
  `no_worker` (desktop offline — costs each turn ~5ms, no cooldown, metered
  serves), `queue_full` (backpressure refusal), `claim_timeout` (worker alive
  but wedged, 5s bound), `lease_expired` (worker died mid-run, ≤25s bound),
  `abort` (client left / Hub cancel). None of these cool the allotment path;
  worker-reported `auth` still gets the 30-min tier — re-mint on the desktop,
  **no Hub deploy needed** (the token never leaves the machine).

## Push alerting (hardening move 1)

Every dispatch failure degrades silently into metered spend, so failure has a
push path instead of waiting to be noticed on dispatch-health (which also now
counts a dead worker against `healthy` whenever dispatch is enabled):

- **Mechanism:** `.github/workflows/dispatch-alert.yml` fires hourly and calls
  `POST /api/cron/dispatch-alert` (constant-time `CRON_SECRET`; `/api/cron` is
  middleware-excluded like `/api/worker`). It targets the Cloud Run `.run.app`
  URL directly — never `hub.casatrejo.com`, whose Cloudflare front challenges
  CI curls (the false-failure class deploy.yml refuses to gate on). The tick
  is cheap — it never runs `?probe=1` — and also guarantees the hourly queue
  reap + content sweep (now advisory-locked in `sweepStale`).
- **Conditions** (`hub/lib/dispatch-alerts.ts`): worker stale while dispatch
  is enabled; the newest 3 agy runs in `ai_runs` all failed (classes named);
  allotment collapse — metered chat serving with zero allotment successes in
  24h (inert until the metered chains ledger, hardening move 3).
- **Delivery:** Google Chat, posted as the operator with the pinned
  `— via HUB` tag, to `ALERT_CHAT_SPACE` (env) or the first scheduled report
  that already posts to a space. **No space configured, or the post fails →
  the workflow run fails, and GitHub's failure email is the alert.** An
  unchanged condition re-posts every 6h (the window keys off the last
  *delivered* post, so a flapping worker damps to one alert per window
  instead of posting on every flip); recovery posts once, and only when the
  clear is affirmative — evidence merely aging out of a window records the
  state change silently. State lives in `event_log` (`dispatch.alert` rows),
  never in-memory.
- **One-time setup:** add repository secret `CRON_SECRET` (GitHub → Settings →
  Secrets and variables → Actions) with the same value the Cloud Run service
  holds. Optionally set `ALERT_CHAT_SPACE=spaces/XXXX` on the service to pick
  the space; until then the GitHub failure email carries the alerts. Then run
  the workflow once by hand (Actions → "Dispatch alert tick" → Run workflow)
  to confirm the endpoint answers — and, if you make it fail (wrong secret),
  that the failure notification email actually reaches you.
- **Silence it:** disable the workflow in the Actions tab (or delete the
  `CRON_SECRET` repo secret — every run then fails loudly, which is the
  point: this alarm fails toward noise, not toward silence).
