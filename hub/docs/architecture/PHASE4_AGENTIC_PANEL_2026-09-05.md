# Phase 4 — The Agentic Panel: context, executables, performance

**Status:** PR 1 shipped with this doc · roadmap approved for execution · **Written:** 2026-09-05
**Sits under:** `scripts/agy/README.md` (migration blueprint) — this is the Phase 4 row expanded
for the right panel. `PHASE3_EXECUTION_PANEL_2026-08-22.md` still governs the Phase 3 items
it names (dispatch rail history reader, ops writes, the rip-out); nothing here contradicts it.
**Research basis:** ~25 Exa web searches + 10 primary-source fetches on 2026-09-05 (§4 cites
them), plus a measured read of the panel and chat code on `origin/master` at `3b3e7d3`.

---

## 1. The two problems, measured

The owner reported two things on 2026-09-05 (screenshots in the session):

1. **Tapping a right-panel card gave the assistant nothing to work with**, and the reply
   still talked about Paperclip "warming up".
2. **The panel is wasted real estate** — a log of "AI performed an action" rows with no way
   to act on them and no context flowing to the assistant. It was meant to be the agentic
   layer that replaced the Paperclip orchestration layer.

Both traced to code, not to the model:

| Symptom | Cause (file:line on `3b3e7d3`) |
|---|---|
| "I couldn't retrieve live Paperclip orchestration data right now — the API may be warming up." | `lib/gemini.ts:93-97` **taught the model that exact sentence** as the required response whenever the "Active projects / Recent agent activity" sections were empty. |
| Those sections were always empty | `app/api/chat/route.ts:669-763` still called `getCompanies/getIssues/getAgents/getRuns` from `lib/paperclip.ts` on **every chat turn**, waited up to **8 s** for the dead upstream, then injected `[Paperclip orchestration data unavailable…]`. |
| The card tap carried only a title | `app/components/RightPanelSections.tsx:75` — `onInjectChat(\`Tell me more about: ${item.title}\`)`. `item.metadata` (run id, engine, error class, latency, request id) never left the browser. |
| The model was offered 18 actions the app cannot run | `lib/write-actions.ts:64-84` advertised "Create a Paperclip issue", "Create a recurring routine", "Restart an agent"… under a `paperclip` surface; `interview.ts` still detects those intents and the executor still POSTs to the retired proxy. |
| The Pulse tab showed Paperclip-era project health only | `PulseStrip` / `AttentionStrip` in `RightPanelWorkspace.tsx` read a `dashboard` prop no live source supplied (Phase 3 PR 2 unmounted them); the tab fell through to `ProjectHealthSection`. |
| Even the interview quality gate called itself Paperclip | `app/api/chat/score-context/route.ts:126` — "You are the Paperclip AI Context Sufficiency Evaluator." |

Meanwhile the Hub already owned everything an execution layer needs to *describe* itself:
`ai_runs` (every model call: engine, model, verdict, typed error class, latency, tokens,
worker), `ai_action_log` (every confirmed AI action), `tool_runs` (Deep Research / Deep Think),
`dispatch_jobs` + `dispatch_workers` (queue + worker heartbeat), `report_runs` (scheduled
reports), `event_log` (alerts). None of it reached the assistant.

---

## 2. What PR 1 ships (this PR)

**Principle: one reader, two consumers.** `lib/execution-context.ts` reads the Hub's own
ledgers into an `ExecutionSnapshot`. The chat route injects it as the **"Execution Layer"**
prompt section on every turn; `/api/execution/pulse` serves the same object to the panel's
Pulse tab. A tile in the panel and the assistant's answer about it therefore cannot disagree.

### 2.1 Chat context (problem 1, root cause)

