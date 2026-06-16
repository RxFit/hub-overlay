# Hub AI Chat — Technical & Functional Audit

**Date:** 2026-06-14
**Scope:** The AI Assistant Chat interface and its connections to backend tools/data sources (Google Workspace, Paperclip, Vertex AI, pgvector, Exa, model rotation). Server-side role-enforcement / auth security findings were surfaced but **deferred to a separate pass** per request.
**Method:** Direct read of the live code path (`app/page.tsx` → `app/api/chat/route.ts` → `lib/gemini.ts`/`lib/claude.ts` and the connector libs) plus three parallel deep-dive audits.

> **Important context — codebase divergence.** The files changed between sessions: `lib/gemini.ts` is now a newer `streamChat` implementation (Claude "Fable 5" → Gemini fallback with per-model cooldowns) and the prior session's fixes were not present. This audit and all fixes are based on the **current** files. The live chat stack is `app/page.tsx`; a second stack under `app/components/Hub/` appears to be parallel/older code (page.tsx does not import it) and should be confirmed dead and removed, or it will keep skewing audits.

---

## Reproduction analyzed
Tapping the Google Task **"pay the Easy Tofee"** injected `Tell me about task: pay the Easy Tofee` and the assistant replied with the Paperclip "API may be warming up… check the Documents panel" deflection.

### Root cause (three compounding defects)
1. **No structured data on tap.** `LeftPanelSections.tsx:230` sent only the bare title string — none of the task's notes/due/status/list.
2. **The chat route never fetched Google data.** `app/api/chat/route.ts` assembled context from Paperclip + Vertex + pgvector + Exa + attachments only. `buildSystemPrompt` accepts a `googleWorkspace` param that the route never passed. The assistant was structurally blind to Tasks/Calendar/Drive/Chat.
3. **Misapplied deflection prompt.** With empty context, `lib/gemini.ts` instructed the model to say *"I couldn't retrieve live data from Paperclip right now — the API may be warming up"* and to redirect to the Documents panel — guidance written for Paperclip outages, fired on a Google Tasks question.

---

## ✅ Fixes applied in this pass

| # | Fix | Files |
|---|-----|-------|
| F1 | **New live Google Workspace context builder** — fetches pending tasks (titles, due, notes), upcoming events, recent Drive files, and Chat spaces; each service isolated in its own try/catch. | `lib/google-context.ts` (new) |
| F2 | **Chat route now fetches & injects that snapshot** behind a 6 s timeout (token resolved once, reused for attachments), passing both counts and detail to the prompt. | `app/api/chat/route.ts` |
| F3 | **Prompt renders a "Live Google Workspace" section** and tells the model to answer Tasks/Calendar/Drive/Chat questions from it. | `lib/gemini.ts` (`buildSystemPrompt`) |
| F4 | **Deflection guidance scoped to Paperclip only** — the "warming up" line is now explicitly forbidden for Google questions; missing items get an honest "I don't see it" instead of blaming a system. | `lib/gemini.ts` (system prompt) |
| F5 | **Task taps carry real details inline** (list, due, status, notes) so even completed/out-of-window items answer correctly. | `app/components/LeftPanelSections.tsx` |

Together F1–F5 resolve the reported interaction: the model now receives the user's actual tasks and the tapped task's details, and the prompt no longer routes Google questions into the Paperclip deflection.

---

## Findings — Chat request pipeline

**Critical / High (functional)**
- **[Fixed F1–F4] No Google Workspace data reached the model** — every "Tell me about task/event/file" tap hit empty context → deflection.
- **Panel taps never populate structured `injectedContext`.** `setInjectedContext` is only ever called with `null`; the `ContextInjectionBanner` is dead UI. Taps pass plain strings. *F5 mitigates tasks; calendar/Drive/KPI taps still pass bare strings (now covered by the live snapshot, but structured injection would be more robust).*
- **`recall` useCase fetches pgvector only.** Left-panel taps route as `recall`, which skips Vertex; before F1–F2 that meant Google-panel taps had no backing data at all. The unconditional Google fetch now covers this regardless of useCase.

**Medium**
- **Client 45 s abort vs server budget mismatch.** Client aborts at 45 s (`page.tsx`); server `maxDuration=120`, internal Gemini connect timeout 60 s, plus ~8 s + 10 s + 6 s pre-stream. A slow-but-valid first model can blow the 45 s client budget and the user sees a timeout while the server keeps streaming into a dead socket. *Recommend: raise client abort to ~90 s or lower server-side timeouts so first byte < 45 s.*
- **`sendToApi` called inside the `setMessages` updater** (`page.tsx` ~902, ~869). State updaters must be pure; under React 18 StrictMode the updater can run twice → duplicate API calls. *Recommend: compute `updated` outside the updater, then send.*
- **Attachment size limits inconsistent.** Text capped 10k (UI) vs 16k (server); URL/document content has **no** cap and resolves sequentially with no per-item timeout → a large doc/page can blow the token budget or hang to the client abort. *Recommend: cap URL/doc content and wrap attachment resolution in a timeout.*

