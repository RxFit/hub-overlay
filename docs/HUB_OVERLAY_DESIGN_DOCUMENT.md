# Hub Overlay — Complete Design & Architecture Document

> **Purpose:** This document is the single source of truth for the Hub Overlay application. Feed this to Claude Code Fable 5 (or any AI coding assistant) to understand the entire system and fix issues.
>
> **Generated:** 2026-07-05 by Antigravity (Deep Think + Smart Connections + codebase analysis)
>
> **Key Scope Decision:** Multi-tenancy is **DEFERRED**. The MVP focuses exclusively on **RxFit as a single tenant**. When the MVP is complete and stable, multi-tenancy can be reconsidered.

---

## 1. Product Vision

### What is Hub Overlay?

Hub Overlay is a **three-panel AI-powered operations intelligence hub** built for **RxFit** (a fitness business in Austin, TX). It consolidates communication, task management, business data, and AI-driven automation into a single web interface.

**Live URL:** [hub.casatrejo.com](https://hub.casatrejo.com)

### Who uses it?

- **Danny Trejo** (Founder/Owner) — Strategic oversight, "Founder Lens" dashboard, AI conversations
- **RxFit staff** — Day-to-day operations: calendar, tasks, email, drive, KPIs
- **Paperclip AI agents** — Automated C-suite agents (CEO, COO, CTO) that execute operational tasks

### What problem does it solve?

RxFit's operations are fragmented across Google Workspace (Calendar, Tasks, Drive, Gmail, Chat), Paperclip AI (automated issue/agent orchestration), and manual spreadsheets. Hub Overlay unifies all of these into a single command center with an AI assistant that can:
- Answer questions about the business using Google Workspace data + semantic search
- Execute actions (create tasks, send emails, draft documents, create Paperclip issues)
- Enforce structured decision-making via the `/grill-me` interview flow before creating work items
- Display real-time KPIs and project health dashboards

---

## 2. Technology Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| **Framework** | Next.js (App Router) | 14.2.35 |
| **Language** | TypeScript | 5.x |
| **UI** | React + Vanilla CSS (Trejo Design System) | 18.3.1 |
| **Fonts** | Outfit + Inter + JetBrains Mono (Google Fonts) | — |
| **Auth** | NextAuth.js (Google OAuth) | 4.24.11 |
| **Database** | PostgreSQL (Cloud SQL `hub-pg`) | — |
| **ORM** | Drizzle ORM | 0.45.2 |
| **Vector Search** | pgvector (768-dim, Gemini text-embedding-004) | — |
| **Data Fetching** | SWR (Stale-While-Revalidate) | 2.3.3 |
| **AI - Primary** | Google Gemini 2.5 Flash (streaming SSE) | @google/generative-ai 0.24.0 |
| **AI - Secondary** | Anthropic Claude Fable 5 (model rotation fallback) | via direct API |
| **AI - Search** | Google Vertex AI Discovery Engine | semantic-brain-desktop project |
| **Web Search** | Exa API | exa-js 2.13.0 |
| **Orchestration** | Paperclip AI (external service) | Cloud Run: rxfit-paperclip |
| **Validation** | Zod | 3.25.76 |
| **Logging** | Pino + pino-pretty | 10.3.1 / 13.1.3 |
| **Testing** | Vitest (unit) + Playwright (e2e) | 2.1.9 / 1.61.1 |
| **Hosting** | Google Cloud Run | us-central1 |
| **CI/CD** | GitHub Actions | — |
| **Secrets** | GCP Secret Manager | — |
| **Repo** | GitHub: `RxFit/hub-overlay` | — |

---

## 3. Architecture

### 3.1 Three-Panel Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│ HEADER: CT HUB logo | Project Selector | Power View Toggle | User   │
├───────────────────┬───────────────────────┬──────────────────────────┤
│ LEFT PANEL        │ CENTER PANEL          │ RIGHT PANEL              │
│ "Command Center"  │ "AI Chat"             │ "Execution Layer"        │
│                   │                       │                          │
│ • Google Tasks    │ Chat Input + Messages │ • Paperclip Issues       │
│ • Google Calendar │ Model Badge (Gemini/  │ • Agent Runs             │
│ • Google Drive    │   Claude indicator)   │ • Organizations          │
│ • Google Chat     │ Skills/Tools Popover  │ • CEO Pulse Monitor      │
│ • KPI Dashboard   │ Context Attachments   │ • Execution Feed         │
│ • Project Health  │ Interview Flow        │                          │
│                   │ Tool Results Panel    │                          │
│ [Collapsible      │                       │ [Collapsible sections    │
│  sections with    │                       │  with SWR polling]       │
│  SWR polling]     │                       │                          │
└───────────────────┴───────────────────────┴──────────────────────────┘
```

### 3.2 Repository Structure

```
vibrant-chandrasekhar/          # Git root
├── .github/workflows/          # CI/CD (GitHub Actions)
├── .husky/                     # Git hooks (pre-push: tsc + vitest)
├── AGENTS.md                   # Paperclip org config
├── deploy.ps1                  # PowerShell deploy wrapper
├── service.yaml                # Cloud Run service config (reference only)
├── docs/                       # Design docs, runbooks
│   ├── deploy-runbook.md
│   ├── chat-model-resilience/
│   └── left-panel-audit/
├── hub/                        # ★ THE NEXT.JS APP
│   ├── app/
│   │   ├── page.tsx            # ⚠️ MONOLITH (73KB) — main three-panel UI
│   │   ├── layout.tsx          # Root layout with providers
│   │   ├── globals.css         # ⚠️ MONOLITH (220KB) — all styles
│   │   ├── error.tsx           # Error boundary
│   │   ├── login/              # Login page
│   │   ├── settings/           # User settings page
│   │   ├── admin/              # Admin pages (auditor dashboard)
│   │   ├── components/         # UI components (31 files)
│   │   ├── hooks/              # Custom React hooks (10 files)
│   │   ├── styles/             # CSS Modules (scoped styles)
│   │   └── api/                # Next.js API routes (17 subdirectories)
│   │       ├── auth/           # NextAuth [...nextauth] handler
│   │       ├── chat/           # AI chat pipeline (main route + detect-intent + score-context)
│   │       ├── google/         # Google Workspace proxy routes
│   │       │   ├── calendar/   # Calendar CRUD
│   │       │   ├── tasks/      # Tasks CRUD
│   │       │   ├── drive/      # Drive search/list
│   │       │   ├── gmail/      # Gmail read/send
│   │       │   └── chat/       # Google Chat (spaces, messages, members, readstate)
│   │       ├── paperclip/      # Paperclip AI proxy ([...path] catch-all)
│   │       ├── companies/      # Company management
│   │       ├── agents/         # Agent management
│   │       ├── projects/       # Project management
│   │       ├── kpis/           # KPI data + sync
│   │       ├── feed/           # Activity feed
│   │       ├── orgs/           # Org + Founder Lens
│   │       ├── settings/       # User settings API
│   │       ├── embeddings/     # pgvector embedding operations
│   │       ├── tool-artifacts/ # Tool artifact CRUD
│   │       ├── tool-context/   # Tool context retrieval
│   │       ├── auditor/        # Zero-tolerance context auditor
│   │       ├── webhooks/       # Google webhook handler
│   │       └── admin/          # Admin-only endpoints
│   ├── lib/                    # ★ CORE BUSINESS LOGIC (69 files + 3 subdirs)
│   │   ├── auth.ts             # NextAuth config + JWT callbacks + role resolution
│   │   ├── gemini.ts           # ★ Primary AI engine (30KB) — streaming, system prompt, tools
│   │   ├── claude.ts           # Claude Fable 5 integration (fallback model)
│   │   ├── interview.ts        # /grill-me interview flow engine (21KB)
│   │   ├── paperclip.ts        # Paperclip API client (19KB) — issues, agents, runs, health
│   │   ├── paperclipConfig.ts  # Paperclip connection config (env-based)
│   │   ├── paperclipSession.ts # Paperclip auth session management
│   │   ├── google.ts           # Google Workspace API operations (17KB)
│   │   ├── google-context.ts   # Google WS context aggregation for AI
│   │   ├── google-auth.ts      # Google OAuth token management
│   │   ├── google-session.ts   # withGoogleAuth middleware + helpers
│   │   ├── schema.ts           # Drizzle ORM database schema
│   │   ├── db.ts               # Database connection
│   │   ├── tenant.ts           # Tenant CRUD operations
│   │   ├── tenant-context.ts   # Server-side tenant resolution
│   │   ├── roles.ts            # Role definitions + permissions
│   │   ├── userRoles.ts        # User role management
│   │   ├── vertex.ts           # Vertex AI Discovery Engine client
│   │   ├── exa.ts              # Exa web search client
│   │   ├── content-fetch.ts    # URL content fetcher (SSRF-protected)
│   │   ├── circuit-breaker.ts  # Circuit breaker for external services
│   │   ├── retry.ts            # Retry logic with backoff
│   │   ├── loop-detector.ts    # Infinite loop detection for agents
│   │   ├── panel-inject.ts     # Context injection from panel taps → chat
│   │   ├── inject-routing.ts   # Routing logic for injected context
│   │   ├── search-routing.ts   # Search routing (Vertex vs Exa vs pgvector)
│   │   ├── skills.ts           # AI skill definitions + catalog
│   │   ├── skills-loader.ts    # Dynamic skill loading
│   │   ├── kpi-engine.ts       # KPI calculation engine
│   │   ├── vector-store.ts     # pgvector operations
│   │   ├── chunker.ts          # Text chunking for embeddings
│   │   ├── prompt-safety.ts    # Prompt safety checks
│   │   ├── zod-schemas.ts      # Zod validation schemas (Paperclip types)
│   │   ├── tool-artifacts.ts   # Tool artifact persistence
│   │   ├── parseToolArtifacts.ts # Tool artifact parsing
│   │   ├── ingest-client.ts    # Document ingestion client
│   │   ├── agent-memory.ts     # Agent memory operations
│   │   ├── event-logger.ts     # Structured event logging
│   │   ├── logger.ts           # Pino logger setup
│   │   ├── timeout.ts          # Timeout utility with cleanup
│   │   ├── gateToken.ts        # Token gating logic
│   │   ├── proxyAuthz.ts       # Proxy authorization checks
│   │   ├── chat-error.ts       # Chat error types
│   │   ├── email-address.ts    # Email address utilities
│   │   ├── sanitize-email.ts   # Email content sanitization
│   │   ├── num.ts              # Number formatting utilities
│   │   └── validate-keys.ts    # API key validation
│   ├── types/                  # TypeScript type definitions
│   ├── drizzle/                # Database migrations
│   ├── tests/                  # Test files
│   ├── scripts/                # Utility scripts
│   ├── middleware.ts           # Edge middleware (auth + CSP)
│   ├── Dockerfile              # Container config (node:20-slim)
│   └── package.json            # Dependencies
├── orchestration/              # Paperclip orchestration configs (submodule)
├── railway/                    # Legacy Railway deployment configs
└── scripts/                    # Deployment & utility scripts
```

### 3.3 Data Flow

```mermaid
graph TD
    User[User Browser] -->|Google OAuth| NextAuth[NextAuth.js]
    NextAuth -->|JWT + Role| Middleware[Edge Middleware]
    Middleware -->|CSP + Auth| AppRouter[Next.js App Router]

    AppRouter --> PageTSX[page.tsx - 3-Panel UI]
    PageTSX -->|SWR| APIRoutes[API Routes]

    subgraph "API Routes (Server-Side)"
        APIRoutes --> ChatRoute[/api/chat]
        APIRoutes --> GoogleRoutes[/api/google/*]
        APIRoutes --> PaperclipProxy[/api/paperclip/[...path]]
        APIRoutes --> KPIRoutes[/api/kpis/*]
        APIRoutes --> OrgRoutes[/api/orgs/*]
    end

    ChatRoute -->|Primary| Gemini[Gemini 2.5 Flash]
    ChatRoute -->|Fallback| Claude[Claude Fable 5]
    ChatRoute -->|Search| VertexAI[Vertex AI Discovery]
    ChatRoute -->|Web Search| Exa[Exa API]
    ChatRoute -->|Context| GoogleContext[google-context.ts]
    ChatRoute -->|Context| PaperclipContext[paperclip.ts]

    GoogleRoutes -->|Per-User OAuth| GoogleAPIs[Google Workspace APIs]
    PaperclipProxy -->|Service Auth| PaperclipService[Paperclip Cloud Run]

    subgraph "Database (Cloud SQL)"
        DB[(PostgreSQL)]
        DB --> hubUsers[hub_users]
        DB --> kpis[kpis]
        DB --> eventLog[event_log]
        DB --> agentMemory[agent_memory]
        DB --> entityLinks[entity_links]
        DB --> documentChunks[document_chunks + pgvector]
        DB --> founderLens[founder_lens_sections]
        DB --> toolArtifacts[tool_artifacts]
        DB --> tenants[tenants]
    end
```

---

## 4. Database Schema

All tables include a `tenant_id` column scoped to `'rxfit'` for the MVP. The schema uses Drizzle ORM with PostgreSQL.

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `tenants` | Tenant registry | `id` (e.g. 'rxfit'), `name`, `domain` |
| `hub_users` | User accounts + RBAC | `email`, `role` (superadmin\|admin\|staff\|onboarding), `assignedProjects` (Paperclip company IDs) |
| `kpis` | KPI dashboard data | `label`, `value`, `trend`, `source` (manual\|ga4\|stripe\|gsc\|paperclip), `sourceConfig` (JSONB) |
| `event_log` | Append-only audit trail | `eventType`, `actor`, `resourceType`, `resourceId`, `payload` (JSONB), `correlationId` |
| `agent_memory` | Paperclip agent knowledge store | `agentId`, `memoryType` (insight\|decision\|error_pattern\|success_pattern), `content`, `relevanceScore` |
| `entity_links` | Graph edges between entities | `sourceType`, `sourceId`, `targetType`, `targetId`, `label` |
| `document_chunks` | pgvector semantic search | `sourceUrl`, `content`, `embedding` (768-dim vector) |
| `founder_lens_sections` | Per-org C-Suite dashboard config | `orgId`, `role` (ceo\|cmo\|cto\|cfo\|coo), `sections` (JSONB) |
| `tool_artifacts` | Structured output from AI skills | `toolId`, `chatId`, `title`, `content` (JSONB), `status` (active\|completed\|archived) |

---

## 5. Authentication & Authorization

### 5.1 Auth Flow

1. **Google OAuth** via NextAuth.js → user signs in with Google account
2. **JWT Callback** (`lib/auth.ts`) resolves the user's role from the `hub_users` table:
   - Looks up user by email + tenant
   - Injects `role` and `assignedProjects` into the JWT token
   - Updates `lastLogin` timestamp
3. **Edge Middleware** (`middleware.ts`) runs on every request:
   - Verifies JWT token exists
   - Returns 401 JSON for API routes, redirects to `/login` for pages
   - Blocks `/admin` routes for non-admin/superadmin roles
   - Generates CSP nonce + sets security headers (HSTS, X-Frame-Options, etc.)

### 5.2 Role Hierarchy

| Role | Permissions |
|------|-------------|
| `superadmin` | Everything — manage users, delete agents, access admin pages |
| `admin` | Manage assigned projects, create issues, access admin pages |
| `staff` | View assigned projects, use chat, read-only on most resources |
| `onboarding` | Minimal access — new user awaiting role assignment |

### 5.3 Middleware Matcher

```typescript
// Middleware protects everything EXCEPT:
matcher: ['/((?!login|api/auth|api/chat|api/embeddings|api/webhooks|_next|favicon\\.svg|static).*)']
```

> [!WARNING]
> **`/api/chat` is excluded from middleware auth checks.** The chat route handles its own auth internally, but this is a defense-in-depth concern flagged in audits.

---

## 6. AI Chat Pipeline

### 6.1 Overview

The chat system is the **core feature** of Hub Overlay. It uses a streaming SSE architecture with multi-model rotation.

### 6.2 Model Rotation Strategy

The model priority chain varies by **use case**:

| Use Case | Priority Chain |
|----------|---------------|
| `interview` (grill-me) | Claude Fable 5 → Claude Sonnet 4.6 → Gemini 2.5 Flash → Gemini 2.5 Pro |
| `execute` (Pre-Cog) | Claude Fable 5 → Claude Sonnet 4.6 → Gemini Flash → Gemini Pro |
| `deep_dive` + skill | Claude Fable 5 → Claude Sonnet 4.6 → Gemini Flash → Gemini Pro |
| `deep_dive` (no skill) | Gemini 2.5 Flash → Gemini 2.5 Pro |
| `recall` | Gemini 2.5 Flash → Gemini 2.5 Pro |

**Per-model cooldown tracking** (Map-based):
- Rate limit → 30s cooldown
- Server error → 5min cooldown
- Auth error → 30min cooldown

**Stream safety:**
- `withIdleWatchdog`: wraps async iterators with 30s per-step idle timeout to catch mid-stream stalls
- 60-second connect timeout on stream initiation
- `friendlyModelError()` maps raw errors to user-safe messages (never leaks internals)

### 6.3 Chat Route Pipeline (`/api/chat/route.ts`)

When a user sends a message, the server-side pipeline executes:

1. **Auth check** — Verify session
2. **Context aggregation** (parallelized):
   - **Paperclip context** — Active issues, agent status, org data
   - **Google Workspace context** — Upcoming events, recent tasks, recent docs, shared files, meeting transcripts
3. **Search augmentation** (sequential, depends on message content):
   - **Vertex AI semantic search** — Search indexed documents
   - **Exa web search** — If the query requires external knowledge
4. **System prompt construction** (`lib/gemini.ts buildSystemPrompt`):
   - Injects RxFit-specific context, user role, active skill, all aggregated context
5. **AI generation** — Stream response from Gemini or Claude
6. **SSE events emitted**:
   - `modelUsed` — Which AI model was selected
   - `suggestedTools` — AI-recommended tools/skills
   - `text` — Streamed response chunks
   - `done` — Completion signal

### 6.4 Skills System

The AI chat supports "skills" — specialized modes of interaction:

| Skill | Description |
|-------|-------------|
| Interview / `/grill-me` | **Mandatory** structured interview before task creation — prevents vague tasks |
| Pre-Cog | Pre-flight validation before executing destructive actions |
| Issue Tree | MECE problem decomposition |
| Decision Memo | Structured decision documentation |
| Founder Lens | C-Suite strategic dashboard queries |
| SCPR Memo | Situation/Complication/Problem/Recommendation |
| Meeting Prep | Meeting preparation framework |
| Prioritization | Priority matrix scoring |
| Storyline | Narrative structuring |
| McKinsey Critic | Adversarial framework analysis |
| Deck Pipeline | Presentation creation pipeline |
| Data Insights | Data analysis and visualization |
| AI Use Case Scorer | AI opportunity scoring |

### 6.5 Interview Mode Detail

The Interview Mode (`lib/interview.ts`, 721 lines) is a **pure-function state machine**:

1. **Intent Detection** — `/api/chat/detect-intent` classifies user messages into 17 intent types
2. **Interview Flow** — `startInterview()` → `advanceInterview()` (collects structured info) → `cancelInterview()` / `restartInterview()`
3. **Context Sufficiency Score** — `/api/chat/score-context` scores answers 0-100; must hit 80% to proceed
4. **Pre-Cog Gate** — High-stakes intents get an AI quality evaluation before confirmation
5. **Action Confirm Card** — UI card with Approve / Edit / Cancel buttons
6. **Action Execution** — `executeAction()` dispatches approved actions to target systems (Paperclip, Google, etc.)

> [!IMPORTANT]
> **P0-2 context:** The 80% score gate and Pre-Cog validation are ENTIRELY client-side. The server routes execute mutations with zero knowledge of any score. `finalScore` defaults to `80`, so a broken response passes. This must be moved server-side.

### 6.6 Panel → Chat Injection

Users can tap items in the left or right panels to inject context into the AI chat:
- Clicking a calendar event → injects event details as chat context
- Clicking a task → injects task details
- Clicking a Paperclip issue → injects issue details + run history
- The injection uses `lib/panel-inject.ts` to format the context
- Two injection types: `onInjectChat` (read-style, direct to API) and `onInjectAction` (action-style, routes through `doSend` for Interview Mode)

---

## 7. Google Workspace Integration

### 7.1 Supported Services

| Service | API Routes | Operations |
|---------|-----------|------------|
| **Calendar** | `/api/google/calendar` | List events (multiple calendars), create/update/delete events, timezone-aware |
| **Tasks** | `/api/google/tasks` | List task lists + tasks, create/update/complete tasks |
| **Drive** | `/api/google/drive` | Search files, list recent/shared files, resolve shortcuts (up to 3 levels) |
| **Gmail** | `/api/google/gmail` | List threads, read messages, send/draft emails, CRLF injection protection |
| **Chat** | `/api/google/chat/*` | List spaces, messages, members, read state |

### 7.2 Auth Pattern

All Google routes use the `withGoogleAuth` higher-order function (`lib/google-session.ts`):
```typescript
export const GET = withGoogleAuth(async (req, { accessToken, correlationId }) => {
  // accessToken is the user's Google OAuth token from NextAuth
})
```

### 7.3 Context Aggregation for AI

`lib/google-context.ts` aggregates Google Workspace data for the AI chat system prompt:
- Recent tasks (up to 10)
- Upcoming calendar events from selected/primary calendars (up to 5 calendars)
- Recent Drive files (up to 10), shared files (up to 8), meeting transcripts (up to 8)
- Excludes video files (mp4, quicktime, avi, webm)

---

## 8. Paperclip AI Integration

### 8.1 What is Paperclip?

Paperclip AI is an **external AI agent orchestration platform**. Each "company" in Paperclip is an isolated workspace with:
- **Issues** — Work items/requests
- **Agents** — AI workers with specific capabilities (CEO, COO, CTO)
- **Runs** — Individual executions of agent work on issues

### 8.2 Hub's Paperclip Architecture

```
Hub Overlay ─────→ Paperclip Cloud Run Instance
                   (https://rxfit-paperclip-....run.app)
                   
Company: RxFit (8f2acc3d-f2dc-4f8c-897e-7c400e91fd85)
├── CEO Agent → Strategic delegation
├── COO Agent → Operations & audits
└── CTO Agent → Code, features, infrastructure
```

### 8.3 Key Files

| File | Purpose |
|------|---------|
| `lib/paperclip.ts` (19KB) | Full Paperclip API client — issues CRUD, agents, runs, health check, CEO pulse |
| `lib/paperclipConfig.ts` | Connection config — base URL, company IDs, `isLocal` flag for dev vs prod |
| `lib/paperclipSession.ts` | Session cookie management for Paperclip auth |
| `lib/zod-schemas.ts` | Zod schemas for Paperclip API responses |
| `app/api/paperclip/[...path]/route.ts` | Catch-all proxy route with scope + (partial) role enforcement |

### 8.4 Proxy Route (`/api/paperclip/[...path]`)

The Hub proxies all Paperclip API calls through its own backend:
- **GET** — Passes through with `assignedProjects` scope filtering
- **POST/PATCH** — Checks `assignedProjects` scope but **NOT role** (⚠️ P0-1)
- **DELETE** — Role-gated (admin+ required)

> [!CAUTION]
> **P0-1: POST/PATCH enforce company scope but NOT role tier.** A staff user assigned to a company can create agents, reassign issues, etc. Role gating is client-side only.

---

## 9. Key Infrastructure

### 9.1 Circuit Breaker (`lib/circuit-breaker.ts`)

A global singleton circuit breaker with per-service isolation via Map keys. Used to protect against cascading failures when Paperclip, Vertex AI, or Exa are down.
- **Threshold:** 3 failures
- **Reset:** 60 seconds
- **Pattern:** Global singleton, keyed per-tenant (currently just 'rxfit')

### 9.2 Vertex AI Semantic Search (`lib/vertex.ts`)

Connects to Google Discovery Engine (`semantic-brain-desktop` project, engine `semanticbrain_1779229063037`) for semantic search across indexed documents.

> [!WARNING]
> **P0-4 (now deferred):** The `dataStore` filter syntax used for scoped search is invalid per Google's API docs — the scoped search path silently returns null. For single-tenant MVP, the unscoped search is acceptable since all indexed docs belong to RxFit.

### 9.3 Content Fetch (`lib/content-fetch.ts`)

SSRF-protected URL content fetcher:
- DNS resolution + internal IP blocking
- Redirect handling
- Used for AI context when users share URLs in chat

### 9.4 Rate Limiting

- **Chat API**: 15 requests / 60 seconds per email (sliding window, in-memory Map)
- **Body size**: 512KB limit before JSON parsing (prevents memory exhaustion)
- **Idempotency**: Keyed by `${resourceId}:${resourceState}` with 10-minute TTL (for Google webhooks)

---

## 10. UI Components

### 10.1 Core Components

| Component | File | Description |
|-----------|------|-------------|
| **BrandedHeader** | `BrandedHeader.tsx` | Top header bar with logo, project selector, power view toggle, user menu |
| **LeftPanelSections** | `LeftPanelSections.tsx` | Barrel re-export for left panel sections |
| **CalendarSection** | `CalendarSection.tsx` (20KB) | Google Calendar integration with week navigation |
| **TasksSection** | `TasksSection.tsx` (8.5KB) | Google Tasks with completion tracking |
| **DocumentsSection** | `DocumentsSection.tsx` (7.5KB) | Google Drive files browser |
| **KPISection** | `KPISection.tsx` | KPI dashboard cards |
| **ProjectHealthSection** | `ProjectHealthSection.tsx` | Paperclip project health indicators |
| **RightPanelSections** | `RightPanelSections.tsx` (14KB) | Issues, runs, orgs in the right panel |
| **GoogleChatPanel** | `GoogleChatPanel.tsx` (36KB) | Full Google Chat integration panel |
| **FounderLensWizard** | `FounderLensWizard.tsx` (14.6KB) | Strategic Founder Lens configuration wizard |
| **BusinessManagerPanel** | `BusinessManagerPanel.tsx` (13KB) | Business management dashboard |
| **ChatEnhancements** | `ChatEnhancements.tsx` (11.7KB) | Chat UI enhancements (formatting, actions) |
| **ContextAttachMenu** | `ContextAttachMenu.tsx` (23KB) | Attachment/context menu for chat |
| **ToolPanel** | `ToolPanel.tsx` (9.5KB) | Tool results display panel |
| **MessageContent** | `MessageContent.tsx` (7KB) | Chat message rendering with markdown |
| **MentionPicker** | `MentionPicker.tsx` (4.8KB) | @mention autocomplete in chat |
| **SkillsPopover** | `SkillsPopover.tsx` (4.5KB) | Skills selection popover |
| **TenantProvider** | `TenantProvider.tsx` (4.8KB) | React context for tenant data |

### 10.2 Custom Hooks

| Hook | File | Purpose |
|------|------|---------|
| `useHubData` | `useHubData.ts` (8.5KB) | SWR-based Google Workspace data fetching (calendar, tasks, drive, gmail) |
| `useGoogleChat` | `useGoogleChat.ts` (8.4KB) | Google Chat spaces, messages, members |
| `useSwipePanels` | `useSwipePanels.ts` (7.7KB) | Touch/swipe gestures for panel navigation (mobile) |
| `useStallDetector` | `useStallDetector.ts` (3.4KB) | Detects stalled AI responses |
| `useBusinessManager` | `useBusinessManager.ts` (2.5KB) | Business manager state |
| `useModalA11y` | `useModalA11y.ts` (2.2KB) | Modal accessibility (focus trap, escape) |
| `useWriteFetch` | `useWriteFetch.ts` (1.2KB) | Wrapper for POST/PUT/PATCH/DELETE fetches |
| `useKPIData` | `useKPIData.ts` (1.2KB) | KPI data fetching |
| `useCompanies` | `useCompanies.ts` (1.1KB) | Paperclip companies data |
| `useProjects` | `useProjects.ts` (1KB) | Paperclip projects data |

---

## 11. Deployment

### 11.1 Cloud Run Configuration

| Setting | Value |
|---------|-------|
| **Service Name** | `hub` |
| **Region** | `us-central1` |
| **GCP Project** | `rxfit-automation` |
| **Image** | `us-central1-docker.pkg.dev/rxfit-automation/cloud-run-source-deploy/hub:v3` |
| **CPU** | 1000m (1 vCPU) |
| **Memory** | 1Gi |
| **Min Instances** | 1 |
| **Max Instances** | 20 |
| **Concurrency** | 80 |
| **Timeout** | 300s |
| **Cloud SQL** | `rxfit-automation:us-central1:hub-pg` |
| **Domain** | `hub.casatrejo.com` |

### 11.2 Environment Variables

**From Secret Manager:**
- `NEXTAUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- `GEMINI_API_KEY`, `DATABASE_URL`, `GOOGLE_SERVICE_ACCOUNT_KEY`
- `PAPERCLIP_API_KEY`, `PAPERCLIP_AUTH_EMAIL`, `PAPERCLIP_AUTH_PASSWORD`
- `EXA_API_KEY`, `Anthropic_API_Key`, `anthropic_token`

**Plain-text env vars:**
- `NEXTAUTH_URL=https://hub.casatrejo.com`
- `PAPERCLIP_BASE_URL=https://rxfit-paperclip-11747747730.us-central1.run.app`
- `SUPERADMIN_EMAILS=danny@rxfitatx.com`
- `VERTEX_GCP_PROJECT=semantic-brain-desktop`
- `VERTEX_ENGINE_ID=semanticbrain_1779229063037`
- `DEFAULT_PAPERCLIP_COMPANY_ID=8f2acc3d-f2dc-4f8c-897e-7c400e91fd85`
- `NODE_ENV=production`

### 11.3 Deploy Command

```bash
gcloud run deploy hub --source . --region us-central1 --project rxfit-automation
```

> [!IMPORTANT]
> **Use `--update-env-vars` NOT `--set-env-vars`** when updating env vars. The `set` variant wipes ALL existing vars. This caused a production outage previously.

### 11.4 CI/CD (GitHub Actions)

- **CI** runs on PRs + pushes to master: TypeScript compilation (`tsc`) + Vitest tests
- **CD** deploys to Cloud Run on merge to master
- **Branch protection**: Required CI pass, no force pushes, no branch deletions
- **Pre-push hook (Husky)**: Runs `tsc` + `vitest` before every push

---

## 12. Critical Issues — MVP Fix Priority

> [!CAUTION]
> These issues were identified in the authoritative audit dated 2026-06-17 (`HUB_TECHNICAL_FUNCTIONAL_AUDIT_2026-06-17.md`). This audit supersedes all prior audit docs in the repo (several describe fixes that don't exist in code).

### 12.1 MUST FIX for MVP (Single-Tenant RxFit)

#### P0-1: Role Enforcement Gaps
- **Location:** `app/api/paperclip/[...path]/route.ts`
- **Problem:** Only `DELETE` is role-gated (line ~93). `POST`/`PATCH` check `assignedProjects` scope but **never the user's role**. A staff user can create agents, reassign issues, restart agents — all "admin" actions.
- **Fix:** Add a role → method → path enforcement table in the proxy route, mirroring the DELETE gate pattern.

#### P0-2: Client-Side-Only Safety Gate
- **Location:** `app/page.tsx` (client-side `runQualityGate`), `app/api/chat/score-context/route.ts`
- **Problem:** The interview flow, Pre-Cog validation, and 80% context-sufficiency score all live in the browser. The server routes (`executeAction.ts`, Paperclip proxy) execute mutations with **zero** knowledge of any score. Worse, `finalScore` defaults to `80`, so a non-numeric server response **passes**.
- **Fix:** Re-implement the gate server-side inside the write routes. Default score to 0. Only pass on an explicit numeric server score ≥ 80.

#### P1-1: Prompt Injection via Injected Context
- **Location:** `app/api/chat/route.ts` (lines ~128, 339, 353), `lib/gemini.ts` (`buildSystemPrompt`)
- **Problem:** Exa snippets, fetched URL text, Drive doc content, and attachments are interpolated into the system prompt with weak `##` / `[ ]` delimiters. Adversarial content can pose as instructions.
- **Fix:** Wrap all external content in explicit `<untrusted_data>…</untrusted_data>` XML fences. Never place external content inside the instruction region.

#### P1-2: Auth Resilience Regression
- **Location:** Google API routes (e.g., `app/api/google/tasks/route.ts` line ~15-17), `lib/auth.ts` line ~180
- **Problem:** Routes use `getToken()` → `token?.accessToken` and check `if (!accessToken)` but **never check `token?.error`**. After a failed refresh, the stale token persists → Google 401 → opaque 500 instead of a reauth prompt.
- **Fix:** Drop `accessToken` when `error` is set in the JWT callback, OR check `token.error` in every route and return a 401 reauth signal.

#### P1-3: Paperclip Data Model Misunderstanding
- **Location:** `lib/paperclipConfig.ts` (lines ~24-26), `lib/paperclip.ts` (line ~117)
- **Problem:** Code comments treat `RXFIT_CEO_COMPANY_ID` as a "CEO personal workspace" child of `RXFIT_COMPANY_ID` — but these are **two sibling, mutually-isolated Paperclip companies**. `assigneeUserId` is never threaded. The `GET /api/issues/:id/runs` aggregation may 404.
- **Fix:** Correct the model/comments. Thread `assigneeUserId`. Verify the runs route endpoint.

#### P1-4: Validation Theater
- **Location:** `lib/paperclip.ts` (lines ~218-224), throughout Zod schemas
- **Problem:** `paperclipFetch` returns **raw unvalidated `json as T`** on Zod mismatch. Schemas use `.passthrough()`. Dozens of unchecked `as` casts. Errors swallowed to empty arrays.
- **Fix:** Throw on list-endpoint schema failure. Distinguish empty results from errors. Alert on schema drift.

#### P1-6: Smaller Security Issues
- `delete_agent` allows `admin` but intent map requires `superadmin`
- `send_communication` resolves COO agent client-side; server trusts unvalidated `assigneeId`
- Exa masks bad API key as zero results
- Google write endpoints have no input-size validation (OOM risk)

#### CTO Audit Additional Findings (from `TECHNICAL_AUDIT_REPORT.md`)

> [!CAUTION]
> These were found in a separate CTO agent audit (June 7, 2026). Some may overlap with P0/P1 above but add important detail.

| Severity | Finding | Location |
|----------|---------|----------|
| **CRITICAL** | `/api/webhooks/google` auth bypass — if `GOOGLE_WEBHOOK_CHANNEL_TOKEN` env var is unset, any request with a non-empty token header passes auth | `app/api/webhooks/google/route.ts` |
| **CRITICAL** | Paperclip catch-all proxy tenant bypass — direct resource routes (`/api/issues/:id`, `/api/agents/:id`) bypass tenancy checks entirely | `app/api/paperclip/[...path]/route.ts` |
| **HIGH** | Companies list trailing-slash bypass — `/api/companies/` with trailing slash skips company list filtering | `app/api/companies/route.ts` |
| **MEDIUM** | Circuit breaker in-memory only — no distributed state, no half-open probe throttling, no TTL/cleanup | `lib/circuit-breaker.ts` |
| **MEDIUM** | Retry logic gateway timeout risk — 3 retries × 10s = 30s+ blocking | `lib/retry.ts` |
| **LOW** | KPI schemas missing from Zod — no validation on KPI writes | `app/api/kpis/` |
| **LOW** | OAuth scope over-privilege — full Gmail R/W on initial sign-in | `lib/auth.ts` |
| **LOW** | Gemini fallback latency — primary timeout + 2s delay + fallback attempt per request | `lib/gemini.ts` |

### 12.2 DEFERRED (Multi-Tenancy — Not Needed for MVP)

#### P0-3: No Paperclip-Level Tenant Isolation
- `paperclipConfig.ts` falls back to RxFit's URL/IDs
- Session cookie cached in a single global, not per-tenant
- **Why deferred:** Only RxFit uses the system. No second tenant to leak to.

#### P0-4: Vertex Semantic Brain Unscoped
- `searchSemanticBrain(query)` queries with no datastore filter
- The `dataStore` filter syntax is invalid per Google docs
- **Why deferred:** Only RxFit docs are indexed. No cross-tenant leak risk.

#### P1-5: Cross-Tenant pgvector Mixing
- Google webhook indexes Drive docs under hardcoded 'rxfit' tenant
- **Why deferred:** Only RxFit tenant exists.

### 12.3 P2 — Hygiene (Fix When Convenient)

| Issue | Location | Impact |
|-------|----------|--------|
| No timeout on Google fetches | `lib/google.ts` | Can hang to maxDuration |
| Calendar delete defaults to `primary` | Google calendar DELETE | Wrong-calendar deletion risk |
| Tasks/calendar/drive can't distinguish auth-expired from empty | Various routes | Confusing empty states |
| `suggestedTools`/`activeSkill` not validated against catalog | `app/api/chat/route.ts` | Invalid tool suggestions |
| Error-path message IDs use `String(Date.now())` | `app/page.tsx` | Collisions possible |
| Deprecated Exa API methods | `lib/exa.ts` | `searchAndContents`, `useAutoprompt` |
| Unencoded IDs in Google URLs | Various | Potential URL injection |
| KPI sync + embeddings default to 'rxfit' | Various | Hardcoded tenant |

---

## 13. Technical Debt

### 13.1 `page.tsx` Monolith (73KB / ~1,668 lines)

The main page file contains the **entire three-panel UI** — all state management, event handlers, UI rendering, and business logic in a single file. This makes it extremely difficult to:
- Navigate the code
- Test individual sections
- Make changes without risk of side effects
- Understand data flow

**State management:** All state lives as `useState` hooks in the top-level `HubPage` component (no Redux/Zustand). Key state categories:
- Chat: `messages`, `input`, `isTyping`, `activeModel`, `attachments`, `quotedReply`
- Interview: `interviewState`, `actionSpec`, `contextScore`, `isScoring`
- Skills/Tools: `activeSkill`, `suggestedTools`, `toolPanelOpen`, `toolArtifacts`
- Mobile: `mobileLeftOpen`, `mobileRightOpen`, `mobileTab`, `chatPanelOpen`
- A `messagesRef` (useRef) keeps an always-current snapshot to avoid stale closures

**Recommended approach:** Extract logical sections into components:
- `LeftPanel.tsx` — Command center with sections (partially done as `LeftPanelImpl` with `React.memo`)
- `CenterPanel.tsx` — Chat interface
- `RightPanel.tsx` — Execution layer
- `useChatOrchestrator.ts` — Chat state management (partially done)
- Shared state can be managed via React context or a state hook

### 13.2 `settings/page.tsx` Monolith (84KB)

The settings page is another massive single-page component with multi-tab form states covering: workspace setup, Google integrations, API key management, KPI configuration, user role management. Same decomposition issues as `page.tsx`.

### 13.3 `globals.css` Monolith (220KB / ~7,200 lines)

All application styles in a single CSS file. Contains:
- Design system tokens (CSS custom properties)
- Light/dark theme variants
- Component styles for every UI element
- Responsive breakpoints
- Animation keyframes

**Some decomposition has begun:** CSS Modules exist for `LeftPanelSections`, `GoogleChatPanel`, and `FounderLensWizard`. Continue migrating remaining styles to CSS Modules.

### 13.4 Stale Audit Documentation

The repo root contains ~15 audit/plan/report markdown files. **Several describe fixes that were never applied to the code.** The authoritative audit is `HUB_TECHNICAL_FUNCTIONAL_AUDIT_2026-06-17.md`. All other audit docs should be treated as historical and not trusted at face value.

---

## 14. Confirmed Healthy (Do NOT "Fix")

These areas have been verified as working correctly:

| Area | Why It's Fine |
|------|--------------|
| **Google Workspace data isolation** | Per-user OAuth token; Google enforces server-side |
| **Role + assignedProjects in JWT** | Server-verified in JWT callback, not client-spoofable |
| **SSRF protection** | DNS + internal-IP block + redirect handling in `content-fetch.ts` |
| **Gmail CRLF injection protection** | Header injection stripping in `google.ts` |
| **Paperclip company-scope filtering** | Works correctly in proxy route |
| **pgvector tenant scoping** | Queries are tenant-scoped in `vector-store.ts` |
| **Chat model rotation** | Gemini → Claude fallback, idle watchdog, pure `doSend` pattern |
| **Circuit breaker + retry + loop detector** | Wrap Paperclip calls properly |
| **CI pipeline** | tsc + vitest on every PR/push |

---

## 15. MVP Scope Summary

### What's IN the MVP (RxFit Single-Tenant)

- ✅ Three-panel operations hub
- ✅ AI Chat with Gemini/Claude model rotation
- ✅ Full Google Workspace integration (Calendar, Tasks, Drive, Gmail, Chat)
- ✅ Paperclip AI orchestration (issues, agents, runs)
- ✅ KPI Dashboard
- ✅ Interview/grill-me flow
- ✅ Founder Lens
- ✅ Settings/admin pages
- ✅ Role-based access control (superadmin, admin, staff, onboarding)
- ✅ Semantic search (Vertex AI + pgvector)
- ✅ Secure deployment (Cloud Run + Secret Manager + CSP)

### What's OUT of the MVP (Deferred)

- ❌ Multi-tenancy (per-tenant Paperclip isolation, Vertex scoping, tenant onboarding)
- ❌ Per-tenant session management
- ❌ Tenant-derived hostname routing
- ❌ Schema-level database isolation
- ❌ White-label customization beyond RxFit

### What MUST BE FIXED Before MVP is "Complete"

1. **P0-2** → Move safety gate server-side
2. **P0-1** → Add role enforcement to POST/PATCH proxy routes
3. **P1-1** → Fence untrusted content in AI prompts
4. **P1-2** → Fix auth resilience (check `token.error`)
5. **P1-3** → Correct Paperclip data model, thread `assigneeUserId`
6. **P1-4** → Make Zod validation strict, throw on schema mismatch
7. **P1-6** → Fix delete_agent role gate, validate `assigneeId` server-side

---

## 16. Key File Reference (Quick Lookup)

| Purpose | File | Size |
|---------|------|------|
| **Main UI** | `hub/app/page.tsx` | 73KB |
| **All styles** | `hub/app/globals.css` | 220KB |
| **Root layout** | `hub/app/layout.tsx` | 1.7KB |
| **Auth middleware** | `hub/middleware.ts` | 3.1KB |
| **Auth config** | `hub/lib/auth.ts` | 8.5KB |
| **Gemini AI engine** | `hub/lib/gemini.ts` | 30KB |
| **Claude AI** | `hub/lib/claude.ts` | 7.1KB |
| **Interview engine** | `hub/lib/interview.ts` | 21KB |
| **Paperclip client** | `hub/lib/paperclip.ts` | 19KB |
| **Paperclip config** | `hub/lib/paperclipConfig.ts` | 1.9KB |
| **Google operations** | `hub/lib/google.ts` | 17KB |
| **Google context** | `hub/lib/google-context.ts` | 8.2KB |
| **Database schema** | `hub/lib/schema.ts` | 9.7KB |
| **Tenant resolution** | `hub/lib/tenant-context.ts` | 1.9KB |
| **Chat API route** | `hub/app/api/chat/route.ts` | 23KB |
| **Paperclip proxy** | `hub/app/api/paperclip/[...path]/route.ts` | (catch-all) |
| **Zod schemas** | `hub/lib/zod-schemas.ts` | 9.1KB |
| **Vertex AI** | `hub/lib/vertex.ts` | 7.1KB |
| **Circuit breaker** | `hub/lib/circuit-breaker.ts` | 3.9KB |
| **Cloud Run config** | `service.yaml` | 4.2KB |
| **Deploy script** | `deploy.ps1` | 7KB |

---

## 17. For Claude Code: How to Work With This Codebase

### Getting Started
1. The codebase is at `C:\Users\danie\Documents\antigravity\vibrant-chandrasekhar\hub\`
2. Install deps: `cd hub && npm install`
3. Dev server: `npm run dev` (runs on port 3000, or 4200 if 3000 is occupied)
4. Run tests: `npm test` (Vitest)
5. Type check: `npx tsc --noEmit`

### Important Patterns
- **API routes use Next.js App Router** — `export const GET = ...`, `export const POST = ...`
- **Google routes use `withGoogleAuth` HOF** — wraps handlers with auth check
- **SWR hooks** power client-side data — mutations use `useWriteFetch`
- **CSS is vanilla** — no Tailwind. Design tokens in CSS custom properties.
- **The `page.tsx` monolith** — be careful editing this file. It's 73KB. Focus on the specific section you need.

### Testing
- Unit tests: `npm test` (Vitest, ~31 tests)
- Tests are colocated with source: `*.test.ts` files next to their modules
- E2E: `npm run test:e2e` (Playwright, may require browser setup)

### Deploy
- Pushes to `master` trigger CI → deploy via GitHub Actions
- Manual deploy: `.\deploy.ps1` from the repo root
- **NEVER use `gcloud run deploy --set-env-vars`** — use `--update-env-vars`