- `/api/chat` no longer imports `lib/paperclip.ts`. Branch 1 of the pre-stream `Promise.all`
  is `readExecutionSnapshot({ userEmail, isAdmin })` with a **4 s** timeout (was 8 s against a
  dead host). Failure and timeout inject explicit notices that name the real cause ("the Hub's
  own execution ledger could not be read") — never another system.
- `lib/gemini.ts` system prompt: every Paperclip rule is replaced by an **Execution Layer**
  section that explains what `ai_runs` / actions / deep runs / dispatch are, what "agy" vs
  "gemini/claude" means for cost, what "Prioritized inbox focus queue" actually did, and how
  to explain a typed error class. Paperclip is named exactly once — as retired — so the model
  stops attributing anything to it. `SystemPromptContext.projects/agentActivity` →
  `executionContext` (fenced as untrusted: it carries user-authored briefs and intents) +
  `executionNotice` (our text, unfenced).
- `lib/write-actions.ts`: the `paperclip` surface is renamed `execution` and **no longer
  rendered** into the prompt. In its place the prompt tells the model those actions are *not
  available in this release* and what to offer instead (a Task/Event to hold the intent, a
  deep run, or a read of the panel). The intents stay in `interview.ts` so the catalog remains
  type-complete; deleting them is Phase 3 PR 5's rip-out.
- The score-context evaluator persona is renamed to the Hub's.

### 2.2 Card taps carry the record (problem 1, symptom)

- New `ChatAttachment` type `'record'` with `recordKind: 'ai_run' | 'ai_action' | 'tool_run'`
  and `recordId` (zod-validated, ≤64 chars). The client sends **a reference, never content**.
- `lib/feed-attachment.ts` (pure, tested) builds the attachment from a `FeedItem`'s metadata;
  `aiActionToFeedItem` now emits `actionId`. The tap message keeps the read-style
  "Tell me more about: …" form (inject-routing contract) and appends the actual question
  ("why did it fail, what should I do").
- `lib/attachment-resolver.ts` resolves records **inside the caller's scope**: `ai_runs` only
  for admins (`canAccessAdminRoute`, same gate as `/api/runs`), `ai_action_log` by owner email,
  `tool_runs` by tenant + owner. A non-admin never triggers the ledger read. Each record is
  rendered by `formatAiRunRecord` / `formatAiActionRecord` / `formatToolRunRecord` with a
  short glossary, provenance only — `ai_runs.error` message text is still withheld
  (HARDENING_REVIEW "output tails leak").
- New readers: `getAiRun(id)`, `getAiAction(id, userEmail)`.

### 2.3 Pulse tab on live data (problem 2, first slice)

- `GET /api/execution/pulse` (withFault, session-gated; `isAdmin` decides which planes are
  non-null).
- `ExecutionPulse` renders six tiles — allotment share of chat serves, runs/24h with failures,
  p50 latency + tokens, worker liveness, the user's AI actions, deep runs — and **derived
  "ask the assistant" chips** (`derivePulseChips`, pure, tested): failed runs (with error
  classes in the question), worker offline, queue backlog, failed actions, active deep runs,
  and an always-present health summary. Every chip is a read-style inject the model can answer
  because the same snapshot is in its prompt. Admin planes render as locked tiles for staff.
- `PulseStrip` / `AttentionStrip` (Paperclip `dashboard` shape) are deleted;
  `lib/execution-dashboard.ts` remains only for `lib/paperclip.ts` until PR 5.

### 2.4 Tests

`lib/execution-context.test.ts` (summarizers, redaction, scoping, fail-open per plane),
`lib/feed-attachment.test.ts`, `lib/pulse-chips.test.ts`, record cases in
`lib/attachment-resolver.test.ts`, `tests/execution-pulse-route.test.ts`, and a source-level
wiring guard `tests/right-panel-inject-wiring.test.ts` (mirrors the left-panel guard) that
fails if the title-only inject or the Paperclip import ever returns. Prompt tests now lock the
Execution Layer fence and assert the "warming up" sentence is gone.

---

## 3. Architecture

```
                 ┌────────────────────────── lib/execution-context.ts ──────────────────────────┐
 ai_runs ───────►│ summarizeRuns      (24h window: ok/error, by engine/source, allotment share,   │
 (admin plane)   │                     p50, tokens, error classes, last 5 failures — no messages) │
 dispatch_* ────►│ readDispatchPlane  (worker fresh/stale vs AGY_DISPATCH_FRESH_MS, queue depths) │
 (admin plane)   │                                                                                │
 ai_action_log ─►│ summarizeActions   (owner-scoped: total, failed, last 8)                       │
 tool_runs ─────►│ summarizeToolRuns  (tenant+owner-scoped: active, last 5, brief preview ≤120)   │
                 └───────────────┬──────────────────────────────────┬──────────────────────────┘
                                 │ ExecutionSnapshot                │
             formatExecutionContext(snap)                  GET /api/execution/pulse
                                 │                                  │
                 /api/chat  "## Execution Layer" (fenced)   ExecutionPulse tiles + chips
                                                                    │ chip tap → injectRecall(prompt)
 FeedCard tap ── feedItemToAttachment ── {type:'record', recordKind, recordId} ──► /api/chat
                                                     attachment-resolver.resolveRecord(scope)
                                                     └─ formatAiRunRecord / …ActionRecord / …ToolRunRecord
```

Invariants carried forward: provenance never content; admin planes never read for non-admins;
every reader fails open into `notices`; the chat path never waits more than 4 s on it.

---

## 4. What the research says (2026-09-05)

### 4.1 Feature parity with what Paperclip provided
Paperclip's model was *company → agents (with adapters + budgets) → issues (Linear-style, goal
ancestry, execution locks) → routines (cron / webhook / manual triggers, concurrency and
catch-up policies, activity gate) → heartbeats/runs (structured logs, cost events, retry
policy) → approvals (approve / reject / request-revision, review rounds cap) → budgets (80 %
warn, 100 % pause) → activity log.* Its UI ideas worth keeping: plain-English cron with a
`Next:` timestamp and last-result badge, a Runs list with source/status/date filters, an Inbox
+ Approvals queue, a live-run widget. Sources: github.com/paperclipai/paperclip README;
docs.paperclip.ing key-concepts, routines, execution-policy.

