#!/usr/bin/env node
/**
 * Regenerate tests/fault-pending.json — the shrinking set of route files not
 * yet wrapped in withFault (ERROR_REPORTING_2026-08-24.md §3 Layer 3).
 *
 * POLARITY MATTERS: a hand-maintained allowlist silently passes for a newly
 * added unwrapped route. This generated set plus the runtime brand test
 * (tests/route-fault-coverage.test.ts) closes that: a route in NEITHER set
 * fails CI, so a new unwrapped route cannot be added, and a wrapped route
 * still listed here fails too, so the set can only shrink honestly.
 *
 * The generator's heuristic (does the file mention withFault?) is a
 * convenience for regeneration; the runtime FAULT_WRAPPED brand check in the
 * test is the actual enforcement.
 *
 * Run from hub/:  node scripts/gen-fault-pending.mjs
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const API_ROOT = join(process.cwd(), 'app', 'api')

function routeFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...routeFiles(p))
    else if (entry.name === 'route.ts') out.push(p)
  }
  return out
}

const exemptions = JSON.parse(
  readFileSync(join(process.cwd(), 'tests', 'fault-exemptions.json'), 'utf8'),
)

const pending = routeFiles(API_ROOT)
  .filter((p) => !readFileSync(p, 'utf8').includes('withFault('))
  .map((p) => relative(process.cwd(), p))
  .filter((p) => !(p in exemptions))
  .sort()

const outPath = join(process.cwd(), 'tests', 'fault-pending.json')
writeFileSync(outPath, `${JSON.stringify(pending, null, 2)}\n`)
console.log(`[gen-fault-pending] ${pending.length} route files pending withFault → ${relative(process.cwd(), outPath)}`)
