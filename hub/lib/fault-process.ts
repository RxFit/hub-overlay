import fs from 'node:fs'
import { toFault, scrubFreeText, type FaultDraft } from '@/lib/fault'
import { getFaultReportCounters } from '@/lib/fault-report'

/**
 * Process-level fault capture (ERROR_REPORTING_2026-08-24.md §3 Layer 8).
 *
 * The last line of defense: `withFault` catches at the request boundary, but a
 * throw from a timer, a stream callback, or module scope reaches nobody. Today
 * that produces NOTHING actionable — and for `scripts/dispatch-worker.ts`,
 * which lives outside the Next runtime entirely, server-side lease expiry can
 * only ever report that the worker "went quiet", never why.
 *
 * THREE RULES, each the result of a specific failure mode:
 *
 *  1. `uncaughtExceptionMonitor`, NEVER `uncaughtException`. The monitor fires
 *     for full observability WITHOUT becoming a handler, so it cannot change
 *     crash semantics. Registering a real `uncaughtException` handler makes
 *     the process exit 0 — a crash that reports as a clean shutdown.
 *
 *  2. Every write is `fs.writeSync(stderr)`. Mid-crash, a buffered async
 *     destination is the single most likely thing to lose exactly the line
 *     explaining why you died: on Cloud Run stdout is a pipe, so console.log
 *     is asynchronous and its buffer dies with the process. That is also why
 *     this module never calls `reportFault()` (async console.log + a
 *     fire-and-forget DB write, both worthless here) and never touches pino:
 *     a pino transport is a worker thread, and worker-thread bundling under
 *     Next fails at runtime with `Cannot find module 'real-require'` — the
 *     failing subsystem would be the one that logs the failure.
 *
 *  3. The signal handler NEVER calls `process.exit()`. `next start` installs
 *     its own SIGTERM handler (`server.close(() => process.exit(0))`, verified
 *     in next@14.2.35 `dist/server/lib/start-server.js`); ours merely appends
 *     to the listener list, and exiting would preempt Next's drain. Note this
 *     is what makes a log-only listener safe: Node's default SIGTERM behavior
 *     is replaced as soon as ANY listener exists, so without Next's handler a
 *     log-only listener would hang the container until SIGKILL.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * DELIBERATE DEVIATION from the spec's Layer 8, with evidence.
 *
 * The spec says to install NO `unhandledRejection` listener, reasoning that
 * "Node >=15 already defaults to throw, so a log-only listener would silently
 * downgrade a crash to a swallow." That reasoning does not hold for the
 * PINNED Next version. next@14.2.35's `dist/server/lib/start-server.js`
 * already registers, unconditionally and in production:
 *
 *     process.on("uncaughtException", exception)
 *     process.on("unhandledRejection", exception)
 *
 * where `exception` is `(err) => { console.error(err) }` with the comment
 * "This is the render worker, we keep the process alive". So on this version
 * Node's default-throw is ALREADY overridden by the framework: an unhandled
 * rejection neither crashes the process nor is ever promoted to an uncaught
 * exception — which means `uncaughtExceptionMonitor` above never sees one.
 * Omitting our listener therefore does not preserve a crash; it just leaves
 * the class invisible except as Next's own unstructured, UNSCRUBBED
 * console.error.
 *
 * Our listener cannot downgrade anything (Next's swallow already happened)
 * and is purely additive: one scrubbed, fingerprinted record. Residual we
 * cannot fix from here: Next's raw console.error still prints first, so an
 * unhandled rejection whose message embeds a secret is logged unscrubbed by
 * the framework. Removing Next's listener to prevent that would change crash
 * semantics and is deliberately out of scope.
 * ─────────────────────────────────────────────────────────────────────────
 */

/** Which process this is — the records are otherwise indistinguishable, and
 *  "which process died" is the first question an operator asks. */
export type FaultSurface = 'next-server' | 'dispatch-worker'

/** GCP LogEntry severities (Error Reporting ingests ERROR and above). */
const CRITICAL = 'CRITICAL'
const INFO = 'INFO'

let installed = false

