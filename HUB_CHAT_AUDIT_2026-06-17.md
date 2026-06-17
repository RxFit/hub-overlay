# Hub Chat — AI Model-Rotation & Left-Panel Integration Audit

**Date:** 2026-06-17
**Scope:** (1) Full audit of the AI Assistant chat's model rotation — verify it is built
soundly and won't garble/hang output; (2) verify the left-panel Google integrations
(Tasks, Calendar, Drive/Documents) port real context into the primary chat when an item
is clicked.
**Method:** Direct read of the live path `app/page.tsx` → `app/api/chat/route.ts` →
`lib/gemini.ts` / `lib/claude.ts`, plus the panel components (`LeftPanelSections.tsx`) and
the live-context builder (`lib/google-context.ts`). Verified with `tsc --noEmit` (clean)
and `vitest` (31/31 passing).

---

## Part 1 — AI Model Rotation (`lib/gemini.ts`)

The rotation chain is: **Claude (`claude-sonnet-4-6`, branded "Fable 5") → Gemini 2.5 Flash
→ Gemini 2.5 Pro**, gated by `useCase`, with a per-model cooldown map. The cooldown design
(W-2/W-3) is sound. Three defects that the 06-13 audit reported fixed had **regressed** in
the diverged codebase (as the 06-14 audit predicted) and are the most likely cause of the
"chat is broken again" symptom:

| # | Defect | Symptom | Fix applied |
|---|--------|---------|-------------|
| R1 | **Mid-stream fallback duplicated output.** If Claude or Gemini Flash streamed some tokens and *then* failed, the chain rotated to the next model and restarted the answer — the partial text was already on the wire. | Garbled / duplicated / doubled answers. | `emittedAny` / `claudeEmitted` guard: once any token has streamed, the error **propagates** instead of rotating. Only *pre-first-token* failures rotate. |
| R2 | **No mid-stream idle watchdog.** The 60 s timeout only covered *opening* the stream; a model that connected then stalled hung to the route's 120 s `maxDuration`, blowing past the client's 45 s abort. | Chat "freezes," then times out. | New `withIdleWatchdog()` races each `.next()` against a 30 s idle timer (Claude **and** Gemini paths) and tears down the upstream reader on early exit. |
| R3 | **Auth/key errors burned a useless fallback.** A bad/expired API key dooms every model on the same credential, but the chain still waited 2 s and retried the next model. | Slower, noisier failures. | `isAuthOrKeyError()` fast-fails the Gemini chain on 401/403/key/permission/billing. `isRateLimitError()` now classifies Gemini 429s for the correct (shorter) cooldown instead of always applying the 5-min penalty. |

**Also improved:** the client now **appends** a server error event to the assistant bubble
instead of overwriting it, so a mid-stream failure preserves already-streamed text
(`app/page.tsx`).

### Resolved follow-up — Fable 5 primary, Sonnet 4.6 backup
The earlier "Fable 5 vs Sonnet 4.6" labeling mismatch is now a real two-model chain:
- The Claude rotation is **`claude-fable-5` (primary) → `claude-sonnet-4-6` (backup)**, in
  front of the Gemini chain (`CLAUDE_MODEL_CHAIN` in `lib/gemini.ts`).
- `lib/claude.ts` exports `CLAUDE_PRIMARY_MODEL` / `CLAUDE_BACKUP_MODEL` and both
  `streamClaudeChat` / `claudeChat` take a `model` option.
- Badges now read "Claude Fable 5" and "Claude Sonnet 4.6" accurately
  (`getModelDisplayName`).
- When Fable 5 fails pre-stream, it rotates to Sonnet 4.6; an **auth** failure skips the
  whole Claude chain (shared key) straight to Gemini. A per-model cooldown means that while
  Fable 5 is down it's skipped, and **once it recovers (cooldown expires) it is tried first
  again** — Fable 5 stays primary.
- `score-context` scoring also tries Fable 5 → Sonnet 4.6 → Gemini 2.5 Pro.

---

## Part 2 — Left-Panel Integration → Chat Context Porting

**How it works:** tapping a panel item calls `onInjectChat(message)` → `handleChatInject`
posts to `/api/chat`, which fetches a bounded **live Google Workspace snapshot**
(`buildGoogleWorkspaceContext`) and injects it into the system prompt. The snapshot is the
safety net; the tapped message is the focus.

**The gap (regressed vs. audit F5):** taps sent only bare title strings, so when a clicked
item fell *outside* the snapshot window (pending-only tasks, first 5 lists, ~15 events,
~12 recent files) the model had nothing to answer from — and **Drive document clicks never
carried the file id, so the chat route never fetched the document's content.**

### Fixes applied (`LeftPanelSections.tsx` + `page.tsx`)

| Integration | Before | After |
|---|---|---|
| **Tasks** | `Tell me about task: {title}` | `buildTaskInjectMessage()` — carries list name, status, due date, and notes inline. |
| **Calendar** | `Tell me about event: {summary} on {date}` | `buildEventInjectMessage()` — carries title, date **+ time**, location, and description. |
| **Documents/Drive** | `Find document: {name}` (name only) | Tap now attaches the real Drive **`fileId`** as a `document` `ChatAttachment`, so the chat route resolves the document's actual content (Vertex semantic search → Drive export) and the chip renders on the sent message. Transcripts likewise attach for true summarization. |

To carry the attachment, `onInjectChat` was widened to
`(msg, attachments?: ChatAttachment[])` through `LeftPanel` → `handleChatInject` →
`sendToApi`; string-only callers (Tasks, Calendar, KPI) are unaffected.

**Net effect:** clicking any Task, Calendar event, or Drive document now ports that item's
real details into the primary chat, independent of whether it was in the snapshot window —
and documents bring their *content*, not just a filename.

---

## Verification
- `npx tsc --noEmit` — clean.
- `npx vitest run` — 31/31 passing (the `DATABASE_URL` error in logs is an expected,
  caught sandbox condition).
- Files changed: `lib/gemini.ts`, `app/components/LeftPanelSections.tsx`, `app/page.tsx`.
</content>
</invoke>
