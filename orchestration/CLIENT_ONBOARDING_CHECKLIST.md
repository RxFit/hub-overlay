# External Client Onboarding — Security Checklist

> **MANDATORY:** Complete ALL items before granting any external client access to the platform.
> This checklist ensures tenant credential isolation per the [secrets-manifest.json](file:///C:/Users/danie/Documents/antigravity/vibrant-chandrasekhar/orchestration/secrets-manifest.json).

---

## Client Information

| Field | Value |
|---|---|
| Client Name | _________________ |
| Client Contact Email | _________________ |
| Project Name | _________________ |
| Onboarding Date | _________________ |
| Tenant ID | _________________ |

---

## Pre-Onboarding Credential Checklist

### Client Must Provide (or you create isolated accounts):

- [ ] **Gemini API Key** — Client's own GCP project + Gemini API key
  - Why: Billing isolation — their usage bills to their account
  - How: Client creates project at console.cloud.google.com → Enable Gemini API → Create API Key
  - _Client Key Name:_ `CLIENT_GEMINI_API_KEY`

- [ ] **Stripe Account** — One of:
  - [ ] Client provides their own `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`
  - [ ] You create a Stripe Connect sub-account for them
  - Why: Payment isolation — their customers, their money, their PCI scope
  - _Client Key Name:_ `CLIENT_STRIPE_SECRET_KEY`, `CLIENT_STRIPE_WEBHOOK_SECRET`

- [ ] **Google OAuth** (if client's users will log into HUB) — One of:
  - [ ] Client provides their own `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
  - [ ] You create a separate OAuth consent screen in GCP for their brand
  - Why: Auth isolation — their users see their brand on the login screen

### You Provision (Automated via Paperclip):

- [ ] **Paperclip Workspace** — Create new Company in Paperclip for the client
  - Company Name: `{Client Name} - {Workspace Type}`
  - Company ID: _auto-generated_
  - API Key: _auto-generated_ (`sk_pc_*`)

- [ ] **Paperclip Agents** — Bootstrap CEO agent for client workspace
  - Agent ID: _auto-generated_
  - PAPERCLIP_OPS.md: Copy from template, update IDs

- [ ] **Tenant ID** — Assign unique tenant ID (lowercase, no spaces)
  - Format: `clientname` (e.g., `acmesaas`)
  - Set as `NEXT_PUBLIC_TENANT_ID` for their HUB instance (if separate)

- [ ] **Database Isolation** — One of:
  - [ ] Separate Railway Postgres instance for client
  - [ ] Separate schema within existing Postgres (with row-level security)
  - [ ] Shared database with tenant_id column filtering (minimum viable)

---

## Security Verification

### NEVER share these with external clients:

- [ ] Verified: Client does NOT have access to owner `STRIPE_SECRET_KEY`
- [ ] Verified: Client does NOT have access to any `GBP_*` keys
- [ ] Verified: Client does NOT have access to any `WP_*` keys
- [ ] Verified: Client does NOT have access to owner `GITHUB_TOKEN`
- [ ] Verified: Client does NOT have access to `GOOGLE_SERVICE_ACCOUNT_JSON`
- [ ] Verified: Client does NOT have access to `RAILWAY_TOKEN`
- [ ] Verified: Client does NOT have access to `VERCEL_TOKEN`
- [ ] Verified: Client does NOT have access to any `CLOUDFLARE_*` keys
- [ ] Verified: Client does NOT have access to owner's `DATABASE_URL`
- [ ] Verified: Client workspace cannot query other client workspaces via Paperclip API

### Workspace Isolation Test:

- [ ] Client API key (`sk_pc_*`) can only access their own Company
- [ ] Client API key cannot list other companies via `GET /api/companies`
- [ ] Client agents cannot create issues in owner workspaces
- [ ] Client data is not visible in owner's HUB dashboard

---

## Post-Onboarding

- [ ] Add client workspace to `secrets-manifest.json`
- [ ] Document client's key scope in manifest
- [ ] Set up monitoring for client workspace agent errors
- [ ] Confirm CEO escalation protocol covers client workspace key failures
- [ ] Brief client on key rotation expectations (quarterly recommended)

---

*Template version: 1.0 — Created 2026-06-06*
*Reference: orchestration/secrets-manifest.json*