/** Write one line synchronously to stderr. Never throws: this runs on the
 *  crash path, where a throw would replace the diagnosis with noise. */
function writeSyncLine(line: Record<string, unknown>): void {
  try {
    fs.writeSync(process.stderr.fd, `${JSON.stringify(line)}\n`)
  } catch {
    // Last resort — a structured write failed (EAGAIN on a full pipe, a
    // serialization cycle). Emit something rather than nothing.
    try {
      fs.writeSync(process.stderr.fd, '[fault-process] failed to serialize a process fault\n')
    } catch {
      /* stderr itself is gone; there is no third option */
    }
  }
}

/** Build the GCP ReportedErrorEvent-shaped line for a process fault. The same
 *  wire shape lib/fault-report.ts emits, so both sinks group identically. */
function processFaultLine(
  fault: FaultDraft,
  rawStack: string | null,
  surface: FaultSurface,
  extra: Record<string, unknown> = {},
) {
  return {
    severity: CRITICAL,
    // Error Reporting evaluates stack_trace then exception then message; a
    // real V8 stack (line numbers KEPT, unlike FaultRecord.stack) groups best.
    message: rawStack ? scrubFreeText(rawStack) : `${fault.errName ?? fault.code}: ${fault.message}`,
    serviceContext: { service: surface === 'dispatch-worker' ? 'hub-worker' : 'hub', version: fault.release },
    surface,
    ...extra,
    fault: { ts: new Date().toISOString(), ...fault },
  }
}

/**
 * Install the process-level handlers. Idempotent — `register()` can run more
 * than once under Next, and the worker entrypoint imports this module too.
 * Returns true if it installed, false if it was already installed.
 */
export function installProcessFaultHandlers(opts: { surface: FaultSurface }): boolean {
  if (installed) return false
  installed = true
  const { surface } = opts

  // 1. Uncaught exceptions — observe only, never handle (see rule 1).
  process.on('uncaughtExceptionMonitor', (err: unknown, origin?: string) => {
    try {
      const fault = toFault(err, {
        layer: 'process',
        module: surface,
        severity: 'fatal',
        context: { kind: origin ?? 'uncaughtException' },
      })
      writeSyncLine(
        processFaultLine(fault, err instanceof Error ? (err.stack ?? null) : null, surface, {
          origin: origin ?? 'uncaughtException',
        }),
      )
    } catch {
      writeSyncLine({ severity: CRITICAL, surface, message: '[fault-process] uncaughtExceptionMonitor failed to normalize' })
    }
  })

  // 2. Unhandled rejections — additive observability; see the deviation note
  //    in the module header for why this exists despite the spec.
  process.on('unhandledRejection', (reason: unknown) => {
    try {
      const fault = toFault(reason, {
        layer: 'process',
        module: surface,
        severity: 'fatal',
        context: { kind: 'unhandledRejection' },
      })
      writeSyncLine(
        processFaultLine(fault, reason instanceof Error ? (reason.stack ?? null) : null, surface, {
          origin: 'unhandledRejection',
        }),
      )
    } catch {
      writeSyncLine({ severity: CRITICAL, surface, message: '[fault-process] unhandledRejection failed to normalize' })
    }
  })

  // 3. Shutdown — the ONLY moment the per-instance drop accounting can be
  //    read, and it is what tells you a ceiling was hit during a deploy. No
  //    process.exit() (rule 3), no Postgres flush: a slow socket would eat the
  //    whole 10s window and the SIGKILL lands anyway.
  const onSignal = (signal: string) => () => {
    try {
      writeSyncLine({
        severity: INFO,
        surface,
        signal,
        message: `[fault-process] ${surface} received ${signal}`,
        faultCounters: getFaultReportCounters(),
      })
    } catch {
      /* never let shutdown accounting break shutdown */
    }
  }
  process.on('SIGTERM', onSignal('SIGTERM'))
  process.on('SIGINT', onSignal('SIGINT'))

  return true
}

/** Test hook: allow a suite to re-install against a fresh process mock. */
export function _resetProcessFaultStateForTests(): void {
  installed = false
}
