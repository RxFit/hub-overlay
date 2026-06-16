# EXECUTION TASKLIST — Hub → GCP Migration + Security Remediation
<!-- Paste into IDE. Execute phases in order. Each task: [ ] checkbox, command(s), done-when. -->
<!-- Context docs in repo root: PAPERCLIP_INTEGRATION_AUDIT_2026-06-12.md, CLOUDRUN_ENV_MIGRATION_PLAN.md, RAILWAY_TO_CLOUDRUN_MIGRATION_SCOPE.md -->
<!-- Generated 2026-06-12. State: code fixes + scaffolding + credential scrubbing already done. -->

## PHASE 0 — Discovery gate (10 min) — DO FIRST, affects Phase 2 & 5

- [ ] **0.1 Check what database the Cloud Run Paperclip uses.**
      GCP Console → Cloud Run → `rxfit-paperclip-11747747730` → Revisions → Variables.
      Inspect `DATABASE_URL`.
      - If host is `metro.proxy.rlwy.net` → it SHARES the Railway Postgres.
        Phase 2.1 must update this var in the same change; Phase 5.4 (delete Railway
        Postgres) is BLOCKED until Phase 6.3 (move Paperclip data to Cloud SQL).
      - If host is Cloud SQL or other → Railway Postgres is isolated; Phase 5 is unblocked.
      Done when: you know which case you're in. Record it here: `DATABASE_URL host = ______`

## PHASE 1 — Validate the integration fixes (30 min) — local machine

