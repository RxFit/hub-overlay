# CT Hub — Casa Trejo Operations Hub

**Live:** [hub.casatrejo.com](https://hub.casatrejo.com) · [casatrejo-hub.pages.dev](https://casatrejo-hub.pages.dev)

A three-panel operations intelligence hub built with Next.js 14, deployed on Cloudflare Pages.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ HEADER: CT HUB logo | Project selector | Power View | User      │
├──────────────────┬──────────────────────┬────────────────────────┤
│ LEFT             │ CENTER               │ RIGHT                  │
│ Command Center   │ AI Assistant         │ Execution Layer        │
│                  │ (Gemini-powered)     │ (Paperclip API)        │
│ • KPIs           │                      │                        │
│ • Project Health │ [Chat Interface]     │ • Issue Inbox          │
│ • Q2 Objectives  │ [/grill-me mandate]  │ • Agent Runs           │
│                  │                      │ • Orgs                 │
└──────────────────┴──────────────────────┴────────────────────────┘
```

## Quick Start

```bash
npm install
npm run dev
```

## Tech Stack

- **Framework:** Next.js 14 (App Router)
- **Styling:** Vanilla CSS (Trejo Design System)
- **Fonts:** Outfit + Inter + JetBrains Mono (Google Fonts)
- **AI:** Gemini 2.5 (streaming SSE)
- **Backend Proxy:** Paperclip REST API
- **Auth:** NextAuth.js with Google OAuth
- **Hosting:** Cloudflare Pages (static export for demo)
- **Domain:** hub.casatrejo.com (Cloudflare DNS)

## Environment Variables

See `.env.local.example` for all required variables.

## Deployment

```bash
# Build static export
npm run build

# Deploy to Cloudflare Pages
npx wrangler pages deploy out --project-name casatrejo-hub --branch main
```

## Key Features

- **Mandatory /grill-me:** Employees cannot create vague tasks. The AI assistant enforces a structured interview flow before task submission.
- **Project-scoped RBAC:** Each employee only sees their assigned projects.
- **Live Paperclip integration:** Issues, agent runs, and orgs are pulled from the Paperclip API in real-time.
- **Intelligence nodes:** Left panel data sourced from RxFit-Concierge Command Center nodes.

---

*Built by Antigravity for Casa Trejo Operations*
