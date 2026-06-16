# Hub — Chat ↔ Integration & AI Model-Rotation Audit

**Date:** 2026-06-13
**Scope:** Why the AI Assistant Chat lost context on Tasks / Calendar / Drive / Chat data; multi-tenant hardening of the Google connections; resilience of the AI model rotation.

---

## 1. Root cause — the chat had no context on the integration data

`app/api/chat/route.ts` assembled context from Paperclip, Vertex AI, pgvector, Exa and attachments — but **never fetched the user's Google Workspace data and never passed it to the model.** `buildSystemPrompt()` already accepted a `googleWorkspace` parameter, yet the route's call omitted it, and the frontend only sent `messages / useCase / attachments / activeSkill`.

The assistant was therefore structurally blind to Tasks, Calendar, Drive and Chat. The system prompt had then been hardened in the *wrong* direction — telling the model these systems were "COMPLETELY INDEPENDENT" and to redirect the user to the side panel — which masked the missing wiring instead of fixing it.

**Fix**
- New `lib/google-context.ts` → `buildGoogleWorkspaceContext(accessToken)` fetches a bounded snapshot (pending tasks across the first 5 lists, ~15 upcoming events, recent Drive files, Chat spaces). Each service has its own try/catch so one slow API never blanks the rest.
- `app/api/chat/route.ts` resolves the OAuth token once, fetches the snapshot behind a 6 s aggregate timeout, and injects it via `buildSystemPrompt({ googleWorkspace, googleWorkspaceDetail, googleReauthRequired })`.
- `lib/gemini.ts` prompt rewritten: the model now uses the injected "Live Google Workspace" section directly and cites real items; if absent/expired it says so honestly instead of deflecting.

## 2. Why it intermittently "lost connection" — token-refresh fragility

In `lib/auth.ts`, a failed refresh returned `{ ...token, error }` while keeping the **stale** access token and a **past** expiry. Every Google route (`tasks`, `calendar`, `drive`, `gmail`, `chat/*`) read `token.accessToken` directly, never checked `token.error`, fired Google calls with a dead token → Google 401 → the route returned an opaque **500**. The client's existing auto-recovery only triggers on **401**, so the panels silently went dark instead of re-authenticating. A missing `expires_at` (→ `NaN`) also forced a refresh on every request.

**Fix**
- `lib/auth.ts`: clear the dead `accessToken` on refresh failure; clear `error` on success; 60 s refresh-skew buffer; `NaN` guard on initial `expires_at`.
- New `lib/google-session.ts`: `resolveGoogleAuth(req)` honors `token.error` and returns a clean re-auth signal; `reauthResponse()` returns **401 `{ reauth: true }`**; `googleApiErrorResponse()` maps upstream Google 401/403 → 401 re-auth, everything else → 502 (not a hub 500).
- All seven Google routes refactored onto these helpers. A 401 now flows into the existing `useAuthErrorRecovery` → `signIn('google')` path, so an expired session self-heals instead of going dark.

**Multi-tenancy:** Google data is fetched with the **caller's own per-user OAuth token**, so it is inherently user/tenant-isolated; the pgvector path continues to scope by `getTenantId()`. No shared/service credential is used for user data, so there is no cross-tenant leakage surface.

## 3. AI model-rotation weaknesses (`lib/gemini.ts` `streamGeminiChat`)

| Weakness | Fix |
|---|---|
| Mid-stream fallback **corrupted output** — if flash failed after emitting chunks, pro restarted and the partial text stayed on the wire (duplicated/garbled answer). | `emittedAny` guard: fall back only *before* the first token; after that the error propagates cleanly. |
| Timeout covered only **opening** the stream; a model that connected then stalled hung up to the 120 s route limit. | Per-chunk **idle watchdog** (30 s) racing each iterator step, plus the existing 60 s connect timeout. |
| **All errors treated alike** — an auth/key/billing failure (which dooms both models on the same key) wasted a 2 s "fallback" that could never succeed. | `isFallbackWorthwhile()` fast-fails on auth/key/permission/billing; only transient/model-specific errors (429, 5xx, overload, timeout) trigger rotation. |
| `APPROVED_MODELS` and the `modelsToTry` chain were **two hand-synced literals**. | Single source of truth via `resolveModelChain()`; optional `GEMINI_MODEL_CHAIN` env override, every entry still validated against the allowlist. |

---

## Files changed
- `lib/auth.ts` — refresh hardening (skew buffer, NaN guard, dead-token clearing)
- `lib/google-session.ts` — **new** shared auth resolution + error mapping
- `lib/google-context.ts` — **new** live Workspace context builder
- `lib/gemini.ts` — prompt update + model-rotation rewrite
- `app/api/chat/route.ts` — inject live Google Workspace context
- `app/api/google/{tasks,calendar,drive,gmail}/route.ts` — re-auth signaling
- `app/api/google/chat/{spaces,messages,members,readstate}/route.ts` — re-auth signaling

## Verification
- TypeScript: clean on all fully-synced files; remaining tsc errors were OneDrive sync-truncation artifacts only (no genuine type/`'}'` mismatches). Complex regions re-verified against on-disk truth.
- **Run `npm run build` locally before deploying** — the sandbox can't reliably compile against the cloud-synced mount.
