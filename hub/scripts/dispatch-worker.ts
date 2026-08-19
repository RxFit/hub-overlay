/**
 * Desktop dispatch worker — entry point (Phase 2.5 PR 2).
 *
 * Runs inside the scripts/agy-worker/ container on the operator's desktop:
 *   npx tsx scripts/dispatch-worker.ts
 * All logic lives in @/lib/dispatch-worker (unit-tested in the hub suite);
 * this file only reads config, wires shutdown, and starts the slots.
 */
import { startWorker, workerConfigFromEnv } from '@/lib/dispatch-worker'

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

startWorker(cfg, {}, stop.signal)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[dispatch-worker] fatal:', err instanceof Error ? err.message : err)
    process.exit(1)
  })
