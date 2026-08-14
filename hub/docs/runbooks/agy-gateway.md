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

## Rotation / revocation

The refresh token is durable until revoked. To kill it: `agy logout` on the
desktop that minted it (or revoke the Google OAuth grant), then mint + store a
fresh one. Cloud Run picks up `:latest` on the next instance start — force with
a new revision (`gcloud run services update hub --region us-central1 --no-traffic --tag rotate` or just redeploy).
