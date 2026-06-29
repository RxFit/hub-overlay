# Hub Overlay — Deploy Runbook

> Last updated: 2026-06-28

## Table of Contents

- [Prerequisites](#prerequisites)
- [Quick Deploy](#quick-deploy)
- [Manual Deploy Steps](#manual-deploy-steps)
- [How Secrets Work](#how-secrets-work)
- [Post-Deploy Verification](#post-deploy-verification)
- [Rollback Procedure](#rollback-procedure)
- [Known Issues](#known-issues)

---

## Prerequisites

Before deploying, ensure:

| Requirement | How to verify |
|-------------|---------------|
| **GCP CLI installed** | `gcloud --version` |
| **Authenticated** | `gcloud auth login` (if expired) |
| **Correct project** | `gcloud config get-value project` → should be `rxfit-automation` |
| **On `master` branch** | `git branch --show-current` → should be `master` |
| **Node.js installed** | `node --version` (needed for post-deploy QA) |

### GCP Project Details

| Key | Value |
|-----|-------|
| Project | `rxfit-automation` |
| Region | `us-central1` |
| Service | `hub` |
| Service URL | `https://hub-11747747730.us-central1.run.app` |
| Custom Domain | `https://hub.casatrejo.com` |

---

## Quick Deploy

The recommended way to deploy is via the sync-and-deploy wrapper:

```powershell
# Full deploy with post-deploy QA
.\scripts\sync-and-deploy.ps1

# Deploy without QA
.\scripts\sync-and-deploy.ps1 -SkipQA

# Dry run — shows what would be deployed
.\scripts\sync-and-deploy.ps1 -DryRun
```

The wrapper handles:
1. ✅ Verifying you're on `master` (prompts to switch if not)
2. ✅ Pulling latest from origin (fast-forward only)
3. ✅ Stashing any tracked changes so `deploy.ps1` passes its git-clean check
4. ✅ Invoking `deploy.ps1` with passthrough flags (`-SkipQA`, `-DryRun`)
5. ✅ Restoring stashed changes after deploy (even if deploy fails)

---

## Manual Deploy Steps

If you prefer to run each step manually:

```powershell
# 1. Ensure you're on master with latest changes
git checkout master
git pull origin master --ff-only

# 2. Stash any WIP changes
git stash push -m "pre-deploy stash"

# 3. Run the deploy script
.\deploy.ps1            # full deploy + QA
.\deploy.ps1 -SkipQA    # deploy only
.\deploy.ps1 -DryRun    # dry run

# 4. Restore your WIP changes
git stash pop
```

### What `deploy.ps1` Does

1. **Pre-flight checks** — clean git status, correct GCP project, source dir exists, env vars populated
2. **Deploy** — `gcloud run deploy hub --source hub/ --project=rxfit-automation --region=us-central1`
3. **Log check** — waits 10s then checks Cloud Run logs for OAuth config confirmation
4. **QA** — runs `scripts/qa-test.js` (unless `-SkipQA`)

---

## How Secrets Work

Secrets are **NOT** passed as plain env vars. They are stored in [GCP Secret Manager](https://console.cloud.google.com/security/secret-manager?project=rxfit-automation) and mounted into the Cloud Run container via `secretKeyRef` in `service.yaml`.

### Secret Manager References

| Env Var | Secret Manager Name |
|---------|---------------------|
| `NEXTAUTH_SECRET` | `hub-nextauth-secret` |
| `GOOGLE_CLIENT_ID` | `hub-google-client-id` |
| `GOOGLE_CLIENT_SECRET` | `hub-google-client-secret` |
| `GEMINI_API_KEY` | `hub-gemini-api-key` |
| `DATABASE_URL` | `hub-database-url` |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | `hub-google-sa-key` |
| `PAPERCLIP_API_KEY` | `hub-paperclip-api-key` |
| `PAPERCLIP_AUTH_EMAIL` | `hub-paperclip-auth-email` |
| `PAPERCLIP_AUTH_PASSWORD` | `hub-paperclip-auth-password` |
| `EXA_API_KEY` | `hub-exa-api-key` |
| `Anthropic_API_Key` | `hub-anthropic-api-key` |
| `anthropic_token` | `hub-anthropic-token` |

### Plain Env Vars (set by `deploy.ps1`)

These are non-sensitive and passed via `--update-env-vars`:

- `NODE_ENV=production`
- `NEXTAUTH_URL=https://hub.casatrejo.com`
- `PAPERCLIP_BASE_URL=https://rxfit-paperclip-11747747730.us-central1.run.app`
- `SUPERADMIN_EMAILS=danny@rxfitatx.com`
- `VERTEX_GCP_PROJECT=semantic-brain-desktop`
- `VERTEX_ENGINE_ID=semanticbrain_1779229063037`
- `DEFAULT_PAPERCLIP_COMPANY_ID=8f2acc3d-f2dc-4f8c-897e-7c400e91fd85`
- `ADMIN_TEAM=Danny Trejo`

### Updating a Secret

```bash
# Update a secret value
echo -n "NEW_VALUE" | gcloud secrets versions add hub-nextauth-secret --data-file=- --project=rxfit-automation

# The next deploy will pick up the latest version automatically (key: latest)
```

---

## Post-Deploy Verification

After a successful deploy, verify the following:

### Automated (done by `deploy.ps1`)

- OAuth config log appears in Cloud Run logs
- QA test script passes (if not skipped)

### Manual Checks

1. **Service is responding:**
   ```bash
   curl -s -o /dev/null -w "%{http_code}" https://hub.casatrejo.com
   # Expected: 200
   ```

2. **Check Cloud Run console:**
   Visit [Cloud Run Console](https://console.cloud.google.com/run/detail/us-central1/hub/revisions?project=rxfit-automation) and verify:
   - New revision is active
   - Traffic is 100% on latest revision
   - No error logs in the Logs tab

3. **Auth flow:**
   Open `https://hub.casatrejo.com` in an incognito window and verify Google OAuth sign-in works.

4. **Recent logs:**
   ```bash
   gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=hub" \
     --project=rxfit-automation --limit=20 --format="table(timestamp,textPayload)"
   ```

---

## Rollback Procedure

If a deploy goes wrong, roll back to the previous revision:

### Quick Rollback (Traffic Shift)

```bash
# 1. List recent revisions
gcloud run revisions list --service=hub --project=rxfit-automation --region=us-central1 --limit=5

# 2. Route 100% traffic to the previous good revision
gcloud run services update-traffic hub \
  --to-revisions=hub-XXXXX=100 \
  --project=rxfit-automation \
  --region=us-central1

# Replace hub-XXXXX with the revision name from step 1
```

### Full Rollback (Redeploy Previous Code)

```bash
# 1. Find the last known good commit
git log --oneline -10

# 2. Check out that commit
git checkout <commit-hash>

# 3. Deploy from that state
.\deploy.ps1 -SkipQA

# 4. Return to master
git checkout master
```

### Canary Rollback (Gradual)

If the issue is intermittent, do a gradual traffic shift:

```bash
# Route 50/50 between old and new
gcloud run services update-traffic hub \
  --to-revisions=hub-OLD=50,hub-NEW=50 \
  --project=rxfit-automation \
  --region=us-central1

# If old is stable, shift fully
gcloud run services update-traffic hub \
  --to-revisions=hub-OLD=100 \
  --project=rxfit-automation \
  --region=us-central1
```

---

## Known Issues

### WIP Files Stash Dance

Currently, if you have uncommitted tracked changes (WIP files), you need to stash them before deploying because `deploy.ps1` enforces a clean git status. The `sync-and-deploy.ps1` wrapper automates this stash/pop cycle, but the root cause is that WIP files should be committed on a branch or added to `.gitignore`.

> **Note:** A future change will commit any outstanding WIP component files, eliminating the need for the stash dance entirely.

### OAuth Log Check Timing

The post-deploy OAuth config log check waits 10 seconds for the new revision to boot. On cold starts, this may not be enough time. If the check fails with a warning, wait a minute and manually verify:

```bash
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=hub AND textPayload:\"[auth] OAuth config\"" \
  --project=rxfit-automation --limit=1 --format="value(textPayload)"
```

### Cloud SQL Connection

The service connects to Cloud SQL instance `rxfit-automation:us-central1:hub-pg` via the Cloud SQL connector (configured in `service.yaml`). If database connection issues occur after deploy, verify the Cloud SQL instance is running and the `DATABASE_URL` secret is correct.
