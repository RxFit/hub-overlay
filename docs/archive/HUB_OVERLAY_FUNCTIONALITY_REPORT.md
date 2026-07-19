# Hub Overlay — Functionality & Operational-Friction Report

**Date:** 2026-07-19
**Audience:** An AI assistant assessing how to improve RxFit's operational workflows. This report inventories what the Hub Overlay system does today, what manual friction it removes, and where the known gaps are, so improvement recommendations can be grounded in the actual system rather than assumptions.

---

## 1. What the system is

The **CT Hub** ("Casa Trejo Operations Hub", live at `hub.casatrejo.com`) is a **three-panel operations-intelligence cockpit**: a single web app from which the founder (Danny, RxFit, Austin TX) runs the whole business by talking to an AI assistant that can both *answer* and *act*. It is the human control surface on top of a fleet of autonomous AI "employee" agents orchestrated through the **Paperclip** platform.

**The three panels:**

| Panel | Role | Contents |
|---|---|---|
| Left — Context Layer | *What* needs to happen | Live KPIs, Google Calendar, Google Tasks, Drive documents, project health |
| Center — AI Assistant | The control surface | Streaming chat (Claude Fable 5 → Sonnet, fallback to Gemini 2.5 Flash → Pro), Interview Mode, context-sufficiency gate, ~22 action intents, skills/tools system |
| Right — Execution Layer | *How* work gets done | Paperclip agent workforce: Issues, Agents, Routines, Goals, Spaces, agent runs, "CEO Pulse" health feed |

**Users:** Danny plus a small internal team. Roles: `superadmin | admin | staff | onboarding`, each scoped by `assignedProjects` to specific Paperclip companies. External clients are a planned second tenant, not yet live.

**Stack:** Next.js 14 (App Router, Node runtime, SSE streaming) · Postgres + Drizzle ORM + pgvector · NextAuth with Google OAuth (Workspace scopes) · Google Cloud Run (project `rxfit-automation`, service `hub`, us-central1) with CI-gated auto-deploy (typecheck + unit + Playwright e2e must pass on `master` before deploy fires) and startup-time idempotent migrations behind a `/api/healthz` readiness probe.

---

## 2. Useful functionality — complete inventory

### 2.1 AI assistant (center panel)

- **Core chat** (`/api/chat`): runs a three-source retrieval pipeline before every answer — Vertex AI Search ("Semantic Brain") over Google Drive/Workspace, pgvector internal memory (768-dim Gemini embeddings over `document_chunks`), and Exa.AI web search — then streams the model with circuit breaker, retry, rate limiting, model rotation, idle watchdog, and telemetry.
- **Mandatory `/grill-me` interview:** users cannot submit vague tasks. The assistant runs a structured interview, scores context sufficiency 0–100 (`/api/chat/score-context`), and gates task creation until the score passes. Pre-Cog validation checks the action before execution.
- **Intent detection** (`/api/chat/detect-intent`): classifies messages into ~22 action intents (create issue, send email, post to Chat, create task, etc.), each rendered as a confirm card; destructive actions are role-gated.
- **Enterprise-AI skill suite** (each with a dedicated right-side panel): Issue Tree, Decision Memo, McKinsey Critic, Prioritization, SCPR, Storyline, Meeting Prep, Data Insights, Deck Pipeline, Gamma Deck, AI Use Case Scorer — effectively a McKinsey-style analyst inside the chat.
- **Founder Lens:** per-org, per-role C-suite persona customization stored in the DB, so each agent speaks with the founder's calibrated voice/values.

### 2.2 Execution layer (Paperclip integration, right panel)

- **Authorization proxy** (`/api/paperclip/[...path]`): all Paperclip reads/writes flow through the Hub, filtered by the user's `assignedProjects`; deletes are additionally role-gated.
- **Surfaces:** Issue inbox, agent roster + run history, recurring Routines, Goal hierarchy, Projects, Spaces/Workspaces.
- **CEO Pulse** (`/api/paperclip/ceo-pulse`): scores every C-suite department ON_TRACK / DRIFTING / CRITICAL every 4 hours, computes a global health %, auto-injects corrective tasks for drifting departments, and only surfaces a `needs_you` item to the human on CRITICAL or repeated failure.
- **Unified activity feed** (`/api/feed`): merges Paperclip issues/agent activity with the user's own AI-action provenance.

