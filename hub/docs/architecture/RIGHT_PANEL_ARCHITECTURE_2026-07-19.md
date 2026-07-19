# Right Panel Architecture — Research & Ground-Up Design

Date: 2026-07-19
Status: Research / design proposal (no code changes yet)
Scope: Rebuild the Hub's right panel ("Execution Layer") as a full management
surface for the Paperclip org — Issues, Routines, Goals, Agents, and
Workspaces all interactable, editable, and manageable without leaving the Hub.

---

## 1. Framing

The Hub's mental model:

- **Left panel — Context Layer.** *What* needs to happen: Google Tasks,
  Calendar events, shared Drive documents, KPIs.
- **Center — AI Assistant.** The conversational control surface, with
  Interview Mode, the context-sufficiency gate, Pre-Cog validation, and 17
  action intents.
- **Right panel — Execution Layer.** *How* the work gets done: the agent
  workforce. Today it renders a read-mostly `ExecutionFeed` + C-Suite
  `BusinessManagerPanel`, with a "📎 Paperclip →" deep link for everything
  else.

The goal of this redesign: the right panel **is** the Paperclip workspace.
Everything Paperclip offers should be reachable, editable, and manageable in
place, with the AI Assistant's guardrails (role gates, gate tokens, interview
flows) wrapped around every write.

---

## 2. What Paperclip actually is (research summary)

Source: docs.paperclip.ing, paperclip.inc/docs reference, and the
`paperclipai/paperclip` GitHub repo (MIT licensed).

Paperclip is a Node.js server + React UI that orchestrates teams of AI agents
("an AI company operating system"). Key properties relevant to us:

- **Everything is a REST resource.** The entire product UI is backed by a JSON
  API under `/api`, company-scoped as `/api/companies/{companyId}/...` for
  collections and `/api/{resource}/{id}` for single entities. There is nothing
  the Paperclip UI can do that the API cannot.
- **Auth model.** Board users (humans) authenticate with session cookies or
  board API keys (`pcp_board_` prefix, `Authorization: Bearer`). Agents use
  agent API keys or short-lived run JWTs, always scoped to one company. Bearer
  tokens win over cookies. `GET /api/cli-auth/me` resolves a board key's
  identity. The Hub already authenticates via email/password session with
  API-key fallback (`hub/lib/paperclipSession.ts`) — a board API key is the
  cleaner long-term path (no sign-in storms, no cookie expiry logic).
- **Heartbeat execution model.** Agents don't run continuously; they wake in
  heartbeats (timer, assignment, mention, on-demand `POST
  /api/agents/{id}/wakeup`). Every run produces structured logs, cost events,
  and an audit trail.
- **Live updates.** Paperclip pushes runtime/activity updates to its own
  browser UI in real time; the REST surface is poll-friendly (the Hub
  currently polls via `useFeed`).
- **Plugin system.** First-class instance-wide plugins with out-of-process
  workers, capability-gated host services, agent-tool contributions, and UI
  extension slots (`page`, `sidebar`, `dashboardWidget`, `detailTab`,
  `toolbarButton`, etc.) with a host bridge (`usePluginData` /
  `usePluginAction`) and a shared component kit.

### 2.1 Feature → API surface map

