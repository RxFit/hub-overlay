# Hub Chat ↔ Panels — Stress Test

**Date:** 2026-06-17
**Goal:** Stress-test the chat interface's connections to the left/right panels —
the integration points every panel tap and chat turn flow through — under
concurrency, failure injection, timing stalls, and adversarial input.

The test environment is node-only vitest (no React renderer), so the stress is
applied at the two **pure boundaries** that carry all chat↔panel traffic:
1. the **model-rotation engine** (`lib/gemini.ts` `streamChat`) — every chat turn
   and every panel inject is answered through it;
2. the **panel → chat payload builders** (`lib/panel-inject.ts`) — the exact
   message/attachment a tapped Task / Calendar event / Drive document sends in.

To make these testable the inject builders were extracted from
`LeftPanelSections.tsx` into `lib/panel-inject.ts` (behavior-identical; the
component now imports them), and three internal helpers in `gemini.ts` were
exported (`withIdleWatchdog`, `isRateLimitError`, `isAuthOrKeyError`).

## Results — 24 new tests, all passing (suite total 31 → 55)

### Model rotation (`lib/gemini.test.ts`, 12)
Claude + Gemini SDKs mocked so failures/timing are injected deterministically.
- **Fallback ordering** — Fable 5 → Sonnet 4.6 → Gemini Flash on pre-stream failures.
- **No mid-stream duplication (Claude)** — Fable 5 emits then fails → partial text
  preserved, error propagates, backup + Gemini never run (the `emittedAny` guard).
- **No mid-stream duplication (Gemini)** — Flash emits then fails → Pro never runs.
- **Auth fast-fail** — a 401/auth error skips the whole Claude chain (shared key)
  straight to Gemini instead of burning the backup.
- **recall skips Claude** — the panel-tap default use case goes straight to Gemini.
- **Cooldown** — a failed model is skipped (without even emitting its badge) on the
  next call.
- **Concurrency** — 50 simultaneous streams each get their own answer, no cross-talk.

### Idle watchdog (`lib/gemini.test.ts`)
- Passes through a prompt iterator unchanged.
- Fires after the idle window on a connected-then-stalled stream **and** tears down
  the upstream iterator.
- Tears down the upstream iterator when the consumer breaks early.

### Error classifiers
- `isRateLimitError` / `isAuthOrKeyError` classification tables (429/quota/overload
  vs 401/403/key/permission/billing).

### Panel → chat payload builders (`lib/panel-inject.test.ts`, 12)
- Task / Event / Document builders carry the right fields; missing fields omitted.
- **Adversarial input** — 50k-char notes/descriptions clamped to 500 with whitespace
  collapsed; empty / unicode / emoji / markup titles never throw.
- Document taps always carry the real Drive `fileId` attachment.
- Date formatters are crash-proof on garbage/empty/huge strings; relative-time
  bucketing verified.
- Throughput — 10k task builds stay deterministic and < 2s.

## Bugs found
The rotation hardening (PR #1) and the dead-code/perf pass (PR #2) hold up under
stress — no behavioral defects. One **pre-existing minor resource leak** was
surfaced and **fixed in this pass**: the 60 s Gemini connect-timeout `setTimeout`
in `streamGeminiWithFallback` was never `clearTimeout`-ed on a successful connect,
leaving a pending timer per call until it fired. Now cleared in a `finally`.

## Verification
- `npx tsc --noEmit` — clean
- `npx vitest run` — 55/55 passing
</content>
