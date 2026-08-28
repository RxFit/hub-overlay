import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

/* ════════════════════════════════════════════════════════════════════════════
   The worker entrypoint's IMPORT ORDER (§3 Layer 8/10).

   This must be a real child process. ESM hoists and fully evaluates every
   static import before the module body runs, so an in-process listener-count
   assertion cannot see the bug this pins: when @/lib/dispatch-worker was
   imported statically, its whole graph — including lib/logger.ts, which builds
   pino at module scope — was evaluated BEFORE the fault handlers existed, and
   an import-time throw died with a raw stack and no structured record.

   The forcing function is a deliberately invalid LOG_LEVEL, which makes pino
   throw during module initialization of lib/logger.ts.
   ════════════════════════════════════════════════════════════════════════════ */

const hubRoot = join(__dirname, '..')

/** A token-shaped bad level, so the SAME run also proves the crash path is
 *  scrubbed: the value is interpolated into pino's error message verbatim. */
const SECRET_LEVEL = 'sk-supersecrettoken1234'

function runEntrypoint() {
  return spawnSync('npx', ['tsx', 'scripts/dispatch-worker.ts'], {
    cwd: hubRoot,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, LOG_LEVEL: SECRET_LEVEL, NODE_ENV: 'production' },
  })
}

describe('an import-time failure in the worker graph is still captured', () => {
  it('emits exactly one structured dispatch-worker record and exits nonzero', () => {
    const res = runEntrypoint()

    // 1. The crash is preserved — never swallowed into a clean exit.
    expect(res.status, `expected nonzero exit, got ${res.status}`).not.toBe(0)

    // 2. Exactly one structured fault record, and it is OURS (the worker's).
    const records = (res.stderr ?? '')
      .split('\n')
      .filter((l) => l.trim().startsWith('{'))
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .filter((r): r is Record<string, any> => r !== null && r.surface === 'dispatch-worker')

    expect(records).toHaveLength(1)
    const [rec] = records
    expect(rec.severity).toBe('CRITICAL')
    expect(rec.serviceContext.service).toBe('hub-worker')
    expect(rec.fault.layer).toBe('process')
    expect(rec.fault.severity).toBe('fatal')
    // The diagnosis actually points at the module that failed to initialize.
    expect(rec.fault.stack).toContain('lib/logger.ts')

    // 3. The record is scrubbed. NOTE what is deliberately NOT asserted:
    //    Node's own raw crash output also prints to stderr and is outside our
    //    control, so the secret does appear elsewhere in the stream. The
    //    contract is that OUR record is clean.
    const serialized = JSON.stringify(rec)
    expect(serialized).not.toContain(SECRET_LEVEL)
    expect(serialized).toContain('<token>')
  }, 90_000)
})