| Right-panel feature | Read | Write / act |
|---|---|---|
| **Issues** | `GET /companies/{id}/issues` (filters: `status`, `assigneeAgentId`, `projectId`, `q`, `originKind`, `includeRoutineExecutions`), `GET /issues/{id}` (returns project, goal, ancestors, blockers, plan document, workspace, work products), `GET /issues/{id}/comments`, `/documents`, `/attachments`, `/activity`, `/runs` | `POST /companies/{id}/issues`, `PATCH /issues/{id}` (accepts `comment`, `reopen`, `interrupt`), `POST /issues/{id}/checkout` / `/release`, `POST /issues/{id}/comments` (@-mentions wake agents) |
| **Routines** | `GET /companies/{id}/routines`, `GET /routines/{id}` (triggers, recent runs, active execution issue), `GET /routines/{id}/runs` | `POST /companies/{id}/routines`, `PATCH /routines/{id}` (pause/resume via `status`), `POST /routines/{id}/run` (manual fire), trigger CRUD `POST /routines/{id}/triggers`, `PATCH|DELETE /routine-triggers/{id}`, `/rotate-secret` |
| **Goals** | `GET /companies/{id}/goals`, `GET /goals/{id}` (hierarchy via `parentId`, levels company→team→agent→task) | `POST /companies/{id}/goals`, `PATCH /goals/{id}` (status: planned/active/achieved/cancelled, re-parent, owner), `DELETE /goals/{id}` |
| **Projects** | `GET /companies/{id}/projects`, `GET /projects/{id}` (goals, workspaces, primary workspace) | `POST /companies/{id}/projects` (can seed a workspace in the same call), `PATCH /projects/{id}`, `DELETE` |
| **Agents** | `GET /companies/{id}/agents`, `GET /agents/{id}` (chain of command, config), `GET /companies/{id}/org` (+ `.svg`/`.png`), `GET /agents/{id}/skills`, `/configuration`, `/config-revisions` | `POST /companies/{id}/agents` (hire), `PATCH /agents/{id}`, `/permissions`, `POST /agents/{id}/pause` / `/resume` / `/terminate` / `/clear-error`, `POST /agents/{id}/wakeup` (with issue/reason payload), `/heartbeat/invoke`, key mgmt, `POST /agents/{id}/skills/sync`, config-revision rollback |
| **Workspaces** | `GET /projects/{id}/workspaces` (mode, provider, status, runtime config inheritance) | `POST /projects/{id}/workspaces`, `PATCH`, `DELETE`, `POST .../runtime-services/{start\|stop\|restart}` |
| **Inbox / attention** | Issue list filters `unreadForUserId=me`, `inboxArchivedByUserId=me`; blocked-attention view `GET /companies/{id}/issues?attention=blocked` + `/issues/count?attention=blocked` (newer builds) | `PATCH /issues/{id}` (`hiddenAt`, comments, reopen) |
| **Costs & budgets** | `GET /companies/{id}/costs/summary`, `/by-agent`, `/by-agent-model`, `/by-provider`, `/by-project`, `/window-spend`, `/budgets/overview` | `PATCH /companies/{id}/budgets`, `POST /budgets/policies`, `POST /budget-incidents/{id}/resolve` |
| **Activity** | `GET /companies/{id}/activity` (filters `agentId`, `entityType`, `entityId`), `GET /issues/{id}/activity`, `GET /heartbeat-runs/{runId}/issues` | (read-only for us) |
| **Skills** | `GET /companies/{id}/skills`, `/skills/{id}`, `/skills/{id}/files?path=SKILL.md` | `POST /companies/{id}/skills`, `/skills/import`, `/skills/scan-projects`, `PATCH .../files`, `DELETE` |
| **Approvals** | `GET /issues/{id}/approvals`, pending count in dashboard | `POST /issues/{id}/approvals`, approval decisions |
| **Dashboard** | `GET /companies/{id}/dashboard` — one call: agent counts (active/running/paused/error), task counts, month spend vs budget, pending approvals, budget incidents | — |

Two upstream gotchas worth encoding in our client:

