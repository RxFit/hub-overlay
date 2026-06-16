# Remediation Plan — Paperclip Integration Follow-ups (2026-06-12)

Three items left open after the integration audit (`PAPERCLIP_INTEGRATION_AUDIT_2026-06-12.md`).
Each requires either credentials or a business decision only you can make.

---

## 1. Rotate the committed Postgres password

**Problem:** `railway/paperclip/config.json` contains a live connection string with the
database password in plaintext:
`postgresql://postgres:PjJMK...@postgres.railway.internal:5432/railway`
Anyone with repo access (or any past copy/backup of this folder) has the DB password.
Treat it as compromised — rotation, not just removal, is required.

**Steps (≈10 min):**

1. **Rotate in Railway:** Railway dashboard → your project → Postgres service →
   *Variables* → regenerate/change `PGPASSWORD` (or delete + re-provision the credential).
   Railway auto-updates the service's own `DATABASE_URL` reference.
2. **Confirm the Paperclip service reads from env, not the file:**
   `railway/paperclip/docker-entrypoint.sh` already writes `DATABASE_URL=$DATABASE_URL`
   into the instance `.env`, so the env var path works. In the Railway Paperclip
   service's Variables, set `DATABASE_URL` to the **reference** `${{Postgres.DATABASE_URL}}`
   so rotation propagates automatically.
3. **Strip the secret from the file:** in `config.json`, replace both
   `database.connectionString` and `database.postgresConnectionString` values with an
   empty string or remove the keys, keeping `"mode": "postgres"` (Paperclip falls back
   to the `DATABASE_URL` env var written by the entrypoint).
4. **Redeploy** the Paperclip service and verify `/api/health` returns
   `"Database: PostgreSQL connection successful"` in the boot log (`paperclip doctor` output).
5. **Purge history:** if this folder is a git repo pushed anywhere, the old password
   lives in history — either rotate and accept history exposure (password now useless),
   or scrub with `git filter-repo` if the repo is shared.
6. Same sweep for `scratch_paperclip/`: delete `master.key` and
   `instances/default/.env` from the repo if they contain anything real
   (the checked copy looked like a dummy key, but verify before deleting).

**Done when:** new password works in production, `config.json` contains no credentials,
old connection string rejected.

---

## 2. Decide: local + Cloud Run instances — coexist or consolidate?

**Problem:** there are effectively **three** Paperclip deployments with different orgs
and conflicting documentation:

| Instance | Org / IDs | Used by |
|---|---|---|
| Local `127.0.0.1:3100` | "HUB Overlay" org (`05787964-…`, CEO `a26e5555-…`) | Antigravity/CLI workflows, watchdog scripts in `scripts/paperclip/`, AGENTS.md |
| Cloud Run `rxfit-paperclip-…run.app` | "RxFit" org (IDs in `hub/lib/paperclipConfig.ts`) | The Hub web app — all chat-created issues land HERE |
| Railway `paperclip-production-4394` | config in `railway/paperclip/` (its `publicBaseUrl` wrongly points at the Cloud Run URL) | Unclear — possibly dead |

Issues filed from the Hub chat go to agents the AGENTS.md playbook doesn't know about,
and vice versa. Nothing syncs between instances.

**Option A — Consolidate on Cloud Run (recommended if the Hub is the primary interface):**
1. Recreate the HUB Overlay company + CEO/COO/CTO agents on the Cloud Run instance
   (or fold their duties into the existing RxFit C-Suite).
2. Point Antigravity/CLI profile `hub-local` at the Cloud Run URL; update
   `~/.paperclip/auth.json` with a board token for that instance.
3. Retire the local watchdog/startup scheduled tasks (`scripts/paperclip/*.ps1`).
4. Update AGENTS.md with the Cloud Run IDs as the single source of truth.
5. Decommission or archive the Railway service.

**Option B — Keep both, with hard separation:**
1. Keep local = Antigravity's dev/orchestration sandbox; Cloud Run = production org
   the Hub manages. (This is the de-facto current state.)
2. The warning block added to AGENTS.md covers the doc side; additionally add the
   local instance's details to a separate `AGENTS_LOCAL.md` and keep AGENTS.md
   production-only, so an agent can't grab the wrong IDs.
3. Fix `railway/paperclip/config.json` regardless: either set
   `auth.publicBaseUrl` to `https://paperclip-production-4394.up.railway.app`
   and keep it as a warm standby, or delete `railway/` if it's dead.

**Either way, decide and kill the Railway ambiguity** — a deployment whose auth
base URL points at a different deployment will produce broken sign-in redirects
and CORS failures the moment anyone uses it.

**Done when:** one written source of truth maps each consumer (Hub app, Antigravity,
scripts) to exactly one instance + org ID set, and any dead deployment is removed.

---

## 3. Run the full build to validate the audit fixes

**Problem:** the audit's fixes touched 8 files. Isolated `tsc --strict` passed on the
two library files, but a full Next.js build couldn't run in the sandbox — OneDrive
served stale/truncated file copies to the VM (noted as C4 in the audit). The build
must run on your machine, where the files are complete.

**Steps (run in PowerShell):**

```powershell
cd "C:\Users\danie\OneDrive\HQ Desktop\Hub Overlay\hub"
npm install          # if node_modules is missing/stale
npx tsc --noEmit     # fast: full typecheck of all 8 changed files
npm run build        # full Next.js production build
```

**If the build passes, smoke-test one intent of each class against live Paperclip:**

| Test | Expected |
|---|---|
| Chat: "create an issue to test the pipeline" | Issue appears in Paperclip inbox; chat shows the real issue identifier (not blank) |
| Chat: "show agent status" | Real agent list with statuses (previously 403) |
| Chat: "move issue <ID> to in review" | Status actually changes in Paperclip (previously silent no-op) |
| Chat: "show recent runs" | Run list or clean "no runs" (previously dead endpoint) |
| Right panel Execution Feed | Issues/agents populate (previously empty) |
| Business Manager / CEO Pulse | Departments no longer all "DRIFTING" |

**Watch for:** `priority` validation errors (would mean the deployed Paperclip is older
than v2026.609.0 — the urgent→critical mapping assumes current vocabulary), and
schema-mismatch warnings in the Hub logs (`Paperclip response schema mismatch`),
which are non-fatal but indicate contract drift worth reporting.

**Also recommended:** pin the Paperclip version in `railway/paperclip/Dockerfile`
(`pnpm add -g paperclipai@2026.609.0`) so the API can't drift under the Hub silently.

**Done when:** `npm run build` exits 0 and all six smoke tests behave as expected.
