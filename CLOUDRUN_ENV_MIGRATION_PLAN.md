# Cloud Run Migration — Environment Variable Plan

Prepared 2026-06-12 from the actual Railway variable lists, cross-checked against
every `process.env.*` reference in the Hub codebase.

---

## 0. Three findings from your var lists (read first)

### F1. The Hub has NO `DATABASE_URL` on Railway — its database layer is silently dead
`lib/db.ts` requires `DATABASE_URL` at runtime. Without it, every DB-backed feature
fails its try/catch quietly: **pgvector semantic search (Obsidian brain), event
logging, agent memory, and the `hub_users` roles table** (which the code says
replaced the roles sheet). You're running on the `SUPERADMIN_EMAILS` fallback only.
This explains why the missing Postgres was never noticed. The Cloud SQL step of the
migration isn't just a move — **it's turning these features on for the first time.**
After creating Cloud SQL, run the drizzle migrations (`npx drizzle-kit migrate`)
to create the schema.

### F2. The Railway "Paperclip" service is carrying 10 Hub-only variables
`NEXTAUTH_*`, `GEMINI_API_KEY`, `GOOGLE_CLIENT_*`, `HUB_ROLES_SHEET_ID`,
`SUPERADMIN_EMAILS`, `NEXT_PUBLIC_TENANT_ID`, `PAPERCLIP_API_KEY`,
`PAPERCLIP_BASE_URL` do nothing on a Paperclip server. Only **5 of its 15 vars
matter**: `DATABASE_URL`, `PAPERCLIP_AGENT_JWT_SECRET`, `PAPERCLIP_MASTER_KEY`,
`PORT`, `NODE_ENV`. Looks like a copy-paste from the Hub service — harmless, but
it means stale copies of your OAuth secret and NextAuth secret live in a service
that's being retired. They disappear with it; no action beyond retirement.

### F3. `PAPERCLIP_MASTER_KEY` was set but never used — fixed
The entrypoint never wrote it to `/paperclip/secrets/master.key`, so Paperclip
generated a fresh key every deploy (any secrets encrypted at rest became
unreadable after each redeploy). `docker-entrypoint.sh` now writes it. Relevant
until the service is retired, and the same mechanism is needed if the Cloud Run
Paperclip uses `local_encrypted` secrets.

### F4. (Added after WS4 discovery) Both Paperclip deployments likely share ONE Railway Postgres — rotation will hit Cloud Run too
Evidence: the Railway-internal DB hostname can't be reached from Cloud Run, but the
same credential appears in `scratch_paperclip/` admin scripts using the **public
proxy** (`metro.proxy.rlwy.net:39263`) — the only way an external service (Cloud Run)
could reach that database. The scratch instance config also targets
`api.paperclip.casatrejo.com` with the same DB.

**Consequences:**
1. **Rotating the Railway Postgres password will break the Cloud Run Paperclip**
   unless you update its `DATABASE_URL` env var in the same change
   (Cloud Run console → service → Edit & Deploy New Revision → Variables).
   Verify first: check whether the Cloud Run service's `DATABASE_URL` points at
   `metro.proxy.rlwy.net`.
2. **Retiring the Railway Paperclip service is fine, but its Postgres is NOT
   redundant** — it appears to be the production database for the Cloud Run
   instance. Do not delete it until Paperclip's data is migrated to Cloud SQL
   (add that as a migration workstream: pg_dump the Paperclip DB → Cloud SQL →
   update Cloud Run `DATABASE_URL`).
3. The Paperclip boot log in this repo confirms `local_disk` storage — on Cloud Run
   that means **attachments don't survive instance restarts**. Acceptable if agents
   don't exchange files; otherwise move storage to GCS (S3-interop) when convenient.

---

## 1. Hub → Cloud Run: variable disposition

