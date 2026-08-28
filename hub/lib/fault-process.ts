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
 * `unhandledRejection`: the correct answer is SURFACE-DEPENDENT, which is why
 * the listener is gated rather than global. Verified empirically on node 22.
 *
 * WITHOUT a listener (plain Node, the worker):
 *     uncaughtExceptionMonitor fires with origin='unhandledRejection',
 *     THEN the process dies (exit 1).
 * WITH a listener:
 *     the listener fires, the monitor does NOT, and the process survives
 *     (exit 0) — because ANY listener suppresses Node's default throw.
 *
 * So on the WORKER we register nothing, exactly as the spec's Layer 8 says.
 * Its reasoning holds there in full: a log-only listener would downgrade a
 * crash to a swallow and leave the worker claiming and executing dispatch
 * jobs after a programmer error, in the corrupted state Joyent's doctrine is
 * about. Registering nothing costs no observability — the monitor above still
 * reports it, correctly labelled — and keeps the crash.
 *
 * On NEXT-SERVER the spec's premise does not hold, because the framework got
 * there first. next@14.2.35's dist/server/lib/start-server.js registers,
 * unconditionally and in production:
 *
 *     process.on("uncaughtException", exception)
 *     process.on("unhandledRejection", exception)
 *     // const exception = (err) => { console.error(err) }
 *     // comment in Next's source: "we keep the process alive"
 *
 * There, Node's default-throw is ALREADY suppressed by Next: the rejection is
 * never promoted, so the monitor never sees it, and the class would be
 * visible only as Next's unstructured, UNSCRUBBED console.error. Our listener
 * cannot downgrade a crash the framework already prevented, so it is purely
 * additive: one scrubbed, fingerprinted record.
 *
 * Residual, stated rather than hidden: on next-server Next's raw console.error
 * still prints first, so a rejection whose message embeds a secret is logged
 * unscrubbed by the framework. Removing Next's own listener to prevent that
 * would change crash semantics and is deliberately out of scope.
 * ─────────────────────────────────────────────────────────────────────────
 */

/** Which process this is — the records are otherwise indistinguishable, and
 *  "which process died" is the first question an operator asks. */
export type FaultSurface = 'next-server' | 'dispatch-worker'

/**
 * KNOWN LIMITATION on the 'dispatch-worker' surface, stated so this is never
 * mistaken for more than it is. The worker runs in Docker on the operator's
 * desktop and NEVER on Cloud Run (scripts/agy-worker/Dockerfile); it reaches
 * the Hub only over HTTPS, and app/api/worker exposes exactly three routes —
 * claim, heartbeat and result. So a record written here reaches that
 * container's local stderr (`docker logs`) and nothing else: it does not land
 * in Cloud Logging, and the Hub still sees only a lease expiring.
 *
 * What this DOES buy: the crash is now structured, scrubbed and attributable
 * locally, where previously it was a raw stack or nothing at all. What it does
 * NOT buy: remote diagnosis. Closing that needs a worker fault sink — spool
 * the record and upload it on the next claim, or add a dedicated endpoint —
 * which is its own change (endpoint, shared-secret auth, spool file, size
 * caps, retry) and is tracked in the spec's Layer 10. Deliberately not widened
 * into this PR.
 */

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

  // 2. Unhandled rejections — NEXT-SERVER ONLY. Registering this on the plain
  //    Node worker would suppress Node's default throw and leave a corrupted
  //    worker claiming and running jobs (see the module header). On the worker
  //    we deliberately register nothing: the default promotes the rejection to
  //    an uncaught exception, so handler 1 above reports it with
  //    `origin: 'unhandledRejection'` AND the process still dies.
  if (surface === 'next-server') process.on('unhandledRejection', (reason: unknown) => {
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