1. **Routine-execution issues are hidden by default.** `issues.list` excludes
   `originKind=routine_execution` unless `includeRoutineExecutions=true`
   (a long-running source of upstream bugs — #2251, #3282). Our Routines view
   must always pass the flag; the Issues view should expose it as a filter.
2. **Status vocabulary drift.** The Hub already normalizes Paperclip statuses
   and priorities into Linear-style types (`hub/lib/paperclip.ts:97-128`).
   Every new resource (routines, goals, workspaces) needs the same treatment —
   normalization lives in `hub/lib/paperclip.ts`, never in components.

---

## 3. Where the Hub is today (codebase audit summary)

- **Shell**: `hub/app/page.tsx` — `panel-left` (Context), `panel-center`
  (chat), `panel-right` (Execution). Right panel = `ProjectHealthSection` +
  `ExecutionFeed` (`hub/app/components/RightPanelSections.tsx`) +
  `BusinessManagerPanel` (C-Suite lens), plus the external deep link built
  from `NEXT_PUBLIC_PAPERCLIP_URL`.
- **Data path**: client hooks (`useFeed`, `useBusinessManager`) → Next.js
  proxy `hub/app/api/paperclip/[...path]/route.ts` → Paperclip Cloud Run
  instance. The proxy is the security boundary: upstream prefix allowlist
  (`/api/companies`, `/api/issues`, `/api/agents`, `/api/runs`,
  `/api/projects`, `/api/health`), role-tier gate on writes, HMAC gate-token
  requirement on `POST /api/issues`, protected-workspace delete guard,
  company-scope ownership pre-checks, idempotency keys, circuit breaker.
- **AI layer**: Interview Mode (`hub/lib/interview.ts`, 17 intents) →
  detect-intent (Gemini primary, Claude fallback) → score-context gate (mints
  gate tokens, fails closed on high-stakes) → Pre-Cog validator →
  `executeAction.ts` dispatcher → Google/Paperclip calls.
- **Gap**: the right panel is a *feed*, not a *workspace*. Only issues/agents/
  runs/projects are proxied; routines, goals, workspaces, skills, costs,
  activity, inbox, approvals are reachable only by leaving the Hub for
  Paperclip's own UI (which, per the mobile screenshots, is where Danny ends
  up doing triage today — including watching CMO runs fail).

---

## 4. Integration options considered

### Option A — Hub-native panel views over the Paperclip REST API (recommended)
Extend the existing proxy + normalization + hooks pattern to the full resource
map and build focused right-panel views for each feature.

- ✅ Keeps the Hub's security model (role tiers, gate tokens, protected
  workspaces) on every write — Paperclip's own UI has none of our guardrails.
- ✅ Deep AI integration: every entity row can inject context into chat or
  launch an Interview Mode flow; conversely `executeAction` results can
  optimistically update panel views.
- ✅ Consistent mobile-first styling (Paperclip's UI on a phone is the pain
  the screenshots show).
- ✅ Already proven: issues/agents/runs/projects flow works this way today.
- ⚠️ Cost: we re-implement UI Paperclip already has. Mitigation: build
  *opinionated, compact* views, not clones — and keep deep links for
  long-tail screens (org chart SVG, config revision diffs, plugin manager).

### Option B — Embed Paperclip's UI (iframe)
- ❌ No iframe embed exists today and for good reason: separate session/auth
  domain, no styling control, zero AI-assistant integration, poor mobile
  behavior, and our proxy guardrails are bypassed entirely (writes would go
  straight to Paperclip under the board session).
- Verdict: rejected, including as a stopgap.

### Option C — Build Hub features as a Paperclip plugin
Paperclip's plugin system is genuinely good (UI slots, capability-gated
workers, agent tools), but it answers the inverse question — extending
*Paperclip's* UI. The Hub is the shell; Paperclip is the engine.
- Verdict: rejected for the right panel. Keep it in mind for the opposite
  direction later (e.g. a Paperclip plugin that exposes Hub KPIs to agents as
  tools).

### Option D — Fork/vendor Paperclip's React UI components
- ❌ MIT allows it, but their `ui/src` is coupled to their host bridge and
  moves fast (very active repo, ~daily merges). Vendoring means owning drift
  forever. Their plugin SDK explicitly forbids importing `ui/src` internals —
  the same instability warning applies to us.
- Verdict: rejected. Copy *patterns* (their inbox badge logic, blocked-
  attention taxonomy), not code.

**Decision: Option A**, with deep links preserved as escape hatches.

---

## 5. Proposed architecture

### 5.1 Panel structure

The right panel becomes a **workspace with a segmented nav** (icon tabs),
mirroring Paperclip's own information architecture so the deep links stay
coherent:

