import { describe, it, expect, beforeEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { createRequire } from 'node:module'
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
const require = createRequire(import.meta.url)
const tsxCli = require.resolve('tsx/cli')

/** A token-shaped bad level, so the SAME run also proves the crash path is
 *  scrubbed: the value is interpolated into pino's error message verbatim. */
const SECRET_LEVEL = 'sk-supersecrettoken1234'

/** Each run gets its own spool file so the assertions cannot see a stale one. */
let spoolFile: string

function runEntrypoint() {
  return spawnSync(process.execPath, [tsxCli, 'scripts/dispatch-worker.ts'], {
    cwd: hubRoot,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      LOG_LEVEL: SECRET_LEVEL,
      NODE_ENV: 'production',
      FAULT_SPOOL_PATH: spoolFile,
    },
  })
}

beforeEach(() => {
  spoolFile = join(fs.mkdtempSync(join(os.tmpdir(), 'entry-spool-')), 'faults.ndjson')
})

describe('an import-time failure in the worker graph is still captured', () => {
  it('emits exactly one structured dispatch-worker record and exits nonzero', () => {
    const res = runEntrypoint()

    // 1. The child actually launched and the crash is preserved. A bare
    // `spawnSync('npx', ...)` cannot resolve npx.cmd on Windows; without these
    // assertions that ENOENT produced status=null, which looked nonzero while
    // the test never exercised the worker at all.
    expect(res.error).toBeUndefined()
    expect(res.status, `expected crash exit 1, got ${res.status}`).toBe(1)

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
    expect(rec.fault.stack.replaceAll('\\', '/')).toContain('lib/logger.ts')

    // 3. The record is scrubbed. NOTE what is deliberately NOT asserted:
    //    Node's own raw crash output also prints to stderr and is outside our
    //    control, so the secret does appear elsewhere in the stream. The
    //    contract is that OUR record is clean.
    const serialized = JSON.stringify(rec)
    expect(serialized).not.toContain(SECRET_LEVEL)
    expect(serialized).toContain('<token>')

    // 4. END TO END: the same crash also SPOOLED the record, which is what
    //    the next boot uploads to the Hub. Without this, worker crashes stay
    //    in the desktop container's docker logs and the server can still only
    //    observe a lease expiring (§3 Layer 10).
    expect(fs.existsSync(spoolFile), 'crash did not write the upload spool').toBe(true)
    const spooled = fs
      .readFileSync(spoolFile, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))
    expect(spooled).toHaveLength(1)
    expect(spooled[0].surface).toBe('dispatch-worker')
    expect(spooled[0].fault.faultId).toBe(rec.fault.faultId)
    // The spooled copy is scrubbed too — it travels over the network next.
    expect(JSON.stringify(spooled[0])).not.toContain(SECRET_LEVEL)
  }, 90_000)
})
