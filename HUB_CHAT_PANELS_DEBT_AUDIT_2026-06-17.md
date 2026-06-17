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

### E1 — Side effects fired *inside* a `setMessages` updater (`doSend`)
The initial-send path runs `detectIntent(message).then(… sendToApi(…))` **inside** the
`setMessages(prev => { … })` updater (≈`app/page.tsx:575`). State updaters must be pure —
React may invoke them more than once (and does, under StrictMode in dev), which can
**double-fire intent detection and a duplicate `/api/chat` request**. The codebase already
established the correct pattern elsewhere (the "P7 fix": capture intent in the updater, fire
the call *after* it — used by the non-interview branch and `handleChatInject`), but this
path and the interview-advance branch (`:625`–`:867`, which also calls `setActiveModel` /
nested `setMessages` / `runQualityGate` from inside the updater) were never converted.
**Why not auto-fixed:** `doSend` is a large, intricate, untested function; converting it
safely deserves its own focused change. **Recommend:** lift `detectIntent` and the
interview-advance side effects out of the updater behind the same pending-action pattern.

### E2 — Duplicate `projects.find(...)` for the active company
The active-company lookup runs twice per render: once inline in the page to compute
`activeOrgId` (`app/page.tsx:1374`) and again inside `RightPanel` (`:128`), then OR-combined
(`:174`). Cheap, but duplicated logic that can drift. **Recommend:** compute once and pass
down, or derive `activeOrgId` from the `RightPanel`-side `activeCompany`.

### E3 — `FeedFilterBar` re-rendered in four branches (`RightPanelSections.tsx`)
The loading / error / empty / content branches each render their own `<FeedFilterBar>` (and
the loading branch passes hardcoded zero counts). Functional but repetitive JSX.
**Recommend:** render the filter bar once above the branch switch.

### E4 — Feed cards not memoized
`FeedCard` / the feed list re-render fully on every filter tab change and every 30 s feed
refresh (`useFeed` polls at 30 s). Fine at current list sizes; if the feed grows, wrap
`FeedCard` in `React.memo` and key the memo on `item.id`.

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