The org-chart / multi-company / CEO layers are the parts a single-owner studio does not need.
Parity for RxFit = **routines + runs (with cost) + approvals + budget + activity**.

### 4.2 Agent-inbox and control-panel patterns (the consensus column set)
LangGraph Agent Inbox (interrupts with `accept | edit | respond | ignore`, durable, "make
approve the easiest path"), Zapier Agents ("Needs action" filter; triggers On demand /
Schedule / App event), n8n executions (status vocabulary incl. `waiting`, `crashed`; retry
linked via `retryOf`), Gumloop Run Log (per-step time and credit cost), OpenAI Agents SDK traces
(agent / tool / guardrail spans with latency + tokens), Copilot Studio (period-over-period KPIs,
tool success %), Agentforce Observability (session trace, LLM-judge quality, health alerts),
Devin's kanban-by-status command center, Claude Managed Agents scheduled deployments
(per-run records with typed errors, pause/unpause, "run now", missed triggers not backfilled).

Consensus columns/states: **item type** (run / needs-approval / question / notify), **status**
(queued, running, waiting-on-human, succeeded, failed, skipped, cancelled), **trigger source**,
**duration**, **tokens + cost**, **tool calls (count, failures)**, **outcome link**, **next run**;
actions **approve / edit / reject / reply / retry / re-run / pause / open trace**.

### 4.3 Metrics small teams actually track
OTel GenAI semantic conventions (`invoke_agent`, `execute_tool`, `gen_ai.usage.*`,
`error.type`); the Langfuse "minimum viable dashboard" — P95 latency per agent type, **cost per
successful run**, **tool-call failure rate by tool**, LLM calls per run (runaway loops), sampled
quality; LangSmith alert thresholds (P95 > 5 s, error > 5 %, 2× token spike); Phoenix
cost roll-ups and "50 well-annotated traces". Business-level (SMB ROI guides, Microsoft's agent
value reference): time-to-first-draft vs baseline, autonomous completion rate,
**cost per verified outcome**, **human-override rate (healthy band ~10–25 %)**, rework rate,
signal-to-action cycle time. "Time saved" counts only if human touches actually dropped.

