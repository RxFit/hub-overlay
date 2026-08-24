# Phase 3 — Rewiring the Right Panel onto the `agy` Engine

**Status:** design, approved for execution · **Written:** 2026-08-22
**Supersedes for the right panel:** `RIGHT_PANEL_ARCHITECTURE_2026-07-19.md` (Paperclip era, archaeology only)
**Sits under:** `scripts/agy/README.md` (migration blueprint) — this doc is the Phase 3 row of that roadmap, expanded.

---

## 1. What Phase 3 is

The right panel is the Hub's **Execution Layer** — *how* work gets done, opposite the
left panel's *what* (Tasks, Calendar, Drive, KPIs) and the center's *conversation*.
It was built against Paperclip: orgs, agents, issues, routines, goals, spaces. Paperclip
is retired, so the panel is a fully-built management surface with no engine behind it.

Phase 3 points it at the engine that actually runs work now: the **`agy` CLI on the
subscription allotment**, executed by a desktop worker off a Postgres job queue, with
every run written to the `ai_runs` ledger.

The panel stops being a **workspace browser** (drill into an org, list its agents,
inspect a routine) and becomes an **execution instrument**: what ran, on whose
allotment, at what cost, and whether the machinery that runs it is alive.

---

## 2. Ground truth — what the panel is today

Measured on `origin/master` at `1dfd985`, not recalled. This is the honest starting
position, and several items are worse than "unwired".

### The panel is not degraded, it is blank

`RightPanel` is defined inline at `hub/app/page.tsx:125-236`. Every tab renders
against `activeCompany` (`page.tsx:158`), which is derived by matching `activeProject`
against `projects` — and `projects` comes from the Paperclip-backed KPI call. With
Paperclip gone, `activeCompany` is always `undefined`, so **all five tab views render
their "Select a workspace…" empty state**. The tabs are not showing stale data; they
show nothing, and they show it in a way that reads like the user forgot to pick
something.

Within the Pulse tab: `PulseStrip` and `AttentionStrip` silently return `null`
(their `dashboard` prop never arrives), `ProjectHealthSection` renders an error card,
and the feed shows a **"Paperclip Unavailable"** info card — because
`app/api/feed/route.ts:106-119` catches the upstream throw and pushes a synthetic
feed item, turning an outage into an HTTP 200. The panel header still links out to a
`📎 Paperclip →` workspace URL (`page.tsx:151-193`).

### What is genuinely alive and worth keeping

- **The feed presentation layer** — `app/components/RightPanelSections.tsx`:
  `ExecutionFeed` (`:189`), `FeedSkeleton` (`:33`), `FeedFilterBar` (`:123`), date
  grouping (`:158-187`), relative timestamps (`:339`). This is good, tested UI that
  is agnostic about what fills it. **Keep the component, swap the source.**
- **The `FeedItem` contract** and the inject affordances (`onInjectChat` for
  read-style taps, `onInjectAction` for anything routed through Interview Mode).
  "Everything visible is injectable" is the one pattern from the Paperclip design
  that survives intact and should be preserved deliberately.
- **`useStallDetector`**, the Pulse/Attention shells, `lib/ai-audit.ts` and
  `lib/ai-action-feed.ts` — the AI action feed is currently the *only* live data
  reaching the panel.
- **`lib/runs.ts`** — the ledger, already engine-agnostic.

### The reads Phase 3 needs mostly already exist

This is the reason Phase 3 is small. The queries were written during Phase 2 and 2.5
and are sitting unused:

| Need | Function | State |
|------|----------|-------|
| Runs feed | `listAiRuns()` — `lib/runs.ts:209` | Exists, tested, **zero consumers**. Its own doc comment says "the Phase 3 panel route will clamp". |
| Allotment share | `chatServeCounts()` — `lib/runs.ts:197` | Exists, powers dispatch-health |
| Queue depth | `queueDepths()` — `lib/dispatch-store.ts:538` | Exists |
| Recent jobs | `listRecentJobs()` — `lib/dispatch-store.ts:560` | Exists |
| Worker liveness | `listWorkers()` — `lib/dispatch-store.ts:586` | Exists |
| Cancel a job | `cancelJob()` — `lib/dispatch-store.ts:157` | Exists |
| Alert/recovery history | — | **Missing.** `event_log` rows are durable and written by `lib/dispatch-alerts.ts:313`, and read back at `:271-298`, but only *internally* for dedup. No exported reader, no route. |

