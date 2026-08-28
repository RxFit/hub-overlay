#!/usr/bin/env node
/**
 * Build gate: fail the build unless BOTH halves of the instrumentation hook
 * are present (ERROR_REPORTING_2026-08-24.md §3 Layer 8).
 *
 * WHY BOTH: on Next 14.2.x, `instrumentation.ts` only loads when
 * `experimental.instrumentationHook: true` is set. With the file but no flag,
 * Next parses the file and never imports it — no warning, no error, and every
 * process-level handler inside silently no-ops. With the flag but no file,
 * there is nothing to run. Either half alone looks done and captures nothing,
 * which makes this the most expensive silent-failure trap in the plan: the
 * subsystem that would tell you it is broken is the broken subsystem.
 *
 * Nothing else can catch this. A unit test can import the module and assert
 * it registers handlers, but cannot prove Next actually loaded it in a real
 * server; `next dev` and `next build` both stay silent either way.
 *
 * Runs as part of `npm run build` (locally, in CI, and in the Docker image).
 */
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const hubRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const failures = []

// ── half 1: the file, at the project root (never inside app/) ──────────────
const instrumentationPath = join(hubRoot, 'instrumentation.ts')
if (!existsSync(instrumentationPath)) {
  failures.push(
    `Missing ${instrumentationPath}. The instrumentation hook must live at the hub/ project root — a file under app/ is never loaded.`,
  )
} else {
  const src = readFileSync(instrumentationPath, 'utf8')
  if (!/export\s+(async\s+)?function\s+register\b/.test(src)) {
    failures.push('instrumentation.ts does not export a `register` function — Next has nothing to call.')
  }
  if (!/NEXT_RUNTIME/.test(src)) {
    failures.push(
      'instrumentation.ts does not gate on process.env.NEXT_RUNTIME — Node-only imports (node:fs, pino) break the Edge bundle.',
    )
  }
  // The nested-if form is load-bearing, not style. Next replaces
  // process.env.NEXT_RUNTIME with a literal per bundle, so only a nested
  // `if (… === 'nodejs') { await import(…) }` gets dead-code-eliminated from
  // the Edge bundle. An early-return guard leaves the dynamic import
  // reachable, webpack traces it into the Edge build, and the failure surfaces
  // as `Module not found: Can't resolve 'crypto'` several modules away. Catch
  // it here where the message can name the actual cause.
  if (/NEXT_RUNTIME\s*!==/.test(src)) {
    failures.push(
      "instrumentation.ts guards the runtime with an early return (`NEXT_RUNTIME !== 'nodejs'`). Use the nested form `if (process.env.NEXT_RUNTIME === 'nodejs') { await import(...) }` — only that shape is dead-code-eliminated from the Edge bundle; the early return breaks the Edge build with a confusing 'Can't resolve crypto'.",
    )
  }
  if (/export\s+(async\s+)?function\s+onRequestError\b/.test(src)) {
    failures.push(
      'instrumentation.ts exports onRequestError, which landed in Next 15.0.0. On 14.2.x it never fires and reads as done — delete it.',
    )
  }
}

// ── half 2: the flag ───────────────────────────────────────────────────────
// EVALUATE the config rather than pattern-matching its text. A regex over the
// source is fooled by the most likely way this ever gets disabled — someone
// commenting the line out — and `// instrumentationHook: true` would still
// match, so the gate would report success while Next silently never loads
// instrumentation.ts. That is the exact failure this script exists to prevent,
// so the check has to read the value Next will actually receive.
const configPath = join(hubRoot, 'next.config.js')
try {
  const require = createRequire(import.meta.url)
  // Evaluating is safe here: next.config.js is a plain object literal export;
  // its headers() is a function definition, never invoked by this read.
  const config = require(configPath)
  const resolved = typeof config === 'function' ? config('phase-production-build', {}) : config
  if (resolved?.experimental?.instrumentationHook !== true) {
    failures.push(
      'next.config.js does not set `experimental.instrumentationHook: true` (evaluated value: ' +
        JSON.stringify(resolved?.experimental?.instrumentationHook) +
        '). On 14.2.x, instrumentation.ts is then parsed and NEVER imported — silently, with every handler inside dead.',
    )
  }
} catch (err) {
  failures.push(`Cannot evaluate ${configPath} to verify the flag (${err.message})`)
}

if (failures.length > 0) {
  console.error(
    '[assert-instrumentation] FAIL — process-level fault capture is not actually wired:\n' +
      failures.map((f) => `  - ${f}`).join('\n') +
      '\n\nBoth the file and the flag are required; either alone is a silent no-op.',
  )
  process.exit(1)
}

console.log('[assert-instrumentation] OK — instrumentation.ts present and instrumentationHook enabled.')
