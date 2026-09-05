import type { FaultCode } from '@/lib/fault-codes'

/**
 * swallow / emptyOn — the named replacement for zero-arg `.catch(() => …)`
 * (ERROR_REPORTING_2026-08-24.md §3 Layer 4, §3 Layer 9 #2).
 *
 * The distinction between the two exports is load-bearing and permanent:
 *  - `swallow` is for the ~86 benign guards (localStorage, formatting,
 *    best-effort cleanup) where nothing the user asked for is lost.
 *  - `emptyOn` is for the 22 SILENT DATA OMISSION sites — `.catch(() => [])`
 *    / `.catch(() => null)` — where the response is shaped like success but
 *    is missing data. It additionally marks the current request partial so
 *    withFault can send `x-hub-partial: 1` and the client can say "some data
 *    could not be loaded" instead of "nothing here". Choosing emptyOn at a
 *    site records that judgment once so nobody has to re-derive it.
 *
 * ISOMORPHISM CONSTRAINT — this module MUST stay dependency-free. 39 of the
 * 108 call sites it serves are client code ('use client' hooks/components).
 * lib/logger.ts imports pino unguarded, lib/fault.ts imports next/server and
 * node crypto, and anything touching node:async_hooks is server-only; any
 * one of them here breaks every client bundle that swallows a localStorage
 * read. So: console.debug, a module-scope counter, and a TYPE-ONLY import of
 * FaultCode (erased at compile time; lib/fault-codes.ts has no runtime
 * imports either — verified, and it must stay that way). Consequences that
 * are accepted rather than fought:
 *  - No scrubber. scrubFreeText lives in the server-only lib/fault.ts, so the
 *    debug line carries only the error's name and a truncated message. If a
 *    swallowed message could carry a secret, the site is not a swallow — it
 *    is a fault and belongs in toFault/reportFault.
 *  - No request correlation. The line has module/op/code, not requestId; the
 *    counters (not the lines) are the operational signal, same posture as
 *    lib/fault-report.ts.
 *
 * THE "MARK PARTIAL" MECHANISM IS INJECTED, not imported. `emptyOn` calls
 * whatever `setPartialMarker` registered; lib/partial-context.ts (server-only,
 * AsyncLocalStorage) registers itself on import and lib/route-fault.ts
 * imports it. On the client no marker is ever registered, so `emptyOn` only
 * counts — which is the correct client behaviour: there is no response
 * header to set there.
 *
 * REENTRANCY EXCLUSIONS. Three modules keep their own swallows and MUST NOT
 * call swallow(): lib/fault-report.ts (its catch IS the reentrancy latch that
 * stops a report storm — routing it here would add a second sink to the path
 * that must have none), lib/observability.ts (the telemetry sink; a swallow
 * counter inside the thing that ships counters is a loop), and
 * lib/circuit-breaker.ts (its catch is the trip decision, not a swallow —
 * counting it here would double-count every trip as a swallow). The 6
 * `recordEvent(...).catch(() => {})` sites are likewise NOT candidates:
 * recordEvent already catches and log.errors internally (event-logger.ts).
 *
 * DEPRECATED-SURFACE EXCLUSION. lib/paperclip.ts, lib/paperclipSession.ts
 * and app/hooks/useExecutionPanel.ts (whose fetchers target only the retired
 * /api/paperclip/* proxy) keep their zero-arg catches untouched. AGENTS.md:
 * Paperclip is deprecated — do not build on it, reference it, or route work
 * through it — and coupling a retired surface to new fault infrastructure is
 * exactly that. Those catches leave with the modules when the surface is
 * deleted; until then they are not counted here and are not a coverage gap.
 *
 * HARD GUARANTEES: neither export ever throws, for ANY `err` (non-Error,
 * undefined, a throwing getter) and even with a broken console or marker.
 */

export interface SwallowCtx {
  /** Source module, e.g. 'gmail-client' — the grouping dimension. */
  module: string
  /** The operation that failed, e.g. 'listLabels'. */
  op: string
  /** Optional taxonomy code, when the site knows the failure class. */
  code?: FaultCode
  /** 'degraded' = something was lost (emptyOn's natural severity);
   *  'expected' = a modeled non-event (a localStorage guard). Defaults are
   *  applied per export below; a site overrides only when it knows better. */
  severity?: 'degraded' | 'expected'
}

interface SwallowCounters {
  /** Every swallow() and emptyOn() call. */
  swallowed: number
  /** emptyOn() calls only — the silent-data-omission subset. */
  partial: number
}

const counters: SwallowCounters = { swallowed: 0, partial: 0 }

/** The injected request-scoped marker; null on the client and before
 *  lib/partial-context.ts has loaded on the server. */
let partialMarker: (() => void) | null = null

/** Longest error message the debug line will carry — a swallow is not the
 *  place for a stack or a 4 KB upstream body. */
const MAX_MESSAGE_CHARS = 200

/**
 * Register the request-scoped "mark partial" hook. Called by
 * lib/partial-context.ts on import; tests register a spy. Last writer wins —
 * there is exactly one legitimate registrant in production.
 */
export function setPartialMarker(fn: () => void): void {
  partialMarker = fn
}

/** Swallow a benign failure: one debug line, one counter tick, nothing else. */
export function swallow(err: unknown, ctx: SwallowCtx): void {
  counters.swallowed++
  emit(err, ctx, 'expected', false)
}

/**
 * Swallow a failure that LOSES DATA and return `fallback` in its place. Also
 * marks the current request partial (server-side, inside withFault) so the
 * response can carry `x-hub-partial: 1`.
 */
export function emptyOn<T>(err: unknown, ctx: SwallowCtx, fallback: T): T {
  counters.swallowed++
  counters.partial++
  try {
    partialMarker?.()
  } catch {
    // A broken marker must not turn a degraded read into a thrown 500 —
    // that would be strictly worse than the omission it was flagging.
  }
  emit(err, ctx, 'degraded', true)
  return fallback
}

/** Snapshot of the counters (for /api/healthz and digests). */
export function getSwallowCounters(): Readonly<SwallowCounters> {
  return { ...counters }
}

/** Test hook: reset counters AND unregister the marker, so a suite that
 *  installs a spy marker starts clean. lib/partial-context.ts registers on
 *  import only; a test needing the real marker after a reset must
 *  re-register it (see `markPartial` there). */
export function _resetSwallowStateForTests(): void {
  counters.swallowed = 0
  counters.partial = 0
  partialMarker = null
}

function emit(err: unknown, ctx: SwallowCtx, defaultSeverity: SwallowCtx['severity'], partial: boolean): void {
  try {
    console.debug('[swallow]', {
      module: ctx.module,
      op: ctx.op,
      code: ctx.code ?? null,
      severity: ctx.severity ?? defaultSeverity,
      partial,
      errName: errName(err),
      message: errMessage(err),
    })
  } catch {
    // The console can be gone, or `err` can have a throwing getter. A swallow
    // that throws defeats its own purpose.
  }
}

function errName(err: unknown): string {
  if (err instanceof Error) return err.name
  if (err === undefined) return 'undefined'
  if (err === null) return 'null'
  return typeof err
}

function errMessage(err: unknown): string {
  let text: string
  if (err instanceof Error) text = err.message
  else if (typeof err === 'string') text = err
  else if (err === undefined || err === null) text = ''
  else {
    try {
      text = JSON.stringify(err) ?? String(err)
    } catch {
      text = String(err)
    }
  }
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text
}