### 4.4 Scheduled / triggered executables on Google Workspace
Google Workspace Studio (plain-language agents with Gmail/Drive/Forms/Chat/schedule triggers,
Ask Gemini / Decide / Extract / Summarize steps), Gemini Scheduled Actions (≤10, daily/weekly),
ChatGPT scheduled + event-triggered tasks (the Scheduled page "acts as your inbox"), Claude Code
Routines / Managed Agents scheduled deployments (cron + tz + jitter, per-run records, vaults),
Lindy Skills ("Summarize inbox every morning", "Auto-triage Gmail", "Prep brief before every
meeting", "Follow-up after every meeting", multichannel outbound with Wait/Cancel timers).
The shared presentation: **a catalog of named one-sentence jobs → instantiate with a trigger +
2–3 settings → a detail page with Next run, Last result, Run history, Pause / Run now.**

### 4.5 Feeding a clicked item to the assistant
Cursor @-mention pills that "travel with the question", Notion Agent's current-page default
context, Linear Agent's `@Linear` in-place on an issue, Intercom Fin Copilot's sidebar with the
ticket as implicit context, MCP Resources (URI-addressed, application-controlled inclusion).
Implementation consensus: **store a reference on the chip, resolve content at send time,
prepend a labeled structured block to the model-visible message, show only the chip in the
transcript** — exactly what §2.2 implements.

### 4.6 Fitness-business ops automations worth running
Speed-to-lead is the highest-leverage fix (5-min response ≈ 21× qualification vs 30 min;
secret shops found 12 % of gyms follow up within 72 h). Benchmarks: first-response < 5 min,
% responded within 1 h, lead→consult booking rate, trial→member 28–35 %. Retention: attendance-
drop scans, pack-expiry reminders, failed-payment recovery, win-back. No-show: 12 h + 2 h
reminders, waitlist auto-promotion. Reviews at the "happiness peak" (milestone sessions).
For RxFit the natural first jobs are: new-lead first touch + consult booking, pre-screening
prep brief (a skill already exists), no-show follow-up from Calendar, weekly ops report to
Chat, review request after milestone sessions.

---

## 5. Roadmap — the panel becomes the agentic layer

Ordered by leverage ÷ risk. Each PR is real (non-draft), green before the next. Every write
keeps the Hub's guardrails: role gate → gate token → confirm card → `ai_action_log`.

### PR 2 — "Needs you" queue + retry (the inbox)
- A `needs_you` **queue at the top of the Runs tab**, ahead of the ledger, sourced from:
  failed runs, failed actions, orphaned deep runs, dispatch alerts from `event_log` (the Phase 3
  reader that is still missing), and pending confirm cards.
- Card actions: **Explain** (the record tap from PR 1), **Retry** (deep runs: re-enqueue with
  the same brief; actions: re-open the confirm card with the original spec), **Dismiss**.
  Retry writes a new row linked by `retryOf` in `meta`.
- Item types Notify / Question / Review (LangChain framing) so executables can post "FYI" and
  "I'm stuck" items into the same queue instead of Chat pings.

### PR 3 — Playbooks: the executables catalog
- A `playbooks` table: `id, name, description, trigger (schedule|event|manual), cron + tz,
  concurrency (skip_if_active default), catch_up (skip_missed default), skill_id, inputs,
  enabled, last_result, next_run_at`. Runs are `tool_runs` rows with `tool = playbook:<id>`, so
  the ledger, the record tap, and the Pulse tiles work unchanged.
- The hourly GitHub cron tick (`dispatch-alert.yml`) gains a third duty: evaluate due
  playbooks and enqueue `work_item` jobs — the same lane Deep Research uses.
- Launch catalog (five jobs, each ≤ 1 sentence to the owner):
  1. **Inbox triage** — morning focus queue + "To respond / FYI / Invoices" labels (extends
     the existing `gmail/focus` action).
  2. **Lead first-touch** — new consult-form lead → draft reply within minutes → needs-you
     card (speed-to-lead; never auto-sent).
  3. **Screening prep brief** — the day before each Movement Screening on Calendar, run the
     existing `movement-screening-email` skill → draft in the queue.
  4. **No-show follow-up** — Calendar event with no check-in → draft SMS/email → queue.
  5. **Weekly ops report** — Friday digest to Google Chat via the existing scheduled-reports
     lane, with the Pulse numbers included.
- Detail view: plain-English schedule ("Every weekday at 6:30 AM CT"), `Next:`, last result,
  run history (from `tool_runs`), **Run now / Pause / Archive**.

### PR 4 — Scorecards and the run trace
- Per-playbook tile: success rate, p50/p95 duration, **cost per successful run** (tokens ×
  engine price; agy = $0), **override/edit rate** (queue cards edited before approve),
  runs this week, trend vs prior week.
- Tool-level error tracking: the read-tool executor already knows which tool failed;
  persist `tool, ok, latencyMs` per call in `ai_runs.meta` (primitives only) and roll up weekly.
- Trace drawer on a run: steps (planner → tool calls → model), each with elapsed time and
  outcome, live-polling while `queued`.

### PR 5 — Budget and outcome counters
- Monthly metered budget (`hub_settings`): 80 % warning tile, 100 % pauses metered fallbacks
  (agy allotment keeps serving).
- Business counters on the lead/no-show playbooks: median first-response time, % within 1 h,
  consult bookings from AI-drafted replies, follow-ups sent, reviews requested. These are the
  "time saved" numbers that survive scrutiny.

### Explicitly not doing
- Multi-company orgs, agent hierarchies, "CEO pulse" — Paperclip features a one-owner studio
  never used.
- Autonomous sends. Every outbound message stays behind a confirm card; the queue makes
  approving fast, it does not remove it.
- Reviving `lib/paperclip.ts` for anything. PR 5 of Phase 3 deletes it.

---

## 6. Definition of done for Phase 4

- A card tap always yields an explanation of *that* record, with next steps, in one turn.
- The assistant never names a retired system; the Execution Layer section is present on every
  turn for admins and shows their own planes for staff.
- The owner can turn on a playbook, see when it runs next, see what it produced, approve or
  edit the result from the queue, and read the playbook's success rate and cost.
- Every write in the panel is audited in `ai_action_log` with a gate token.
