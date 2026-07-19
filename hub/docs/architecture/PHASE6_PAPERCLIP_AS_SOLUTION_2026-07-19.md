# Phase 6 — "Paperclip as a Solution": the Proactive Suggestion Engine

Date: 2026-07-19
Status: Research synthesis + design (implementation to follow)
Builds on: RIGHT_PANEL_ARCHITECTURE_2026-07-19.md (Phases 1–4 shipped: all six
right-panel tabs native; 22 Interview Mode intents incl. routine/goal CRUD)

---

## 1. The goal, in one example

> User: "Set a recurring task on my Google Tasks to remind me to check
> Anthropic token usage every day at 9am."
>
> Assistant: creates the Google Task as asked, **and** offers:
> "I can do better than a reminder — want me to create a Paperclip routine
> where an agent checks the Anthropic usage itself every day at 9am and sends
> the numbers to you in Google Chat? You'd never touch this manually again."
>
> One tap → the `create_routine` interview opens pre-filled (work: check
> token usage + post to Chat; owner: CFO agent; schedule: `0 9 * * *`) →
> context gate passes → routine exists, agent runs it, results land in Chat.

Today the assistant only *reacts* to explicit commands (classifier →
interview → gated execution). Phase 6 adds the layer that *notices* when a
Paperclip primitive — Routine, Project, Goal, Space, delegated Task — is the
better solution and offers it.

## 2. Research findings that shape the design

Compressed from a 25-finding cited sweep (sources inline).

**How production assistants offer automations**
- ChatGPT Scheduled Tasks centralizes every automation in a dedicated
  dashboard with next-run/pause controls, splits tasks into one-off /
  recurring / *monitoring* (notify-only-on-change), and caps frequency
  (≥1h intervals). Monitoring tasks can self-terminate when an end condition
  is met. [help.openai.com/…/scheduled-tasks-in-chatgpt]
- Slack's AI Workflow Builder turns one natural-language sentence into a
  complete but **draft** workflow — always landing in an editable review
  state before going live. Zapier does the same: AI-generated Zaps are drafts
  requiring connection checks and a test run; its Copilot exposes two
  initiative modes ("Auto-build" vs "Ask as you build") so users pick their
  own automation tolerance. [slack.com/help/…, help.zapier.com/…]
- Gmail Nudges are the anti-annoyance gold standard: soft inline prompt, only
  after days of inactivity, dismissible in place, and implicitly dismissed by
  normal user action. [mailmeteor.com/blog/gmail-nudges]

**When to show a suggestion (trust & fatigue)**
- Horvitz's mixed-initiative principles: model uncertainty about the user's
  goal, weigh benefit vs interruption cost, minimize the cost of a wrong
  guess, and time the interruption to attention. Formally: surface only when
  modeled acceptance probability crosses a context-dependent utility
  threshold. [erichorvitz.com/chi99horvitz.pdf, …/copilot_display_AAAI.pdf]
- Fatigue ceilings are real and low: ~3–5 pushes/day before users disable
  notifications; tiered priority + cross-channel read-state suppression are
  the standard mitigations. [notigrid.com, courier.com]
- One confident-but-wrong suggestion triggers a lasting "rejection pattern"
  (CHI 2026); calibrated confidence beats raw accuracy for sustained
  acceptance. Copilot logs every accept/dismiss (~27–30% acceptance
  baseline) — dismissal memory is table stakes.
  [dl.acm.org/…/3791176, jellyfish.co]

**Architecture precedent**
- No mainstream product has fully solved "notice the recurring ask and offer
  to automate it" from ambient conversation; Slack/Zapier generate only on
  explicit request. The proven adjacent pattern is **LLM-as-judge post-hoc**:
  score the exchange against a rubric off the hot path, promote to a
  suggestion when a pattern recurs — never blocking the primary response.
  [evidentlyai.com, searchunify.com]

**Failure modes to design against**
- Runaway agent-executed automations: documented incidents at $47k (11-day
  loop) and 847k API calls; mitigations that work are *enforced* budgets
  (hard caps at the gateway, ~$10/day catches ~95% of runaways), per-run
  token ceilings, and velocity circuit breakers. [supra-wall.com, waxell.ai]
- Orphaned/"zombie" automations (Airflow zombie tasks, GitHub Actions zombie
  workflows) keep consuming resources long after purpose lapses; the fix is
  liveness checks plus **mandatory expiry/review dates** instead of
  set-and-forget. [getorchestra.io, sonarsource.com]

## 3. Design

### 3.1 Where suggestions come from — two detectors, both off the hot path

**D1. Intent-adjacent upgrade (deterministic, ships first).**
When the classifier resolves one of a known "upgradeable" intent set, a pure
lookup table maps it to a candidate Paperclip upgrade:

| Detected intent + signal | Suggested primitive |
|---|---|
| `create_task` with recurring language ("every day/week", "remind me to … at") | **Routine** owned by a role-matched agent, results → Google Chat/Gmail |
| `create_task` describing work an agent could *do* (not just remind) | **Delegated issue** (`create_paperclip_issue`) |
| `create_task`/`create_paperclip_issue` describing multi-step deliverables ("build", "launch", "migrate") | **Project** (+ workspace when a repo/folder is named) |
| Aspirational phrasing ("we need to get to", "goal is", "by Q4") | **Goal** (level inferred from scope) |
| `schedule_event` that is really a solo work block for checkable work | **Routine** (agent does it instead) |
| Repeated manual `run_routine`-style asks (same request ≥2× — recurrence-then-promote) | **Routine** with a schedule trigger |

