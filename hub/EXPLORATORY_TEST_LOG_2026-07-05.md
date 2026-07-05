# CT Hub — Exhaustive Exploratory Test Log (2026-07-05)

Method: drove the real Next dev server with a genuine next-auth admin session; every
`/api/*` backend mocked at the browser layer with rich fixtures so all UI states were
reachable. Clicked/created/removed elements across all three panels + the Gmail/Chat
overlay, exercised Interview Mode end-to-end, and asked the AI about each section.
Findings marked **CONFIRMED** were verified at the source (code + payloads), not just
observed. 59 behaviors verified working; 9 irregularities below.

Legend: severity — HIGH (broken/user-visible failure), MED (degraded/expectation gap),
LOW (polish/robustness).

---

## Findings

### F1 · HIGH · Gmail "Reply" fails for virtually every real sender — CONFIRMED
- **Where:** `app/components/GoogleChatPanel.tsx` `GmailView.handleSend` (and the same at L493/L508) sends `to: last.from` — the raw `From` header, e.g. `Acme Billing <billing@acme.com>`.
- **Why it breaks:** the server `app/api/google/gmail/route.ts` validates each recipient with `^[^\s@,]+@[^\s@,]+\.[^\s@,]+$` (L133–136). That regex rejects any `Name <addr>` form (spaces + angle brackets) → **400 "Invalid recipient address"**.
- **Impact:** replying to any normally-formatted email fails. Compose (user types a bare address) works; Reply does not.
- **Fix:** extract the bare address before sending (the component already has an `extractName` helper — add an `extractEmail` and use it for `to`). Or have the server strip display names before validating.

### F2 · MED · AI chat cannot *view* Gmail, and only sees Chat *space names* — CONFIRMED
- **Where:** `lib/google-context.ts` `buildGoogleWorkspaceContext` fetches Tasks, Calendar, Drive, and Chat — **Gmail is never fetched**, and the Chat section injects only space display-names (L120–132), not message content.
- **Conflict:** the system prompt (`lib/gemini.ts`) repeatedly tells the model it can "Answer Tasks/Calendar/Drive/**Chat/Gmail** questions directly," and L164 labels the block "the user's REAL current Tasks, Calendar, Drive, and Chat data" — **omitting Gmail entirely** while promising it. Live inbox/thread content and Chat messages are absent, so the model must either say it can't see them or hallucinate. (Vertex "Semantic Brain" may index some of this, but that's a separate GCP engine, not the live OAuth session.)
- **Impact:** directly fails the "AI chat can view Gmail and Chat" objective.
- **Fix:** add a Gmail section to `buildGoogleWorkspaceContext` (reuse `/api/google/gmail`) and include recent Chat messages for the active/unread spaces; or soften the prompt claims to match what's actually injected.

### F3 · MED · AI chat cannot *comment/send* in Gmail or Google Chat — CONFIRMED
- **Where:** `streamChat` has no function/tool-calling; the only actions are Interview-Mode intents in `lib/actions/executeAction.ts`. There is **no intent that posts a Google Chat message or sends a Gmail.** `send_communication` merely creates a Paperclip *issue* briefing the COO agent to "execute delivery" — it never calls the Gmail/Chat APIs.
- **Impact:** the assistant can't itself reply in a thread or post to a space; sending is manual (panels) or indirectly delegated to a Paperclip agent. Fails the "AI can comment in both" objective.
- **Fix:** add `send_gmail` / `post_chat_message` intents to Interview Mode wired to the existing `/api/google/gmail` and `/api/google/chat/messages` POST routes (with confirm-card gating, since these are external comms).

### F4 · MED · Untrusted email HTML executes JavaScript in the preview iframe — CONFIRMED
- **Where:** `app/components/EmailPreviewCard.tsx` renders the email body via `srcDoc` with `sandbox="allow-scripts"`. A `<script>` in the email body runs (proven at runtime by the sandboxed-`localStorage` SecurityError the injected script threw).
- **Impact:** the sandbox correctly blocks same-origin access (no cookies/DOM/storage), but sender-controlled JS still executes — remote fetches, tracking/read beacons, in-frame redirects, resource abuse. Reading an email should never run its scripts.
- **Fix:** strip/sanitize scripts from the HTML, or drop `allow-scripts` and size the iframe another way (e.g. sanitize then measure, or a fixed/max height).

### F5 · MED · Custom brand fonts are blocked by the app's own CSP — CONFIRMED
- **Where:** `app/globals.css` L1 `@import url('https://fonts.googleapis.com/css2?...Syne...Space Grotesk...DM Sans...JetBrains Mono')`, but `middleware.ts` CSP sets `style-src 'self' 'unsafe-inline'` — `fonts.googleapis.com` is not allowed, so the stylesheet is **refused** (console: "Refused to load the stylesheet … violates … style-src").
- **Impact:** none of the display/brand fonts load; the whole UI silently falls back to `system-ui`. Purely visual, but it defeats the design system.
- **Fix:** add `https://fonts.googleapis.com` to `style-src` (font files are already allowed by `font-src … https:`), or self-host the fonts and drop the remote `@import`.

