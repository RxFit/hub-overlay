/**
 * Desktop dispatch worker — entry point (Phase 2.5 PR 2).
 *
 * Runs inside the scripts/agy-worker/ container on the operator's desktop:
 *   npx tsx scripts/dispatch-worker.ts
 * All logic lives in @/lib/dispatch-worker (unit-tested in the hub suite);
 * this file only reads config, wires shutdown, and starts the slots.
 *
 * IMPORT ORDER IS LOAD-BEARING (ERROR_REPORTING §3 Layer 8/10). The ONLY
 * static import here is fault-process, because ESM hoists and fully evaluates
 * every static import before the first statement of this module body runs.
 * Importing @/lib/dispatch-worker statically pulled in its whole graph —
 * including lib/logger.ts, which constructs pino at module scope — BEFORE the
 * handlers were installed, so any import-time throw died with a raw stack and
 * no structured record. Reproduced with `LOG_LEVEL=bogus npx tsx
 * scripts/dispatch-worker.ts`: pino throws, exit 1, zero '[fault-process]'
 * output. The worker graph is therefore loaded by a DYNAMIC import below,
 * after the handlers exist. tests/dispatch-worker-entry.test.ts pins this with
 * a real child process, because listener-count assertions cannot see ESM
 * import order.
 */
import { installProcessFaultHandlers } from '@/lib/fault-process'

installProcessFaultHandlers({ surface: 'dispatch-worker' })

async function main(): Promise<void> {
  // Dynamic: evaluated only after the handlers above are installed.
  const { startWorker, workerConfigFromEnv } = await import('@/lib/dispatch-worker')

  const cfg = workerConfigFromEnv()
  if ('error' in cfg) {
    console.error(`[dispatch-worker] ${cfg.error}`)
    process.exit(2)
  }

  const stop = new AbortController()
  // Docker stop sends SIGTERM: finish nothing new, let in-flight jobs post,
  // then exit. The lease/reaper machinery covers anything cut short.
  process.on('SIGTERM', () => stop.abort())
  process.on('SIGINT', () => stop.abort())

  await startWorker(cfg, {}, stop.signal)
}

// NOTE the deliberate absence of a rejection handler. A `.catch()` that merely
// console.error'd would mark the rejection HANDLED, which suppresses Node's
// default promotion to an uncaught exception — and that promotion is exactly
// what lets the installed uncaughtExceptionMonitor emit the one scrubbed,
// structured worker record before the process dies nonzero. Swallowing here
// would silently undo the capture this file exists to provide.
main().then(() => process.exit(0))