### 2.3 Google Workspace integration (per-user OAuth)

- **Gmail:** read inbox, Gmail Focus strip, act (archive/label/reply) — `/api/google/gmail*`.
- **Calendar, Tasks, Drive:** CRUD and listing surfaced in the left panel.
- **Google Chat:** list spaces, post/read messages, unread counts; Jade (see §2.5) posts founder alerts into a dedicated Space.
- **Knowledge ingestion:** Drive webhooks (`/api/webhooks/google`) + `/api/embeddings/upsert` keep the pgvector store current.

### 2.4 KPIs and observability

- **KPI cards** with value/trend/direction, scope (global/project), visibility tiers, optimistic locking, and markdown notes; sources are manual, **GA4, Stripe, Google Search Console**, or Paperclip.
- **Cron sync** (`/api/kpis/sync`, constant-time secret auth): pulls source data, recomputes trends, and prunes expired agent memories and old event logs.
- **Admin dashboards:** `/admin/ai-health` (provider/telemetry health from `event_log` + `ai_action_log`), `/admin/knowledge` (knowledge-base manager), Paperclip infra health, role and workspace admin.
- **Self-auditor** (`/admin/auditor` + `/api/auditor/*`): the app discovers its own API routes and DB schema and audits its own footprint.

### 2.5 The agent organization (`orchestration/`)

Declarative definition layer for the AI workforce: each project has `PROJECT.md`, `KPI.json`, `context_config.json`, and per-role agent files (`SOUL.md`, `MEMORY.md`, `HEARTBEAT.md`, `FOUNDER_LENS.md`, governance docs).

**Org model:** Danny (board chair) → **Antigravity** (AI board member, orchestration + global error correction every 12h) → **CEO agent** → CMO / CTO / CFO / COO → sub-agents (SEO, AEO, GEO, CRO, Local Map Pack, Paid Ads; Lead Eng, QA, DevOps, Jules; Stripe Analyst, Billing Prep; Comms).

**Projects:**