### Keep — runtime env vars (put secrets in Secret Manager)
| Variable | Notes |
|---|---|
| `NEXTAUTH_URL` | stays `https://hub.casatrejo.com` |
| `NEXTAUTH_SECRET` | Secret Manager |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Secret Manager; OAuth redirect URIs unchanged (same domain) |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Secret Manager. Better long-term: drop the key entirely and use the Cloud Run service identity (Workload Identity) for Vertex calls |
| `PAPERCLIP_BASE_URL` | keep → Cloud Run Paperclip URL |
| `PAPERCLIP_API_KEY` | Secret Manager (fallback auth) |
| `PAPERCLIP_AUTH_EMAIL` / `PAPERCLIP_AUTH_PASSWORD` | Secret Manager (primary session auth) |
| `SUPERADMIN_EMAILS` | keep |

### Keep — but these are BUILD-time vars (must be passed to Cloud Build, not just the service)
| Variable | Notes |
|---|---|
| `NEXT_PUBLIC_PAPERCLIP_URL` | baked into the client bundle at `npm run build` |
| `NEXT_PUBLIC_TENANT_ID` | same |

`--set-env-vars` on the service alone is NOT enough for `NEXT_PUBLIC_*` —
pass them as substitutions/build args in the Cloud Build step.

### Consolidate — Gemini key triplication
Code resolves `GEMINI_API_KEY || GOOGLE_API_KEY || GOOGLE_GENERATIVE_AI_API_KEY`.
The Hub service has two of the three; the Paperclip service has the third.
**Keep exactly one: `GEMINI_API_KEY`. Drop `GOOGLE_API_KEY` and
`GOOGLE_GENERATIVE_AI_API_KEY`** (after confirming all three hold the same key).

### Drop — not needed on Cloud Run
| Variable | Why |
|---|---|
| `PORT` | Cloud Run injects it (Next.js `start` respects it automatically) |
| `NODE_ENV` | set by the build; never set manually |

### Drop — referenced NOWHERE in the codebase (dead vars)
| Variable | Evidence |
|---|---|
| `HUB_ROLES_SHEET_ID` | `lib/schema.ts`: "Hub Users (replaces HUB_ROLES_SHEET_ID)" — superseded by the DB table |
| `NEXT_PUBLIC_KPI_SHEET_ID` | no reference in code |
| `GOOGLE_CHAT_WEBHOOK_URL` | no reference in code |
| `GOOGLE_MAPS_API_KEY` | no reference in code (delete the key in Google console too if unused elsewhere) |

### ADD — missing on Railway today, needed on Cloud Run
| Variable | Why |
|---|---|
| `DATABASE_URL` | **new Cloud SQL instance** (see F1 — currently absent entirely) |
| `EXA_API_KEY` | external web search is currently dead without it (`lib/exa.ts` throws); it exists in `.env.local.example` but was never set on Railway |
| `VERTEX_GCP_PROJECT` / `VERTEX_ENGINE_ID` | optional — code falls back to `semantic-brain-desktop` / `semanticbrain_1779229063037`; set explicitly to avoid surprises |
| `DEFAULT_PAPERCLIP_COMPANY_ID` | optional — falls back to the constant in `paperclipConfig.ts` |
| `LOG_LEVEL`, `CRON_SECRET`, `STRIPE_SECRET_KEY`, `GSC_SITE_URL` | only if you use logging tuning / cron endpoints / Stripe KPIs / Search Console KPIs |

---

## 2. Deployment commands (reference)

```bash
PROJECT=<your-gcp-project>; REGION=us-central1

# Cloud SQL (one-time) — then run drizzle migrations and enable pgvector
gcloud sql instances create hub-pg --database-version=POSTGRES_16 \
  --tier=db-g1-small --region=$REGION
gcloud sql databases create hub --instance=hub-pg
# in psql:  CREATE EXTENSION vector;

# Secrets (repeat per secret)
echo -n "<value>" | gcloud secrets create NEXTAUTH_SECRET --data-file=-

# Build (NEXT_PUBLIC_* go here, at build time)
gcloud builds submit hub/ \
  --tag $REGION-docker.pkg.dev/$PROJECT/hub/hub:v1 \
  --substitutions=_NEXT_PUBLIC_PAPERCLIP_URL=...,_NEXT_PUBLIC_TENANT_ID=rxfit

# Deploy
gcloud run deploy hub \
  --image $REGION-docker.pkg.dev/$PROJECT/hub/hub:v1 \
  --region $REGION --min-instances 1 --memory 1Gi --timeout 300 \
  --add-cloudsql-instances $PROJECT:$REGION:hub-pg \
  --set-secrets NEXTAUTH_SECRET=NEXTAUTH_SECRET:latest,DATABASE_URL=DATABASE_URL:latest,... \
  --set-env-vars NEXTAUTH_URL=https://hub.casatrejo.com,PAPERCLIP_BASE_URL=...,SUPERADMIN_EMAILS=danny@rxfitatx.com

# Domain
gcloud beta run domain-mappings create --service hub --domain hub.casatrejo.com --region $REGION
# then update the casatrejo.com DNS record per the mapping output
```

