import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

/* ════════════════════════════════════════════════════════════════════════════
   No 2xx response may carry a failure body (ERROR_REPORTING_2026-08-24.md §3
   Layer 3 step 4, and the Phase 2 "no-200-errors build guard").

   WHY A SOURCE SCAN AND NOT JUST THE RUNTIME CHECK. withFault already inspects
   2xx bodies via detectErrorIn2xx — but that check bails when the response has
   no content-length, and NOTHING in this repo sets one: neither
   NextResponse.json(...) nor new Response(string) populates the header before
   serialization (measured, not assumed). So the runtime check is inert on every
   response shape we actually produce, exactly as lib/route-fault.ts's module
   header says. This scan is what covers the gap today.

   WHAT IT CANNOT SEE, stated so nobody mistakes a green run for proof:
     - keys that arrive through a spread. app/api/admin/work-probe builds
       `base = { …, error: job.error }` and returns `{ ...base }` at 200; the
       literal never contains `error:`, so this scan reads that file as clean.
       That route carries `inspect2xx: false` with a why-comment instead.
     - a body assembled in a variable before the call.
     - a non-literal status (`{ status: gate.status }`, `upstream.status`),
       which is skipped because the value is not knowable statically.
   Between the two mechanisms the coverage is real but partial, and neither is
   complete alone.

   POLARITY, as everywhere else in this arc: INTENTIONAL is an explicit map with
   a reason per entry, and an entry that no longer violates FAILS — so the set
   can only shrink, and a new 2xx-with-error cannot be added silently.
   ════════════════════════════════════════════════════════════════════════════ */

/** Routes whose 2xx-with-failure-body is the deliberate protocol. */
const INTENTIONAL: ReadonlyMap<string, string> = new Map([
  [
    'app/api/deep-runs/availability/route.ts',
    '200 + `reason` IS the contract: "no worker, and here is why" is a successful ' +
      'answer. The route never 500s into the UI by design; a fault response would ' +
      'make the panel show an error for a healthy system. Carries inspect2xx: false.',
  ],
  [
    'app/api/orgs/[orgId]/founder-lens/route.ts',
    '207 Multi-Status with `{ error, details }` is precisely what 207 means — ' +
      'some role updates succeeded and some did not, and the caller needs both.',
  ],
])

const FAILURE_KEY = /\berror\s*:|\breason\s*:|\bok\s*:\s*false|\bsuccess\s*:\s*false/
const LITERAL_ERROR_STATUS = /\bstatus:\s*[45]\d\d/
const NON_LITERAL_STATUS = /\bstatus:\s*[A-Za-z_$][\w$]*(?:\.[\w$]+)*\s*[,}]?/

/* The status regexes are applied ONLY to the response-init argument, never to
 * the whole call. `NextResponse.json({ status: 500, error: 'failed' })` is a
 * body with a `status` FIELD and no init — it returns HTTP 200 — and matching
 * `status: 500` anywhere in the call text read that as a genuine 500 and
 * skipped it. That is the exact regression this file exists to catch, so the
 * guard was blind to its own headline case (verified: the suite passed 79/79
 * with that literal injected into a route). Splitting the arguments is what
 * fixes it, which is why jsonCalls returns them separately. */

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

interface JsonCall {
  /** First argument — the response BODY. */
  body: string
  /** Second argument — the response INIT, where a real HTTP status lives. */
  init: string
}

/**
 * Extract each `NextResponse.json(...)` call, split into its top-level
 * arguments. Quotes and template literals are tracked so a brace or comma
 * inside a string cannot throw off the depth count or the argument split.
 */
function jsonCalls(src: string): JsonCall[] {
  const out: JsonCall[] = []
  for (const m of src.matchAll(/NextResponse\.json\(/g)) {
    const start = m.index! + m[0].length
    let i = start
    let depth = 1
    let quote: string | null = null
    const commas: number[] = []
    while (i < src.length && depth > 0) {
      const c = src[i]
      if (quote) {
        if (c === '\\') i++
        else if (c === quote) quote = null
      } else if (c === "'" || c === '"' || c === '`') {
        quote = c
      } else if (c === '(' || c === '[' || c === '{') {
        depth++
      } else if (c === ')' || c === ']' || c === '}') {
        depth--
      } else if (c === ',' && depth === 1) {
        commas.push(i)
      }
      i++
    }
    const whole = src.slice(start, i - 1)
    const cut = commas.length > 0 ? commas[0] - start : whole.length
    out.push({ body: whole.slice(0, cut), init: whole.slice(cut + 1) })
  }
  return out
}

function violations(src: string): string[] {
  return jsonCalls(src)
    .filter(
      ({ body, init }) =>
        // Only the INIT can carry a real HTTP status. A `status` field in the
        // body is payload, not the response code.
        !LITERAL_ERROR_STATUS.test(init) &&
        !NON_LITERAL_STATUS.test(init) &&
        FAILURE_KEY.test(body),
    )
    .map(({ body }) => body)
}

describe('no 2xx response carries a failure body', () => {
  const files = routeFiles(apiRoot)

  it('finds the route surface (sanity: the glob is not silently empty)', () => {
    expect(files.length).toBeGreaterThan(70)
  })

  for (const abs of files) {
    const rel = relative(hubRoot, abs).split('\\').join('/')
    it(rel, () => {
      const found = violations(readFileSync(abs, 'utf8'))
      if (INTENTIONAL.has(rel)) {
        // An allowlisted route that stopped violating must leave the list —
        // otherwise the reason rots and the set never shrinks.
        expect(
          found.length,
          `${rel} no longer returns a 2xx failure body — delete its INTENTIONAL entry in tests/no-200-errors.test.ts`,
        ).toBeGreaterThan(0)
        return
      }
      expect(
        found.map((f) => f.replace(/\s+/g, ' ').trim().slice(0, 120)),
        `${rel} returns a 2xx whose body carries error/reason/ok:false/success:false. ` +
          'A 2xx that means failure is the silent-failure class this arc exists to remove: ' +
          'give it a real status code, or — if the 2xx genuinely IS the protocol — add it to ' +
          'INTENTIONAL in tests/no-200-errors.test.ts with the reason.',
      ).toEqual([])
    })
  }

  it('the intentional list carries no entries for deleted routes', () => {
    const live = new Set(files.map((f) => relative(hubRoot, f).split('\\').join('/')))
    const stale = [...INTENTIONAL.keys()].filter((k) => !live.has(k))
    expect(stale, `stale INTENTIONAL entries: ${stale.join(', ')}`).toEqual([])
  })
})