**Low**
- **Message IDs use `String(Date.now())`** for streamed + error messages → key collisions if two land in the same ms. *Use `crypto.randomUUID()` everywhere.*
- **Error event overwrites streamed content** — a mid-stream `error` replaces the whole bubble, discarding already-streamed text. *Append instead of overwrite.*
- `suggestedTools` HTML comment leak is **already handled** (`MessageContent.tsx:57` strips it). No action.

## Findings — Tool connections

**High**
- **Paperclip base URL & default company/agent IDs are hardcoded RxFit values** (`lib/paperclipConfig.ts`, `app/api/paperclip/issues/route.ts`). Any tenant/deploy missing env vars talks to RxFit's backend or writes issues into RxFit's org. *Require env vars; fail closed. (Ties into the deferred multi-tenancy pass.)*
- **`getRuns` has no Zod schema and swallows per-issue errors to `[]`** (`lib/paperclip.ts`). A shape/auth failure is indistinguishable from "zero runs," and it feeds chat's "Recent Agent Runs" and KPI health → can mask real failures. *Validate; distinguish empty from error.*
- **`paperclipFetch` returns unvalidated data on schema-parse failure** (`return json as T`) — contract drift silently flows in as if valid. *Throw on list-endpoint schema failure so retry/breaker engage.*

**Medium**
- **Vertex error vs empty are indistinguishable** (`lib/vertex.ts` returns `null` for 400/403/timeout/empty alike); the route then injects near-identical "independent / check the panel" prose for both. The model can't tell auth failure from "no docs." *Return a discriminated status and inject status-specific context.* (F4 reduces the user-facing symptom.)
- **Vertex datastore filter is a hardcoded `rxfit-gdrive` literal** with likely-wrong filter syntax for multi-datastore engines → 400 swallowed to null. *Verify filter format; make datastore tenant-derived.*
- **Google REST client and KPI sources have no fetch timeouts** (`lib/google.ts`, `lib/kpi-sources/*`). A hung upstream is bounded only by route `maxDuration`. *Add `AbortSignal.timeout` to all outbound calls.* (The new `google-context.ts` is already bounded by the route's 6 s `withTimeout`.)
- **Resilience helpers (circuit-breaker/retry/loop-detector) wrap only Paperclip** — Vertex, Exa, Google, KPI, pgvector make bare `fetch` calls. *Wrap or document the asymmetry.*
- **`getTenantId()` defaults to `rxfit` outside a request scope** (cron/scripts) — the KPI sync cron writes all KPIs under `rxfit`. *Require explicit tenantId for non-request callers.*

**Low**
- **Exa swallows all errors to `[]`** — a bad API key looks like "no results." *Distinguish failure.*
- **`content-fetch` blocks all redirects** (`redirect:'error'`) — common 301/302 attachment URLs silently fail. *Follow one redirect then re-run the SSRF check.*
- **Stripe "MRR" is `revenueThisMonth` relabeled** and capped at 100 charges (no pagination) — misleading metric, undercounts. *Rename / paginate.*

## Findings — Model rotation (`lib/gemini.ts` `streamChat`)
- **Mid-stream fallback can duplicate output.** If Claude (or Gemini Flash) fails *after* emitting chunks, the chain falls back and restarts, but the partial text is already streamed to the client → duplicated/garbled answer. *Only fall back before the first token; after that, propagate the error.*
- **The `⚠️ Primary model unavailable` notice is yielded into the message body**, so it becomes part of saved content and is run through the suggestedTools regex. Minor; consider a dedicated SSE event.
- **Per-model cooldown map (W-2/W-3) is sound**; classification uses Claude's `rate_limit` type. Gemini failures always get the 5-min cooldown even for rate limits — consider classifying 429 there too.
- Connect timeout (60 s) covers opening the stream but **not a mid-stream stall**; a model that connects then hangs blocks to `maxDuration`. *Add a per-chunk idle watchdog.*

## Deferred — security / auth (separate pass, per request)
Flagged but **not addressed** here: Interview Mode's role gating for destructive Paperclip actions (delete agent/workspace, assign/​update issue, create agent) appears enforced **client-side only**; the server proxy enforces project-scope but not the intent→role level (only `create_workspace` has a matching server guard). The client context-sufficiency gate also defaults to pass on a missing score. These live partly in the possibly-dead `components/Hub/` stack and need a dedicated security pass to confirm the live execution path and add server-side enforcement.

---

## Verification & caveats
- All five fixes were verified against on-disk truth via direct file reads and a manual type review (the new builder uses only existing `lib/google.ts` exports; route and prompt signatures line up).
- **TypeScript could not be compiled in-session:** the OneDrive-synced mount serves just-edited files truncated to the sandbox, so `tsc`/`next build` there only produce false truncation errors. **Run `npm run build` locally before deploying** for a clean compile.
- If you have the project open in an IDE, re-pull/reconcile so these edits aren't overwritten (as the prior session's were).