So the panel core is largely **wiring plus one new reader**, not new data plumbing.

---

## 3. Decisions

Four forks were put to the owner and settled. Everything else follows a stated default.

### 3.1 Scope — "runs + dispatch rail"

The panel shows two planes now and a third later:

1. **Runs plane** (the feed): every `ai_runs` row — engine, model, status, typed
   error class, latency, tokens, source. This replaces the Paperclip activity feed
   in the existing `ExecutionFeed` component.
2. **Dispatch plane** (a live ops rail): worker heartbeat and version, queue depth,
   allotment-vs-metered share, and the alert/recovery timeline.
3. **GitHub delivery plane** — **deferred to an explicit fast-follow PR.** This is
   where Hermes' real work lands (branches, PRs, CI), and today **the Hub cannot see
   any of it**: no Hub code reads GitHub, and `isHubTaggedPost` has no non-test
   caller. It needs a server-side GitHub token before it is buildable, so it is not
   allowed to hold up the rest of Phase 3.

**Why this split:** the runs ledger answers "what did the engine do", the dispatch
rail answers "is the engine going to keep working". Together they cover the panel's
actual job. Delivery ("did the work merge") is a different question with a different
credential dependency.

### 3.2 Writes — ops writes only

Two admin-gated writes, both about the machinery rather than the work:

- **Cancel a job** (wraps the existing `cancelJob()`)
- **Fire a probe** (the existing end-to-end health probe, which spends tokens)

**No work briefing in Phase 3.** "Brief an `agy` run from the panel" is Phase 4 —
it needs the reborn tooling (Interview Mode, the context-sufficiency gate, Pre-Cog)
pointed at run-briefing first. Shipping a brief button before that gate exists would
route un-gated writes into the execution engine, which is exactly the guardrail the
old panel got right.

### 3.3 Order — strict series: keys → panel → delete

One arc of 4–6 PRs, each green before the next starts. **Not parallel**, because the
first PR is a blocking safety migration and the last one deletes the code the middle
one is replacing.

The blocking item: **`hub/app/api/settings/keys/route.ts` stores every Hub-managed
API key in Paperclip's secret store.** Its own header says *"No secrets are stored in
the HUB database — all persistence is in Paperclip."* Deleting that dependency
before migrating the store destroys the Hub's key management. **This is PR 1, and
nothing else starts until it lands.**

> **Correction (2026-08-22, applied in PR 1).** This section originally named
> `lib/paperclip.ts` as the blocking file. That is wrong: `keys/route.ts:17`
> imported only **`lib/paperclipSession.ts`** and never `lib/paperclip.ts`.
> `paperclipSession.ts` is also the *only* auth path to Paperclip, so it is the
> file whose deletion closes any remaining export window — check before PR 5
> removes it, not after.

### 3.4 Face and access — savings-led, admin-first

The Pulse headline leads with **what the migration bought**: allotment share,
estimated dollars avoided, worker status, active alerts. The panel's first sentence
to the operator should be "the allotment served 94% of chat today" — not a run count.

**Admin + superadmin only for now.** Chat ledger rows have no attribution
(§6.5), so there is no safe way to scope a staff user's view to their own runs.
Ledger attribution is the named follow-up that opens the panel to staff.

---

## 4. Execution plan

Each PR is real (non-draft), green on typecheck + vitest + Playwright before the next
begins.

### PR 1 — Migrate Hub-managed API keys off Paperclip · **BLOCKING**

Move `/api/settings/keys` persistence from Paperclip's secrets API into the Hub's own
encrypted storage. Preserve the existing security contract exactly: admin/superadmin
full CRUD on assigned workspaces, staff reads key *names* only, onboarding blocked,
and **secret values are never returned to the browser** (write-only).

Ships with a migration path for existing stored keys, and tests that pin the
role matrix and the write-only property. No panel changes.

### PR 2 — Panel core: the runs feed

Add `GET /api/runs` (admin-gated, clamped limit) over `listAiRuns()`. Map
`AiRunRecord` → the existing `FeedItem` contract and point `ExecutionFeed` at it.
Delete the tab bar's dead workspace tabs; the panel becomes Pulse + Runs.

Preserve the inject affordances: tapping a run injects a read-style question about
it ("why did run X fail with `empty`?").