- [ ] **1.1 Typecheck + build** (sandbox couldn't run this — OneDrive staleness):
      ```powershell
      cd "C:\Users\danie\OneDrive\HQ Desktop\Hub Overlay\hub"
      npm install
      npx tsc --noEmit
      npm run build
      ```
      Done when: both exit 0. If tsc errors in `app/page.tsx`, `lib/paperclip.ts`,
      `lib/zod-schemas.ts`, `app/api/paperclip/**` — those are the audit-fix files; fix or report.

- [ ] **1.2 Smoke-test the repaired chat→Paperclip pipeline** (local `npm run dev` or current prod):
      | Chat input | Expected (was broken before) |
      |---|---|
      | "create an issue to test the pipeline" | real issue ID returned, visible in Paperclip inbox |
      | "show agent status" | agent list renders (was 403) |
      | "move issue <ID> to in review" | status ACTUALLY changes in Paperclip (was silent no-op) |
      | "show recent runs" | runs or clean empty-state (endpoint didn't exist before) |
      | "reassign issue <ID> to CTO" | assignee changes |
      | Execution Feed (right panel) | populates with issues/agents (was empty) |
      | Business Manager / CEO Pulse | not all departments "DRIFTING" |
      Done when: all 7 pass.

- [ ] **1.3 Redeploy current Railway Hub** with the fixes (interim, before GCP move):
      push to the repo Railway builds from, confirm deploy goes green.

## PHASE 2 — Credential rotation (30 min) — ALL THREE WERE PUBLIC IN THE REPO

- [ ] **2.1 Railway Postgres password** (`PjJM…[REDACTED]` — internet-reachable
      via `metro.proxy.rlwy.net:39263`):
      Railway → project → Postgres service → regenerate credentials.
      Then update every consumer:
      - Railway Paperclip service: `DATABASE_URL` var (or set it to reference `${{Postgres.DATABASE_URL}}`)
      - ⚠️ Cloud Run Paperclip `DATABASE_URL` — ONLY if Phase 0.1 = shared
      Done when: both Paperclip instances respond at `/api/health` after redeploy AND
      `psql "postgresql://postgres:OLDPASSWORD@metro.proxy.rlwy.net:39263/railway" -c 'select 1'` FAILS.

- [ ] **2.2 Paperclip board password** for `Danny@rxfitatx.com` (was `[REDACTED-PAPERCLIP-PW]` in 5 scripts):
      Change in the Paperclip UI on BOTH instances (Cloud Run + Railway).
      Then update `PAPERCLIP_AUTH_PASSWORD` on the Hub's Railway service (and later the Cloud Run Hub secret).
      Done when: Hub still authenticates (feed loads) and old password is rejected at sign-in.

- [ ] **2.3 `danny-rxfit-admin` account password** (was `[REDACTED-ADMIN-PW]` in `scratch_paperclip/set-password.js`):
      If that account is active on any instance, reset it:
      `$env:PAPERCLIP_DB_URL="<new url>"; $env:NEW_PASSWORD="<new>"; node scratch_paperclip/set-password.js`
      Done when: old password rejected.

- [ ] **2.4 If this folder is a pushed git repo:** old secrets live in history.
      Either accept (rotated = dead) or scrub: `git filter-repo --replace-text <(echo 'PjJM…[REDACTED]==>REDACTED')` etc.

## PHASE 3 — GCP foundation (1–2 h)
<!-- Runbook automates these: scripts/gcp-migrate-hub.ps1 -Step <name>. Set $env:GCP_PROJECT first. -->

- [ ] **3.1 Choose/confirm GCP project** (existing `semantic-brain-desktop` or a new `rxfit-hub`):
      `$env:GCP_PROJECT = "<project-id>"`
- [ ] **3.2 Enable APIs + Artifact Registry:** `.\scripts\gcp-migrate-hub.ps1 -Step apis`
- [ ] **3.3 Cloud SQL Postgres 16:** `.\scripts\gcp-migrate-hub.ps1 -Step sql`
      Then in Cloud SQL Studio / psql: `CREATE EXTENSION IF NOT EXISTS vector;`
      NOTE: the Hub never had a DB on Railway (no DATABASE_URL existed!) — this is a
      fresh schema, no data to migrate. Run from `hub/`:
      ```powershell
      $env:DATABASE_URL="postgresql://postgres:<pw>@<cloud-sql-ip>:5432/hub"
      npx drizzle-kit migrate
      ```
      Done when: tables exist (`document_chunks`, `hub_users`, event tables…).
- [ ] **3.4 Secrets into Secret Manager:** `.\scripts\gcp-migrate-hub.ps1 -Step secrets`
      Values needed: NEXTAUTH_SECRET, GOOGLE_CLIENT_SECRET, GEMINI_API_KEY, EXA_API_KEY (new — was
      never set on Railway), PAPERCLIP_API_KEY, PAPERCLIP_AUTH_PASSWORD (post-rotation),
      GOOGLE_SERVICE_ACCOUNT_KEY, DATABASE_URL (Cloud SQL, use the connector socket form:
      `postgresql://postgres:<pw>@localhost/hub?host=/cloudsql/<project>:us-central1:hub-pg`).

## PHASE 4 — Deploy Hub to Cloud Run (1 h)

- [ ] **4.1 Build + deploy image:** `.\scripts\gcp-migrate-hub.ps1 -Step build`
      (uses `hub/cloudbuild.yaml`; NEXT_PUBLIC_* are baked at build time — to change them, rebuild.)
- [ ] **4.2 Attach runtime config:** `.\scripts\gcp-migrate-hub.ps1 -Step deploy`
      (Cloud SQL connector + secrets + env vars. Drops the dead vars on purpose:
      PORT, NODE_ENV, GOOGLE_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, HUB_ROLES_SHEET_ID,
      NEXT_PUBLIC_KPI_SHEET_ID, GOOGLE_CHAT_WEBHOOK_URL, GOOGLE_MAPS_API_KEY.)
- [ ] **4.3 Google OAuth:** add the temporary `https://hub-….run.app/api/auth/callback/google`
      redirect URI in the GCP OAuth client (console → Credentials) so you can test pre-DNS.
- [ ] **4.4 Smoke-test on the run.app URL:** `.\scripts\gcp-migrate-hub.ps1 -Step verify`
      Rerun the Phase 1.2 table PLUS: semantic search returns results (first time ever —
      DB now exists) and "search the web for …" works (EXA_API_KEY now set).

## PHASE 5 — Cutover + Railway retirement (1 h + DNS propagation)

- [ ] **5.1 Map domain:** `.\scripts\gcp-migrate-hub.ps1 -Step domain` → update
      `hub.casatrejo.com` DNS record as instructed; wait for managed cert.
- [ ] **5.2 Confirm prod on Cloud Run:** login + smoke tests via https://hub.casatrejo.com.
- [ ] **5.3 Pause (don't delete) the Railway Hub service.** Keep 7 days as rollback. Then delete.
- [ ] **5.4 Retire Railway Paperclip** (`paperclip-production-4394`):
      - Export anything historical first: `pg_dump` its Postgres.
      - Delete the service. Delete its Postgres ONLY IF Phase 0.1 said "isolated";
        if shared with Cloud Run, BLOCKED until Phase 6.3.
- [ ] **5.5 Cleanup:** remove `paperclip-production-4394.up.railway.app` and
      `hub-production-a923.up.railway.app` from `BETTER_AUTH_TRUSTED_ORIGINS`
      (railway/paperclip/docker-entrypoint.sh) and `allowedHostnames`
      (railway/paperclip/config.json) — or archive the whole `railway/` folder.

## PHASE 6 — Paperclip hardening (post-migration, half day)

- [ ] **6.1 Pin the Paperclip version** wherever the Cloud Run Paperclip is built:
      `pnpm add -g paperclipai@2026.609.0` (the Hub's fixed API contract assumes this version family).
- [ ] **6.2 Map `api.paperclip.casatrejo.com`** to the Cloud Run Paperclip; then update in ONE commit:
      `PAPERCLIP_BASE_URL` + `NEXT_PUBLIC_PAPERCLIP_URL` (Hub secrets/build args → rebuild via 4.1),
      and Paperclip's `publicBaseUrl`/`allowedHostnames`/trusted origins.
- [ ] **6.3 (Only if Phase 0.1 = shared)** Move Paperclip's data off Railway Postgres:
      `pg_dump` → new Cloud SQL database (`paperclip` db on `hub-pg` instance is fine) →
      update Cloud Run Paperclip `DATABASE_URL` → verify → then finish 5.4.
- [ ] **6.4 Storage durability:** Cloud Run Paperclip uses `local_disk` — attachments are lost on
      instance restarts. If agents exchange files, switch Paperclip storage to GCS (S3-interop HMAC).
      If not, accept and note it.
- [ ] **6.5 Master key:** ensure the Cloud Run Paperclip deployment writes
      `PAPERCLIP_MASTER_KEY` to `/paperclip/secrets/master.key` (the entrypoint in
      `railway/paperclip/docker-entrypoint.sh` is already fixed — reuse it if Cloud Run builds from the same files).

## PHASE 7 — Instance consolidation decision (open from earlier discussion)

- [ ] **7.1 Decide:** keep local Paperclip (127.0.0.1:3100) as Antigravity's sandbox, or move
      Antigravity workflows to the Cloud Run org and retire the local watchdog scheduled tasks
      (`scripts/paperclip/*.ps1`).
- [ ] **7.2 Update AGENTS.md** to match the decision (a two-instance warning block is already in place).

---

### Already completed (this session — no action needed)
- Hub↔Paperclip API contract fixed end-to-end (proxy, endpoints, field vocab, response shapes,
  runs aggregation, priority mapping) — see PAPERCLIP_INTEGRATION_AUDIT_2026-06-12.md
- Plaintext credentials scrubbed from 11 files (now env-var-driven)
- `docker-entrypoint.sh` master-key bug fixed; Dockerfile healthcheck fixed (`/api/health`)
- Railway Paperclip `publicBaseUrl` corrected; DB credential removed from both config.json files
- Deployment scaffolding: `hub/cloudbuild.yaml`, `hub/.gcloudignore`, `scripts/gcp-migrate-hub.ps1`

### Critical-path summary
0.1 → 1.1 → 2.1/2.2 → 3.2 → 3.3 → 3.4 → 4.1 → 4.2 → 4.4 → 5.1 → 5.2
(everything else hangs off these; total ~1.5–2 working days)
