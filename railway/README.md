# hub.casatrejo.com — Railway Deployment Guide

## Overview

Two Railway services:
1. **`paperclip`** — Paperclip AI orchestration backend (authenticated mode)
2. **`hub`** — Next.js hub shell (hub.casatrejo.com)

Shared: **Railway Postgres plugin** + **Railway persistent volume** for Paperclip state.

---

## Prerequisites

1. Install Railway CLI: `npm install -g @railway/cli`
2. Login: `railway login`
3. Have your casatrejo.com DNS credentials ready (for CNAME setup)

---

## Step 1: Create Railway Project

```bash
railway init
# Name: casatrejo-hub
# Select: Empty project
```

---

## Step 2: Add Postgres Plugin

In the Railway dashboard:
1. Click "Add Plugin" → "PostgreSQL"
2. Name it: `paperclip-db`
3. Copy the `DATABASE_URL` — you'll need it in Step 5

---

## Step 3: Data Migration (Local → Railway Postgres)

### 3a. Copy latest backup
Your Paperclip instance automatically backs up every hour. Use the latest:
```powershell
# Find latest backup
$latest = Get-ChildItem "$env:USERPROFILE\.paperclip\instances\default\data\backups" | Sort-Object LastWriteTime | Select-Object -Last 1
Write-Host "Using backup: $($latest.FullName)"
```

### 3b. Decompress and restore
```powershell
# Run the migration script (scripts/migrate-db.ps1)
.\scripts\migrate-db.ps1 -DatabaseUrl "postgresql://..." -BackupFile "$env:USERPROFILE\.paperclip\instances\default\data\backups\LATEST.sql.gz"
```

### 3c. Verify migration
```bash
# Via Railway CLI, connect to Postgres and check row counts
railway run psql $DATABASE_URL -c "SELECT schemaname, tablename, n_live_tup FROM pg_stat_user_tables ORDER BY n_live_tup DESC LIMIT 20;"
```

---

## Step 4: Extract Master Key

```powershell
# Get master key value (44 bytes, base64)
$masterKey = Get-Content "$env:USERPROFILE\.paperclip\instances\default\secrets\master.key" -Raw
Write-Host "PAPERCLIP_MASTER_KEY=$masterKey"
# Add this to Railway env vars for the paperclip service
```

---

## Step 5: Deploy Paperclip Service

```bash
cd railway/paperclip
railway up --service paperclip
```

Set these env vars in Railway dashboard for the `paperclip` service:
- `DATABASE_URL` — from Railway Postgres plugin (auto-linked if same project)
- `PAPERCLIP_MASTER_KEY` — value from Step 4
- `PAPERCLIP_AGENT_JWT_SECRET` — value from ~/.paperclip/instances/default/.env
- `NODE_ENV=production`
- `PORT=3100`

---

## Step 6: Bootstrap Paperclip (First-Time Only)

After Paperclip service is running on Railway:

```bash
# Run bootstrap command inside the Railway service
railway run --service paperclip paperclipai auth bootstrap-ceo
# Follow prompts: enter your email + password
# This creates your board admin account

# IMPORTANT: Disable open sign-up immediately after
# In Paperclip UI → Instance Settings → Auth → disable "Allow sign-up"
```

---

## Step 7: Generate Board API Key

1. Log in to Paperclip at `https://api.paperclip.casatrejo.com`
2. Go to Settings → API Keys → New Key
3. Name: "Antigravity Master Key"
4. Copy the key — update `orchestration/.env` with it

---

## Step 8: Deploy Hub Shell

```bash
cd hub
railway up --service hub
```

Set these env vars in Railway dashboard for the `hub` service:
- `PAPERCLIP_BASE_URL=https://api.paperclip.casatrejo.com`
- `PAPERCLIP_API_KEY` — from Step 7
- `GOOGLE_CLIENT_ID` — from Google Cloud Console
- `GOOGLE_CLIENT_SECRET` — from Google Cloud Console
- `NEXTAUTH_URL=https://hub.casatrejo.com`
- `NEXTAUTH_SECRET` — run `openssl rand -base64 32` to generate
- `GEMINI_API_KEY` — your Gemini API key

---

## Step 9: Custom Domain DNS

### For hub.casatrejo.com:
In Railway dashboard → hub service → Settings → Domains → Add Custom Domain:
- Domain: `hub.casatrejo.com`
- Railway will give you a CNAME target (e.g., `hub.up.railway.app`)

Add to your DNS (Cloudflare/GoDaddy/etc.):
```
Type: CNAME
Name: hub
Value: [Railway-provided domain]
TTL: Auto
```

### For api.paperclip.casatrejo.com:
Same process for the paperclip service:
```
Type: CNAME
Name: api.paperclip
Value: [Railway-provided domain for paperclip service]
TTL: Auto
```

Railway handles TLS/SSL automatically (Let's Encrypt).

---

## Step 10: Update Antigravity Orchestration

```powershell
# Update the orchestration .env
$envPath = "C:\Users\danie\Documents\antigravity\vibrant-chandrasekhar\orchestration\.env"
# Replace PAPERCLIP_BASE_URL with the Railway URL
# Replace PAPERCLIP_API_KEY with the new board API key from Step 7
```

Then run the AGENTS.md update script:
```powershell
.\scripts\update-agents-url.ps1 -NewUrl "https://api.paperclip.casatrejo.com"
```

---

## Verification Checklist

- [ ] `https://api.paperclip.casatrejo.com` → Paperclip UI loads
- [ ] Login with email/password (bootstrapped in Step 6)
- [ ] All 5 projects visible (RxFit, WellnessApp, RxFit-SEO-Agent, JadeCoS, NotebookRx)
- [ ] All 28 companies present (verify company IDs match BOOTSTRAP_LOG.md)
- [ ] `https://hub.casatrejo.com` → Hub shell loads
- [ ] Google SSO login works
- [ ] Paperclip data appears in Right Panel
- [ ] Gemini chat responds
- [ ] Antigravity can create a test issue via `paperclip-mcp`

---

## Cost Estimate (Railway)

| Service | Est. Monthly Cost |
|---|---|
| Paperclip service (512MB RAM, 0.5 vCPU) | ~$5-10 |
| Hub service (512MB RAM, 0.5 vCPU) | ~$5 |
| Railway Postgres (1GB storage) | ~$5 |
| Railway persistent volume (5GB) | ~$1 |
| **Total** | **~$16-21/mo** |

Use Railway's Starter plan ($5/mo credit included) or Pro plan for production workloads.