> **✅ Shipped 2026-08-24.** As specified, with four recorded deltas:
> `/api/runs` also merges the caller's own recent AI actions (the one live
> source the old feed had — §2's keep-list — so it survives the source swap);
> `ExecutionFeed` no longer renders `BusinessManagerPanel` (dead ceo-pulse
> source, §6.4's rule — the file itself still dies in PR 5, along with the
> now-unreachable `FounderLensWizard` wiring it triggered); the `📎 Paperclip`
> header link and the dead `/api/paperclip/dashboard` 60s poll are gone; the
> panel defaults to the Runs tab for admins, and non-admins get a quiet
> admin-only state with no fetch. The mapper (`lib/run-feed.ts`) surfaces
> typed error classes only — `ai_runs.error` message text never reaches a
> card or a chat injection (the hardening review's content rule applied at
> the presentation layer).

### PR 3 — The dispatch rail

New exported reader for alert/recovery history from `event_log` (the one genuinely
missing query), then the rail itself: worker heartbeat + version drift, queue depth,
allotment share, alert timeline. Rebuild `PulseStrip` savings-led per §3.4 and
`AttentionStrip` over live alerts.

### PR 4 — Ops writes

Admin-gated cancel-a-job and fire-a-probe, both wrapping existing functions, both
confirmed before firing (the probe spends tokens).

### PR 5 — The rip-out

Measured inventory (counted on `1dfd985`, not estimated):

| Group | Lines | Disposition |
|-------|-------|-------------|
| `lib/paperclip.ts` (694), `lib/paperclipSession.ts` (159), `lib/paperclip-health.ts`, the whole `app/api/paperclip/**` tree, `/api/admin/paperclip-health`, `/api/admin/workspaces` | **2,406** | whole-file delete |
| `*TabView.tsx` ×5 + `BusinessManagerPanel.tsx` | **1,303** | whole-file delete (already unreachable — §2) |
| `lib/executeAction.ts:644-1280` dead action cases | **~640** | partial delete |
| Paperclip branches in `/api/companies`, `/api/projects`, `/api/feed`, `/api/kpis`, `/api/chat`; prompt rules in `lib/gemini.ts:62-119` | few hundred | partial delete — **these five routes break the moment `lib/paperclip.ts` goes** |

≈ **4,350 lines of whole-file deletion** plus the partials.

Tests: ~2,200 lines across files matching `paperclip`. **That match set is not the
delete set** — `tests/embeddings-upsert-auth.test.ts` matches only because of the
`PAPERCLIP_API_KEY` false positive (§6.1) and must be **kept**. Check each file
before deleting it.

Includes the **assistant cleanup**, which is easy to forget because it is not in a
file named `paperclip`:

- `lib/gemini.ts:62-119` — system-prompt rules still instruct the assistant to
  apologize for Paperclip "warming up".
- `lib/executeAction.ts:644-1280` — ~640 lines of dead Paperclip action cases.
- `lib/interview.ts:945-947` — the fail-open intent predicate (§6.2).

### PR 6 (fast-follow, not blocking) — GitHub delivery plane

Once a server-side GitHub token exists: read branches/PRs/CI for the repo and add
delivery state to the panel, giving Hermes' orchestration an observable outcome.

---

## 5. Sequencing note for whoever picks this up

The series is strict, but **PR 2 is where the panel stops looking broken to the
owner**. If time is short, land PR 1 → PR 2 and pause; the panel is then honest and
useful, and the rip-out can wait. Do not reorder to put the deletion earlier — the
five shared routes break the moment `lib/paperclip.ts` goes, and PR 5 is written
assuming PR 2 and PR 3 already replaced what those routes fed.

---

## 6. Landmines

Each of these was verified in the codebase and will bite someone who does not know.

### 6.1 `PAPERCLIP_API_KEY` is a false positive — **do not delete it**

**Correction (2026-08-22, applied in PR 1): this variable is double-duty, and the
original "just rename it" advice was unsafe.** It serves two unrelated purposes:

1. **Inbound** — the Hub's own bearer secret for its embeddings-ingest endpoint
   (`app/api/embeddings/upsert/route.ts:17-35`), which deliberately **fails
   closed** when unset.
2. **Outbound** — `lib/paperclipSession.ts:132` reads the same variable and sends
   it to Paperclip as `Authorization: Bearer` (`:143-145`), as the fallback when
   email/password session auth fails.

So a bare rename breaks Paperclip authentication as well as ingest, and deleting
it breaks ingest silently. One secret authenticating in both directions is itself
worth fixing: split it into `INGEST_API_KEY` (inbound) and the Paperclip
credential (outbound, dies with the rip-out), updating `service.yaml:76` and the
deploy workflow in the same change. Its appearance in
`app/api/admin/paperclip-health/route.ts:42` *is* Paperclip-related and dies with
that route.

