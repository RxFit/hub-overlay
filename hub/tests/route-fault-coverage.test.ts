import { describe, it, expect } from 'vitest'
import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { isFaultWrapped } from '@/lib/route-fault'
import pendingList from './fault-pending.json'
import exemptionsJson from './fault-exemptions.json'

/* ════════════════════════════════════════════════════════════════════════════
   Route wrapper coverage (ERROR_REPORTING_2026-08-24.md §3 Layer 3) — the
   enforcement that CANNOT be forgotten by a future contributor.

   Every exported HTTP verb in every app/api route.ts must either carry the
   runtime FAULT_WRAPPED brand (a brand survives re-exports; grepping for
   `withFault` passes on a commented-out import) or appear in the GENERATED
   tests/fault-pending.json. A route in NEITHER set fails — so a new
   unwrapped route cannot be added. A wrapped route still listed as pending
   ALSO fails — so the set can only shrink. Regenerate with:

       node scripts/gen-fault-pending.mjs

   PERMANENT_EXEMPTIONS holds the handlers that can never take the wrapper,
   each with the reason a reviewer needs. "Zero pending" at the end of the
   Phase 2 sweep means zero UNEXPLAINED — never an empty exemption list.
   ════════════════════════════════════════════════════════════════════════════ */

/** Handlers that structurally cannot be wrapped, with the reason — shared
 *  with scripts/gen-fault-pending.mjs so a route has exactly one
 *  classification. */
const PERMANENT_EXEMPTIONS: ReadonlyMap<string, string> = new Map(
  Object.entries(exemptionsJson as Record<string, string>),
)

const HTTP_VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const

const hubRoot = join(__dirname, '..')
const apiRoot = join(hubRoot, 'app', 'api')

function routeFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...routeFiles(p))
    else if (entry.name === 'route.ts') out.push(p)
  }
  return out
}

const pending = new Set<string>(pendingList as string[])

describe('withFault coverage — every route is branded, pending, or exempt', () => {
  const files = routeFiles(apiRoot)

  it('finds the route surface (sanity: the glob is not silently empty)', () => {
    expect(files.length).toBeGreaterThan(70)
  })

  for (const abs of files) {
    const rel = relative(hubRoot, abs)
    if (PERMANENT_EXEMPTIONS.has(rel)) continue

    it(rel, async () => {
      const mod: Record<string, unknown> = await import(abs)
      const verbs = HTTP_VERBS.filter((v) => typeof mod[v] === 'function')
      expect(verbs.length).toBeGreaterThan(0)

      const unbranded = verbs.filter((v) => !isFaultWrapped(mod[v]))

      if (pending.has(rel)) {
        // Still pending: it must genuinely be unwrapped. A wrapped route
        // lingering in the pending set hides regressions — regenerate.
        expect(
          unbranded.length,
          `${rel} is fully wrapped but still listed in tests/fault-pending.json — run: node scripts/gen-fault-pending.mjs`,
        ).toBeGreaterThan(0)
      } else {
        // Not pending and not exempt: every exported verb must be branded.
        expect(
          unbranded,
          `${rel} exports unwrapped handler(s) [${unbranded.join(', ')}] and is not in tests/fault-pending.json — wrap with withFault() or run: node scripts/gen-fault-pending.mjs`,
        ).toEqual([])
      }
    })
  }

  it('the pending set carries no stale entries for deleted routes', () => {
    const live = new Set(files.map((f) => relative(hubRoot, f)))
    const stale = [...pending].filter((p) => !live.has(p))
    expect(stale, `stale pending entries: ${stale.join(', ')} — run: node scripts/gen-fault-pending.mjs`).toEqual([])
  })

  it('exemptions never overlap the pending set (one classification per route)', () => {
    const overlap = [...PERMANENT_EXEMPTIONS.keys()].filter((k) => pending.has(k))
    expect(overlap).toEqual([])
  })
})