---

## 3. Railway Paperclip retirement checklist

1. ☐ Check its Postgres for any historical issues/agents worth exporting
   (`pg_dump`); the Cloud Run instance is the system of record, so likely nothing.
2. ☐ Rotate the exposed Postgres password (still pending from the audit) — or skip
   rotation and go straight to deletion if retiring this week.
3. ☐ Delete the `paperclip-production-4394` service and its Postgres in Railway.
4. ☐ Remove `paperclip-production-4394.up.railway.app` from
   `BETTER_AUTH_TRUSTED_ORIGINS` (entrypoint) and `allowedHostnames`
   (`railway/paperclip/config.json`) — or archive the whole `railway/` folder.
5. ☐ After the Hub moves: delete the Railway Hub service + confirm no other
   consumers of the old `hub-production-a923.up.railway.app` URL.

## 4. Cutover order
1. Cloud SQL up + migrations + pgvector → 2. Secrets in Secret Manager →
3. Build & deploy Hub to Cloud Run → 4. Smoke-test on the run.app URL
(login, chat, issue creation, feed, **and the newly-alive semantic search**) →
5. Flip DNS → 6. Pause Railway Hub for a week → 7. Retire both Railway services.

---

## 5. Completed in-session (2026-06-12, second pass)

**Scaffolding created** — `hub/cloudbuild.yaml` (build with NEXT_PUBLIC_* args +
deploy), `hub/.gcloudignore`, `scripts/gcp-migrate-hub.ps1` (step-by-step runbook:
`-Step apis|sql|secrets|build|deploy|domain|verify`). The Hub `Dockerfile` already
had Cloud Run build-args and PORT handling. Entrypoint master-key bug fixed
(`railway/paperclip/docker-entrypoint.sh`).

**Credential sweep — plaintext secrets scrubbed from 11 files** (all now require
env vars): the Railway Postgres URL in `railway/paperclip/config.json`,
`scratch_paperclip/{config.json, create-admin.js, get-users.js, grant-access.js,
set-password.js}`, and the Paperclip board password in
`scripts/{sync-railway-to-cloudrun.ps1, inject-company-secrets.ps1,
patch-agent-souls.ps1, restore-heartbeats.ps1, restore-heartbeats.js}`.

### ROTATION LIST — all three were committed in plaintext; treat as compromised
| Credential | Where it was | Rotate via |
|---|---|---|
| Railway Postgres password (`PjJM…`) | config files + scripts, **publicly routable** via `metro.proxy.rlwy.net:39263` | Railway → Postgres → Variables. ⚠️ If Cloud Run Paperclip's `DATABASE_URL` uses this DB (see F4), update it in the same change |
| Paperclip board password for `Danny@rxfitatx.com` (`[REDACTED-PAPERCLIP-PW]`) | 5 scripts | Paperclip UI on both instances; then update `PAPERCLIP_AUTH_PASSWORD` on the Hub service |
| `danny-rxfit-admin` password (`[REDACTED-ADMIN-PW]`) | `scratch_paperclip/set-password.js` | same as above if that account is active |

**Still on you:** run `npx tsc --noEmit` + `npm run build` in `hub/` (sandbox sees
stale OneDrive copies; the two rewritten lib files already pass strict tsc in
isolation), the rotations above, and the GCP steps in the runbook.