Recurring-language detection is a small pure function (`detectRecurrence`)
over the interview context — regex/heuristic, unit-testable, zero cost.

**D2. Conversational pattern spotting (LLM-judged, ships second).**
After the assistant's streamed reply completes, a single cheap post-hoc judge
call scores the last exchange against the same table's rubric and returns
`{suggest: primitive|null, confidence, prefill}`. Runs asynchronously; a
suggestion attaches to the *completed* message, Gmail-nudge style. Never
blocks or delays the answer (LLM-as-judge post-hoc pattern).

### 3.2 How suggestions render — the SolutionCard

A compact card under the assistant reply (sibling of the existing
`suggestedTools` skill chips, reusing that plumbing):

```
┌──────────────────────────────────────────────┐
│ ⚡ Automate this instead?                     │
│ A Paperclip routine can check Anthropic      │
│ usage daily at 9am and message you the       │
│ numbers in Google Chat.                      │
│ [Set it up] [Just the reminder] [Don't offer this again] │
└──────────────────────────────────────────────┘
```

- **Set it up** → `onInjectAction` with the prefilled interview
  (`startInterview('create_routine', prefill)` fast-forwards known answers;
  the context gate still scores; the gate token is still required —
  suggestions get **zero** new write privileges).
- **Just the reminder** → original action proceeds untouched (the suggestion
  is always *additive*; we never hijack the user's explicit request —
  Zapier-draft principle: nothing goes live without review).
- **Don't offer this again** → writes to dismissal memory.

### 3.3 Guardrails (from the research, non-negotiable)

1. **Frequency cap**: max 1 SolutionCard per N assistant turns (default 5)
   and max 3/day, tiered so a high-confidence D1 match can preempt a
   lower-confidence D2 one. (fatigue ceilings)
2. **Dismissal memory**: per-user, per-(primitive × topic-hash) suppression
   stored with the existing user prefs; a dismissed suggestion never
   resurfaces for 30 days; "Don't offer this again" is permanent for that
   pairing. (Copilot accept/dismiss telemetry; rejection-pattern research)
3. **Confidence threshold**: D2 suggestions render only above a stored
   threshold (start 0.75), tuned against accept/dismiss telemetry recorded in
   the existing `ai_action_log` (NS-2). (Horvitz expected-utility gating)
4. **Draft-first**: every accepted suggestion goes through the full interview
   + context-sufficiency gate + gate token + proxy role tiers. The suggestion
   engine can *propose*; only the existing gated pipeline can *create*.
5. **No orphans**: every routine created via suggestion gets (a) the Hub tag
   `origin:hub-suggestion` in its description, (b) a **review-by date**
   (default +60 days) appended to the routine description, and (c) a standing
   Pulse-tab attention signal when a suggested routine hasn't succeeded in
   7 days — the discovery sweep for zombie automations. (zombie-workflow
   mitigations)
6. **Cost ceilings**: the create_routine interview's schedule question gains
   a budget note; suggested routines default to the owning agent's existing
   monthly budget and the confirmation card states it. Paperclip's own budget
   hard-stops remain the enforcement layer. (runaway-cost mitigations)

### 3.4 Cross-system handoff (the example, end-to-end)

The suggested routine's description template encodes the full loop so the
agent needs no extra context:

```
Check Anthropic API token usage for the org. Compare to yesterday.
Post a 3-line summary (spend, delta, anomalies) to Google Chat space
"RxFit Ops" via the Hub webhook. Created by Hub suggestion on {date};
review by {date+60d}.
```

Delivery uses what exists today: agents post results as issue comments →
ExecutionFeed; Google Chat delivery reuses the Hub's `post_chat_message`
machinery via the COO-routed comm path, or the agent's own Chat webhook
skill where configured. No new delivery infrastructure in v1.

### 3.5 Implementation map (small, mostly additive)

| Piece | Where | Size |
|---|---|---|
| `lib/solution-suggest.ts` — upgrade table, `detectRecurrence`, prefill builders, cap/dismissal logic (pure, tested) | new | M |
| D1 hook in `useChatEngine.doSend` after intent detection (before interview) | edit | S |
| D2 post-hoc judge route `app/api/chat/suggest-solution` (reuses claude/gemini chain, post-stream fire-and-forget) | new | M |
| `SolutionCard` component + accept/dismiss wiring into `ai_action_log` | new | S |
| Dismissal memory (user prefs table or localStorage v1 → DB v2) | edit | S |
| System-prompt line in `lib/gemini.ts` so the *model itself* can emit a `<!--suggestSolution:…-->` hint (third detector, free) | edit | XS |
| Routine tagging + review-by in `executeAction.create_routine` | edit | XS |
| Pulse attention signal for stale suggested routines | edit | S |

Phasing: **6a** D1 + SolutionCard + dismissal memory (deterministic, cheap,
high precision) → **6b** model-hint detector + telemetry → **6c** D2 judge +
threshold tuning + stale-routine attention.

## 4. Out of scope for Phase 6

- Autonomous creation without confirmation (violates draft-first; revisit
  only with sustained >60% acceptance telemetry).
- Cross-tenant suggestion models; anything requiring new Paperclip plugins.
- Suggestion delivery outside the chat surface (no push notifications).