### 6.2 `isPaperclipIntent` is defined as a negation and fails open

```ts
// lib/interview.ts:945-947
export function isPaperclipIntent(intent: InterviewIntent): boolean {
  return !PERSONAL_ACTION_INTENTS.has(intent)
}
```

Any intent not explicitly listed as personal is treated as Paperclip — so **every new
intent added in Phase 3 or 4 defaults into the retired branch**, inheriting a full
guided interview and Pre-Cog gate for an action that no longer exists. Invert it to
an explicit allow-list of engine intents when the Paperclip cases are deleted in PR 5.

### 6.3 `app/api/kpis/route.ts:31` — a one-line hoist restores real KPIs

`getCompanies()` (Paperclip) sits **inside** the outer `try` that also wraps the
Hub-native business-KPI read at `:80-110`. That DB read has nothing to do with
Paperclip — it queries the Hub's own `kpis` table — but a Paperclip throw at `:31`
aborts the try before it runs, so the Hub reports *no* KPIs when it could report its
own. Hoisting the `getCompanies()` call out of the try (or wrapping it in its own
`.catch(() => [])`) restores real business KPIs immediately, ahead of the full
rip-out. Cheap, high-visibility, safe to land early.

### 6.4 `page.tsx:219-227` renders TabViews unconditionally

The tab views are rendered whatever `activeCompany` is; each one independently
decides to show "Select a workspace…". When the tabs are removed in PR 2, remove the
render branch too — leaving it renders components whose data source is gone.

### 6.5 Chat ledger rows have no attribution

`ai_runs.user_email` exists in the schema and is written by `recordAiRun` when a
caller supplies it (`lib/runs.ts:143`), but **no chat-path caller supplies it** —
verified at `lib/agy-chat.ts:193` and `:213`, and `lib/gemini.ts:695` and `:718`.
Every chat row is therefore `user_email = NULL`.

This is why the panel is admin-only in Phase 3: there is no way to scope a staff
user's feed to their own runs, and prompts fingerprinted from other people's chats
should not be broadly readable. **The follow-up is to thread the session email into
those four `recordAiRun` call sites**, after which staff access becomes a filter
rather than a policy question. Note the ledger stores *provenance, never content* —
prompts are reduced to length + sha256 — so attribution is about scoping, not about
exposing text.

---

## 7. Phase 4 prerequisites discovered here

The `work_item` dispatch lane is **fully built and completely dead**. Phase 4 ("brief
and verify an `agy` run") depends on it, so these gaps are Phase 4's real starting
list, not Phase 3's:

- The only enqueuer hardcodes `kind: 'chat_turn'` (`lib/agy-dispatch.ts:128`).
- `workSlots` defaults to `0` — the worker claims no work items by design
  (`lib/dispatch-worker.ts:17`), pending exactly this panel work.
- `reapExpired()` (`lib/dispatch-store.ts:221`) never writes a ledger row, so an
  expired work item vanishes without a trace in `ai_runs`.
- The worker result path hardcodes `source: 'chat'`, so work items would be
  mislabeled in the ledger even once they run.

Dispatch telemetry is also stdout-only today; anything the panel needs to show about
in-flight dispatch has to come from the tables, not from logs.

---

## 8. Operator actions still open

Carried forward from `HARDENING_REVIEW_2026-08-20.md` — environment-only, no code:

1. Remove the residual `AGY_OAUTH_TOKEN` secret from any surface still holding it.
2. Set `WORKER_CHAT_SLOTS=3`.
3. Complete ARSO / auto-login on the worker desktop.
4. Provision the alerting Chat space + workflow secrets.
5. Expect pinned `agy 1.1.17` on the next worker rebuild.

New, added by this doc:

6. A **server-side GitHub token** for the Hub — the gate on PR 6 (§4).

---

## 9. Guardrails carried over from the Paperclip panel

These were right the first time and survive the engine swap:

- **Every write is wrapped in the AI Assistant's guardrails** — role gates, gate
  tokens, interview flows. Ops writes in PR 4 are admin-gated and confirmed.
- **Everything visible is injectable.** Any card can become a question to the
  assistant, via `onInjectChat` (read-style, direct) or `onInjectAction` (routed
  through Interview Mode).
- **The UI is poll-friendly.** No push assumption in the panel; it reads tables.