```
┌─ panel-right ─────────────────────────────┐
│ [Pulse] [Issues] [Routines] [Goals]       │
│ [Agents] [Spaces]              📎 ↗       │
├───────────────────────────────────────────┤
│  <active view>                            │
│                                           │
├───────────────────────────────────────────┤
│  Attention strip (inbox/blocked/approvals)│
└───────────────────────────────────────────┘
```

1. **Pulse (default)** — evolution of today's view: `GET /dashboard` headline
   (agents active/running/error, open/blocked tasks, month spend vs budget,
   pending approvals) + the existing `ExecutionFeed` + `BusinessManagerPanel`.
   One API call for the headline; the feed keeps its current data path.
2. **Issues** — compact list with the Hub's normalized statuses; filters for
   status/agent/project; detail drawer (description, comments, blockers, runs,
   plan document); actions: comment (@-mention wakes the agent), reassign,
   change state, reopen, interrupt run. Creation stays AI-first: "New issue"
   launches the existing `create_paperclip_issue` interview rather than a raw
   form — this is the error-reduction thesis applied to the panel.
3. **Routines** — list with status (active/paused), schedule summary, last-run
   outcome (from `/routines/{id}/runs`); actions: pause/resume, run now,
   edit via interview; detail shows trigger list + run history and links each
   run to its execution issue (`includeRoutineExecutions=true` always).
4. **Goals** — indented hierarchy (company → team → agent → task) with status
   chips; actions: create/edit/re-parent/close via interview; each goal links
   to its issues and projects.
5. **Agents** — roster grouped by org line: status, current run, month spend
   vs budget (from `/costs/by-agent`), last heartbeat outcome; actions: wake,
   pause/resume, clear error, view runs; hire/terminate remain interview-gated
   admin intents. This replaces the mobile triage loop in the screenshots —
   "CMO failed after 3 minutes" becomes a card with the run transcript link,
   a Clear error button, and a Wake button.
6. **Spaces (Projects & Workspaces)** — projects with their goal links and
   workspace list (mode, branch, runtime status); actions: start/stop/restart
   runtime services; create/edit via interview (admin tier).
7. **Attention strip** (persistent footer) — unread/blocked/approval counts
   (`unreadForUserId=me`, `attention=blocked` count endpoint, dashboard
   `pendingApprovals`), tapping opens a filtered Issues view. This is the
   Hub-side replacement for Paperclip's Inbox badge (the red "6" in the
   screenshots).

Costs, Activity, and Skills do **not** get top-level tabs initially. Costs
surfaces inside Pulse and Agents; Activity surfaces inside issue/agent
detail; Skills surfaces inside agent detail. Full-page versions stay behind
deep links until usage proves they need to be native.

### 5.2 Data layer

- **Proxy allowlist expansion** (`hub/app/api/paperclip/[...path]/route.ts`):
  add `/api/routines`, `/api/routine-triggers`, `/api/goals`,
  `/api/heartbeat-runs`, and the company-scoped subpaths for `skills`,
  `costs`, `budgets`, `activity`, `dashboard`. Every addition gets the same
  treatment as existing prefixes: company-scope pre-check, role-tier write
  gate, idempotency on POST.
- **Write-guard matrix** (extends `hub/lib/proxyAuthz.ts`):
  - member tier: comments, issue state moves, routine run-now
  - admin tier: routine/goal/project CRUD, agent pause/resume/wake,
    runtime-service control
  - superadmin + type-to-confirm (existing pattern): terminate/delete agent,
    delete workspace, budget changes
  - gate-token (HMAC, minted only by score-context pass) required for all
    *creation* intents, as with `POST /api/issues` today.
- **Client library** (`hub/lib/paperclip.ts`): add typed, Zod-validated,
  normalized accessors per resource (`getRoutines`, `getGoals`,
  `getWorkspaces`, `getDashboard`, `getCostsByAgent`, …) following the
  existing normalize-at-the-edge convention.
