# CT Hub — Casa Trejo Operations Hub

**Live:** [hub.casatrejo.com](https://hub.casatrejo.com)

A three-panel operations intelligence hub built with Next.js 14, running as a
dynamic Node server on Google Cloud Run.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ HEADER: CT HUB logo | Project selector | Power View | User      │
├──────────────────┬──────────────────────┬────────────────────────┤
│ LEFT             │ CENTER               │ RIGHT                  │
│ Command Center   │ AI Assistant         │ Execution Layer        │
│                  │ (Claude → Gemini)    │ (Paperclip API)        │
│ • KPIs           │                      │                        │
│ • Project Health │ [Chat Interface]     │ • Issue Inbox          │
│ • Q2 Objectives  │ [/grill-me mandate]  │ • Agent Runs           │
│                  │                      │ • Orgs                 │
└──────────────────┴──────────────────────┴────────────────────────┘
```

## Tech Stack

- **Framework:** Next.js 14 (App Router, **Node runtime** — SSE streaming and
  `runtime = 'nodejs'` API routes; this is a dynamic server, not a static export)
- **Database:** Postgres + [Drizzle ORM](https://orm.drizzle.team) + `pgvector`
  (semantic memory / vector store)
- **Auth:** NextAuth.js with Google OAuth (Google Workspace scopes)
- **AI:** Claude (Fable 5 → Sonnet) with cross-provider fallback to
  Gemini (2.5 Flash → Pro). See `docs/runbooks/ai-provider-outage.md` for
  AI-key remediation.
- **Backend proxy:** Paperclip REST API (issues, agent runs, orgs)
- **Web search:** Exa.AI (external research)
- **Semantic Brain:** Vertex AI Search (internal Google Workspace search)
- **Styling:** Vanilla CSS (Trejo Design System); Outfit + Inter + JetBrains Mono

## Quick Start

Requires Node 22 (see `package.json` `engines`) and a Postgres database.

```bash
npm install
cp .env.local.example .env.local   # then fill in the values (see below)
npm run dev
```

Minimum configuration to boot locally:

- **`DATABASE_URL`** — a reachable Postgres instance. Migrations are defined in
  `drizzle/` and applied at container startup in production; for local dev apply
  them via `node drizzle/migrate.mjs`.
- **Google OAuth** — `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (create at
  console.cloud.google.com), plus `NEXTAUTH_URL` and `NEXTAUTH_SECRET`
  (`openssl rand -base64 32`).
- **AI keys** — `ANTHROPIC_API_KEY` and/or `GEMINI_API_KEY` (either provider
  alone works thanks to cross-provider fallback).

See `.env.local.example` for the full, grouped list of required and optional
variables and what breaks when each is unset.

## Scripts

```bash
npm run dev            # local dev server
npm run build          # production build
npm start              # serve the production build (next start)
npm run lint           # ESLint (next lint)
npm test               # unit tests (vitest run)
npm run test:coverage  # unit tests with coverage
npm run test:e2e       # Playwright end-to-end tests
```

## Deployment

Deployed to **Google Cloud Run** (project `rxfit-automation`, service `hub`,
region `us-central1`).

- **Pipeline:** the GitHub Actions `deploy.yml` workflow deploys on a CI-gated
  `workflow_run` — it fires only after the `CI` workflow completes **successfully**
  on `master`, then builds and deploys the exact commit CI validated. A red
  typecheck/lint/unit/e2e run cannot ship.
- **Migrations:** run at container startup via `docker-entrypoint.sh`
  (`node drizzle/migrate.mjs`, idempotent) *before* the server accepts traffic,
  so a broken migration fails the Cloud Run startup gate instead of half-serving.
- **Readiness:** `/api/healthz` is an unauthenticated probe reporting live DB +
  AI-provider state; it backs the Cloud Run startup probe and deploy smoke test.
- **Secrets:** app secrets (DB URL, API keys, OAuth) are bound to the Cloud Run
  service via Secret Manager (`secretKeyRef`, the `hub-*` secrets) and persist
  across `gcloud run deploy --source` deploys — they are **not** set by CI.

## Key Features

- **Mandatory /grill-me:** Employees cannot create vague tasks. The AI assistant
  enforces a structured interview flow before task submission.
- **Project-scoped RBAC:** Each employee only sees their assigned projects.
- **Live Paperclip integration:** Issues, agent runs, and orgs are pulled from
  the Paperclip API in real-time.
- **Intelligence nodes:** Left panel data sourced from RxFit-Concierge Command
  Center nodes.

---

*Built for Casa Trejo Operations*
