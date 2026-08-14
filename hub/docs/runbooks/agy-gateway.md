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
fresh one. Cloud Run picks up `:latest` on the next instance start — force with
a new revision (`gcloud run services update hub --region us-central1 --no-traffic --tag rotate` or just redeploy).
