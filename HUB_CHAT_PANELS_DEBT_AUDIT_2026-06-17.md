# Hub Chat ↔ Panels — Inefficiency & Debt-Code Audit

**Date:** 2026-06-17
**Scope:** Inefficiencies and debt/dead code in the wiring between the AI chat interface
(`app/page.tsx`) and its connections to the **left panel** (`LeftPanelSections.tsx`:
KPIs, Calendar, Tasks, Documents) and **right panel** (`RightPanelSections.tsx` +
`BusinessManagerPanel.tsx`: Project Health, Execution Feed), including the chat-enhancement
glue (`ChatEnhancements.tsx`) and the data hooks (`useHubData.ts`, `useKPIData.ts`).
**Method:** Direct read of the live render/inject path and the panel data hooks. Verified
with `tsc --noEmit` (clean) and `vitest` (31/31).

---

## ✅ Applied in this pass (safe, high-confidence cleanups)

| # | Finding | Action |
|---|---------|--------|
| D1 | **Dead "Context Injection Banner".** `injectedContext` state was only ever set to `null` — `setInjectedContext(...)` was never called with a real value, so the `<ContextInjectionBanner>` never rendered. Carried a dead `useState`, a dead import, a dead render branch, and a ~47-line unused component. (Originally flagged in the 06-14 audit; never wired.) | Removed the state, import, render branch, and the `ContextInjectionBanner` component. Kept `useSwipeDismiss` (still used by `InterviewBadge` / `SkillBadge`). |
| D2 | **No-op ternary** `activeSkill ? 'deep_dive' : 'deep_dive'` (×2 in `doSend`) — both arms identical, dead conditional. | Simplified to `'deep_dive'`. |
| D3 | **Dead `useCase?` param** in `RightPanel`'s `onInjectChat` type. The render wrapper hardcodes `handleChatInject(msg, 'execute')` and the child sections call with one arg, so the second param was never threaded. | Tightened the type to `(msg: string) => void`. |

Net: −56 lines, no behavior change.

---

## ⚠️ Flagged — real debt, not auto-fixed (needs a focused change / your call)

### E1 — Side effects fired *inside* a `setMessages` updater (`doSend`) — ✅ FIXED
The initial-send path ran `detectIntent(message).then(… sendToApi(…))` **inside** the
`setMessages(prev => { … })` updater, and the interview-advance branch likewise called
`setInterviewState` / `setActiveModel` / the score fetch / `runQualityGate` from inside it.
State updaters must be pure — React may invoke them more than once (and does, under
StrictMode in dev), so this could **double-fire intent detection and a duplicate `/api/chat`
request** (plus duplicate scoring calls).

**Fix:** `doSend` was restructured so the updater is pure — it only appends precomputed
message(s) and captures the post-append list (`committed`). All side effects (intent
detection, interview advance, scoring, quality gate, sends) are assigned to a single
`runAfter` closure and fired **once, after the commit**. `advanceInterview` /
`startInterview` are pure and are computed up front to decide what to render. This mirrors
the established "P7" pattern and now covers every branch (start / advance / normal send).
Verified: `tsc --noEmit` clean, `vitest` 31/31.

### E2 — Duplicate `projects.find(...)` for the active company — ✅ FIXED
The active-company lookup ran twice per render: inline in the page to compute `activeOrgId`
and again inside `RightPanel`, then OR-combined. Analysis showed the two always resolved to
the **same** value (`activeCompany?.companyId`), so the `activeOrgId` prop and its page-side
`find` were fully redundant. Removed the prop and the page-side computation; `RightPanel`
derives `orgId` from its own `activeCompany`. Exact behavior preserved.

### E3 — `FeedFilterBar` re-rendered in four branches — ✅ FIXED
The loading / error / empty / content branches each rendered their own `<FeedFilterBar>`
(the loading branch with hardcoded zero counts). Hoisted to render **once** above a single
ternary body switch. (During loading, `items` is empty so the shared `counts` is all-zero —
same as the old hardcoded value.)

### E4 — Feed cards not memoized — ✅ FIXED
Wrapped `FeedCard` in `React.memo` (keyed on `item.id`) **and** stabilized the per-panel
inject handlers in `page.tsx` (`injectRecall` / `injectExecute` / `injectDeepDive` via
`useCallback`) so the memo is actually effective — previously the inline
`(msg) => handleChatInject(...)` wrappers were new on every render, which would have defeated
`memo`. Now unrelated re-renders (e.g. typing in the chat input) no longer re-render the feed
cards. The stabilized handlers also reduce re-renders across the left-panel sections.

---

## ✓ Checked and found OK (no action)
- **KPI double-fetch?** Both `page.tsx:226` and `KPISection` call `useKPIData(activeProject)`
  with the **same** arg → identical SWR key → SWR dedupes into one request and shares cache.
  Not a duplicate fetch.
- **Parallel `components/Hub/` stack** (flagged as possibly-dead in the 06-14 audit) — no
  longer present in the tree; already removed.
- **Panel polling cadences** (tasks 30 s, calendar 60 s, drive 120 s, KPI 60 s, feed 30 s)
  are reasonable and `revalidateOnFocus` is mostly disabled to avoid refetch storms.

---

## Verification
- `npx tsc --noEmit` — clean
- `npx vitest run` — 31/31 passing
- Files changed: `app/page.tsx`, `app/components/ChatEnhancements.tsx`
</content>