| Project | What it does |
|---|---|
| **RxFit** | Flagship concierge executive-advisory firm + `rxfit.ai` copilot. Full C-suite, daily marketing-pillar heartbeats (Mon–Fri), weekly CTO sprint and CFO margin reviews, monthly P&L, weekly CEO briefing, 4-hour CEO Pulse. Governance gates: external comms, billing (staging only), strategic decisions, and employee-data mutations all require human approval. |
| **RxFit-SEO-Agent** | Autonomous SEO/content pipeline (keyword research → content generation → CMS publish → SERP tracking) explicitly replacing an external agency (Pneuma Media). |
| **JadeCoS ("Jade")** | AI Chief of Staff service: monitors KPIs across all projects, sends founder briefings/alerts to Google Chat, routes Jules (GitHub daily-audit) issues by severity. Purpose statement: reduce Danny's cognitive load to one actionable morning briefing. |
| **NotebookRx** | Account-intelligence notebook / institutional memory across client engagements, with pattern detection over client metrics. |
| **WellnessApp** | Client-facing advisory platform (booking, logistics, payments, client KPI dashboard). |
| **HUB** | The orchestration org that guards the Hub app itself (middleware, ingestion, auth, deploy stability). |
| **scripts/** | Bootstrap scripts that stand up each business as a Paperclip org (companies, agents, seed issues), logged in `BOOTSTRAP_LOG.md`. |

**Governance artifacts:** `CLIENT_ONBOARDING_CHECKLIST.md` (mandatory tenant credential-isolation checklist with workspace-isolation tests and a "never share" secrets list), `secrets-manifest.json` (per-tenant key scope).

### 2.6 Data model highlights (`hub/lib/schema.ts`)

All tables carry `tenant_id`. Key tables: `hub_users` (RBAC + project scoping, replaced a Google-Sheet roles list), `kpis`, `event_log` (append-only system audit), `agent_memory` (typed insights/decisions/error-patterns with TTL and relevance), `entity_links` (a graph between KPIs, memories, users), `document_chunks` (pgvector HNSW), `founder_lens_sections`, `tool_artifacts` (structured skill outputs), `ai_action_log` (append-only provenance for every AI side effect — routing metadata only, no message bodies, gate-token fingerprint).

### 2.7 Deployment & ops automation

CI-gated Cloud Run auto-deploy; migrations applied at container startup before traffic; secrets in GCP Secret Manager; one-command migration/domain/secret scripts; Paperclip watchdog/emergency-restart/log-rotate scripts; runbooks for AI-provider outage and protected workspaces.

---

## 3. Operational friction the system solves

This is the system's explicit reason to exist — the briefs repeatedly state the core pain: *"Danny wears every hat… a morning briefing that tells him exactly what needs attention today and nothing else."*

1. **Vague-task rework.** The mandatory interview + context-sufficiency gate + Pre-Cog validation force well-specified tasks before any agent acts, protecting a non-technical owner from misinformed or destructive actions.
2. **Context switching.** One cockpit unifies Gmail, Calendar, Tasks, Drive, Google Chat, KPIs, web research, internal knowledge, and the agent workforce — the founder never leaves the Hub.
3. **Manual KPI reporting.** Automated GA4/Stripe/GSC sync into live KPI cards with trend calculation replaces spreadsheet upkeep (the schema literally replaced the old KPI and roles Google Sheets).
4. **"Is everything on track?" checking.** CEO Pulse silently audits every department every 4 hours, self-corrects drifting ones, and escalates to the human only on CRITICAL — attention-by-exception instead of manual status polling.
5. **Status assembly.** Jade + the weekly CEO heartbeat auto-produce a single actionable briefing (KPIs vs targets, blockers, decisions needed).
6. **External agency spend.** The SEO agent replaces a paid external SEO agency end-to-end.
7. **Onboarding security drift.** Client onboarding is a mandatory repeatable checklist (isolated keys, workspace-isolation tests) instead of ad-hoc setup.
8. **Deploy/migration toil.** Green-CI auto-deploy, startup migrations behind a readiness gate, and watchdog auto-recovery remove manual release and babysitting work.
9. **Ungoverned AI action.** External comms, billing, strategy, and employee-data changes are human-approval-gated; every AI side effect lands in an append-only, body-redacted provenance log.
10. **Knowledge loss.** `agent_memory` + pgvector + NotebookRx retain decisions, insights, and patterns across sessions and advisors.

---

## 4. Known gaps and remaining friction (for improvement assessment)

From the June 2026 technical/functional audit (`HUB_TECHNICAL_FUNCTIONAL_AUDIT_2026-06-17.md`) and current architecture docs:

- **Multi-tenancy is aspirational.** The product is positioned as multi-tenant, but the orchestration/AI layers run single-instance with RxFit credentials; tenant separation rests on Hub-side `assignedProjects` filtering. Hard blocker before onboarding a second client.
- **Some guardrails were client-side at audit time:** role-tier enforcement and the misinformed-agent safety gate were partly cosmetic; the Vertex Semantic Brain was unscoped with broken filter syntax.
- **Prompt-injection exposure** via tool output injected into the model context.
- **Paperclip dependency risk:** the backend is fast-moving; validation against it was described as "theater," and there are two Paperclip instances (Cloud Run prod vs local dev sandbox) that must not be mixed.
- **Confirmed healthy** (don't re-solve these): per-user Google OAuth isolation, JWT-verified roles, SSRF/CRLF protection, tenant-scoped pgvector, model rotation + circuit breaker + idle watchdog.
- **In-flight plan:** `docs/architecture/RIGHT_PANEL_ARCHITECTURE_2026-07-19.md` lays out making the right panel a full Paperclip management surface (feature→endpoint map for Issues, Routines, Goals, Agents, Spaces).

---

## 5. Pointers for the assessing AI

Key files to consult for depth: `hub/README.md` · `hub/lib/schema.ts` · `hub/app/page.tsx` · `hub/app/api/chat/route.ts` · `hub/app/api/paperclip/ceo-pulse/route.ts` · `HUB_TECHNICAL_FUNCTIONAL_AUDIT_2026-06-17.md` · `docs/architecture/RIGHT_PANEL_ARCHITECTURE_2026-07-19.md` · `orchestration/RxFit/context_config.json` · `orchestration/RxFit/agents/ceo/HEARTBEAT.md` · `orchestration/CLIENT_ONBOARDING_CHECKLIST.md` · `orchestration/BOOTSTRAP_LOG.md`.

When proposing workflow improvements, weigh them against: (a) the attention-by-exception philosophy (never add founder-facing noise), (b) the governance gates (human approval for external/financial/strategic actions is intentional, not friction to remove), and (c) the single-tenant reality behind the multi-tenant façade.