### F6 · MED · Untitled calendar event renders "undefined" — CONFIRMED
- **Where:** `app/components/CalendarSection.tsx` `CalendarRow` uses `{event.summary}` and `aria-label={`Event: ${event.summary} at ${startTime}`}` unguarded. An event with no summary shows a blank title and the a11y label "Event: undefined at 3:00 PM."
- **Fix:** fall back to `'(untitled)'` (as the AI-inject builder already does).

### F7 · LOW/MED · New-event modal accepts an end time before the start time — CONFIRMED
- **Where:** `CalendarEventModal.handleSave` validates presence only, never `end > start`. Verified: it POSTed `start: …T14:00:00, end: …T13:00:00`. Google may reject or create a negative-length event.
- **Fix:** validate `end > start` (and same-day) before submit; also validate attendee emails client-side (a bad address currently flows through).

### F8 · LOW/MED · React "unique key" warning in BrandedHeader — CONFIRMED
- **Where:** console: "Each child in a list should have a unique key prop. Check the render method of `BrandedHeader`." The project/workspace `<option>` list is missing `key`s.
- **Impact:** cosmetic today, but missing keys can cause selection/render glitches on list changes.
- **Fix:** add stable `key`s to the mapped `<option>`s.

### F9 · LOW · Chat error path leaks raw server error text to end users — CONFIRMED
- **Where:** `app/api/chat/route.ts` 500 handler returns `details: err.message`; `app/page.tsx` `sendToApi` renders that string into the chat bubble. The code comments call it a "TEMP DIAGNOSTIC … Remove once the issue is resolved."
- **Fix:** log server-side, show a generic message to users in production.

---

## Verified working (highlights — 59 checks passed)

- **Shell/header:** three panels render for an admin; theme toggle flips `data-theme` and persists; project selector present.
- **Left / KPIs:** Paperclip-source KPIs correctly filtered out of the left panel; tapping a KPI injects `Tell me more about KPI: …` (recall path).
- **Left / Calendar:** week nav, event rows, all-day badge; event tap injects title/when/location/attendees; **delete sends `eventId` + the source `calendarId`** and has a cancel path.
- **Left / Tasks:** two list tabs switch content; due badges (overdue/today/tomorrow) correct; checkbox fires `complete` POST with the right `taskId` and the row fades out after ~1.5 s.
- **Left / Documents:** Recent/Shared/Transcripts/Artifacts tabs; doc tap attaches the **real Drive `fileId` + mimeType**; transcript tap uses the summarize prompt; artifact tap attaches the resolvable `[artifact:id]` marker.
- **Center chat:** SSE streaming + model badge; copy + quoted-reply (prepends `> Replying to:`); attach menu Document/Link/**Text** — text attachment is sent correctly at the top level of the `/api/chat` payload (a first-pass "attachment dropped" flag was a harness false-positive, retracted after native-click verification); skills popover activates a skill and opens the Tool Panel.
- **Interview Mode (create_task, E2E):** "+ Task" FAB → intent detection → context-sufficiency gate → confirm card → **Approve executes a real Google Tasks `create` POST** → success message.
- **Overlay / Google Chat:** spaces grouped (Spaces/Group/DM) with unread badges; selecting a space loads messages; send posts correct `spaceId`+`text` and appears in-thread; **@mention picker inserts `<users/email>` tag**; empty space shows "No messages yet".
- **Overlay / Gmail:** inbox list; open thread; **Compose** (to/subject/body) sends and invalid recipients surface the server 400; Escape closes the overlay. (Reply is the one broken path — see F1.)
- **Right / Business Manager:** health ring (72%), 3 department chips (CEO/COO/CTO), drift/critical alerts, Paperclip deep-link.
- **Right / Execution Feed:** All/Needs You/Completed/In Progress filters with counts; date grouping (Today/Yesterday/Earlier); card tap injects `Tell me more about: …`; Create-Task CTA routes into Interview Mode; Customize-C-Suite opens the FounderLens wizard.

## Test-harness note (not an app bug)
Two controls — the calendar **"+ Event"** button and the chat **"Attach context"** button — repeatedly timed out under Playwright's normal/`force` click, while every other button clicked fine. Native DOM clicks on them work perfectly (modal opens, Save POSTs), and each is a single, visible, enabled element that is its own hit-target. This is Playwright's stability/actionability check tripping on the app's perpetual `requestAnimationFrame`/CSS animations — **a human click lands normally.** Flagged only so the automation flakiness isn't mistaken for a defect.