- **Hooks** (`hub/app/hooks/`): one hook per view (`useRoutines`, `useGoals`,
  `useAgentsRoster`, `useAttention`) built on the `useFeed` polling pattern —
  shared 30–60s poll with jittered backoff, per-tab focus refetch, and
  optimistic updates after `executeAction` completes. No websocket work in
  v1; Paperclip's REST is poll-friendly and the feed already works this way.
- **Version pinning**: we run our own Paperclip instance, so the API contract
  moves only when we upgrade it. Record the pinned Paperclip version in
  `paperclipConfig.ts` and smoke-test the proxy allowlist against
  `/api/health` + one read per resource in CI (extend the existing admin
  health route).

### 5.3 AI Assistant integration (the differentiator)

Symmetry rule: **everything visible in the panel is injectable; every write
in the panel routes through the same gates as chat.**

- Each row/card gets the two existing inject affordances: recall
  (`onInjectChat`) and act (`onInjectAction` → Interview Mode with the entity
  pre-filled, so the interview fast-forwards past known answers via
  `fastForwardInterview`).
- New Interview Mode intents (extending the 17):
  - `create_routine`, `update_routine`, `run_routine`
  - `create_goal`, `update_goal`
  - `wake_agent` (lighter than `restart_agent`), `clear_agent_error`
  - `manage_workspace_runtime` (start/stop/restart services)
  - `resolve_budget_incident` (admin, high-stakes)
  Read-only additions (`view_costs`, `view_activity`) can bypass interviews
  entirely, like `check_agent_status` today.
- The score-context gate's per-intent quality dimensions get entries for the
  new intents (e.g. a routine needs: assignee, schedule or trigger, issue
  title template, concurrency expectation — exactly the fields `POST
  /routines` requires). This is where "interview mode reduces errors" becomes
  concrete: the gate refuses to mint a token until the routine spec is
  actually executable.
- Panel state feeds chat context: the active tab + selected entity are
  appended to the orchestration context in `hub/app/api/chat/route.ts`, so
  "why did this fail?" while looking at a run resolves without re-asking
  which run.

### 5.4 Mobile

The screenshots show the real usage pattern: phone, Paperclip's UI, squinting
at failed runs. The right panel already participates in the Hub's swipeable
drawer layout; the tabbed structure above collapses naturally (segmented nav
becomes horizontally scrollable; attention strip docks above the bottom nav).
Success criterion: the triage loop in the screenshots — see failure → read
transcript → clear error → wake agent — completes in the Hub without opening
Paperclip.

---

## 6. Phasing

| Phase | Scope | Notes |
|---|---|---|
| **1. Pulse + Attention** | Dashboard endpoint, attention strip, tab scaffold; ExecutionFeed moves under Pulse | Pure additive; no new write paths |
| **2. Issues + Agents** | Full native views + detail drawers; wake/pause/clear-error/comment writes; run transcripts | Highest-value: replaces mobile triage; resources already normalized |
| **3. Routines + Goals** | Views + new interview intents + score-context dimensions | Requires proxy allowlist + authz matrix expansion |
| **4. Spaces** | Projects/workspaces view, runtime-service controls | Admin-tier writes |
| **5. Long tail** | Native Costs/Activity/Skills pages, approvals workflow | Only if deep-link friction proves it out |

Each phase ships behind its own flag and keeps the Paperclip deep link as the
fallback, so nothing regresses if a view lands rough.

## 7. Risks

- **Upstream contract drift** — mitigated by self-hosting (we control
  upgrades), version pin, CI smoke reads, and normalization-at-the-edge.
- **Write amplification** — more write surfaces = more blast radius; every
  new write goes through the existing tier/gate-token/protected-workspace
  machinery, and destructive ops keep type-to-confirm.
- **Routine-execution visibility** — always pass `includeRoutineExecutions`
  where routine work must be seen (upstream's most-reported bug class).
- **Polling load** — one dashboard call + per-active-tab list poll is bounded;
  the proxy's circuit breaker already protects the upstream instance.
- **Scope temptation** — Paperclip has ~15 feature areas; the tab set above
  deliberately caps native surface at six. Deep links are a feature, not a
  failure.
