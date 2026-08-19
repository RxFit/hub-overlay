# agy-worker — the desktop dispatch worker (Phase 2.5)

Runs the subscription allotment on this desktop's **residential IP** — the one
place the consumer OAuth token refreshes (Google refuses datacenter IPs; see
`hub/docs/architecture/DESKTOP_DISPATCH_2026-08-15.md`). The Hub on Cloud Run
enqueues chat turns in Postgres; this container long-polls them **outbound**
over HTTPS, runs them through `hub/lib/agy.ts` verbatim, and posts results.

Nothing sensitive beyond the worker secret lives here: no database
credentials, no GCP auth. The OAuth token stays in
`%USERPROFILE%\.gemini\antigravity-cli` (mounted read-write so agy's in-place
refresh persists to the host — one rotating credential for desktop CLI and
worker alike). **Never `agy logout` on this machine** — it revokes the grant
globally, production included.

## Setup (once)

1. Generate a secret and put the SAME value in both places:
   ```powershell
   # generate
   -join ((1..64) | % { '{0:x}' -f (Get-Random -Max 16) })
   ```
   ```bash
   # Hub side (Cloud Shell): store + attach
   printf '%s' '<the secret>' | gcloud secrets create hub-agy-worker-secret --data-file=-
   gcloud run services update hub --region us-central1 \
     --update-secrets AGY_WORKER_SECRET=hub-agy-worker-secret:latest
   ```
2. Desktop side:
   ```powershell
   cd C:\hub-overlay
   git pull origin master
   powershell -ExecutionPolicy Bypass -File scripts\agy-worker\install.ps1
   notepad scripts\agy-worker\.env    # paste the same secret, save
   powershell -ExecutionPolicy Bypass -File scripts\agy-worker\update.ps1
   ```
3. Verify from the Hub (admin): `GET /api/admin/dispatch-health` shows the
   worker fresh with its git SHA; `?probe=1` round-trips a real marker job.
4. Go live: `gcloud run services update hub --region us-central1 --update-env-vars AGY_DISPATCH_ENABLED=true`
   (with `AGY_CHAT_ENABLED=true` already set, chat turns now ride the
   allotment; kill switches in the runbook).

## Slot policy

Set by the 2026-08-19 concurrency test on this machine — **PARALLEL_OK**
(three simultaneous runs on one token, zero auth/rate failures). Slots may run
in parallel: `WORKER_CHAT_SLOTS=1` serves chat; raise `WORKER_WORK_SLOTS` when
the panel phase starts enqueueing `work_item` jobs.

## Supervision

- `restart: unless-stopped` restarts a crashed worker.
- Scheduled Task **AgyWorkerWatchdog** (logon + every 5 min) restarts Docker
  Desktop + the container after reboots; log at `%USERPROFILE%\agy-worker\watchdog.log`.
- Scheduled Task **AgyWorkerUpdate** (daily 04:00) fast-forwards to
  origin/master and rebuilds — the same artifact CI gated. Rollback:
  `update.ps1 -Sha <known-good>`.
- Honest dependency: Docker Desktop needs a **logged-in session**. Locked
  screen fine; logged out = worker offline = chat silently rides metered
  (visible on dispatch-health, costs each turn ~5ms).
