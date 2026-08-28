/**
 * Next.js instrumentation hook (ERROR_REPORTING_2026-08-24.md §3 Layer 8).
 *
 * MUST live at the project root (hub/), never inside app/, and REQUIRES
 * `experimental.instrumentationHook: true` in next.config.js on 14.2.x —
 * without the flag this file is parsed and never imported, with no warning
 * and no error, so every handler inside silently no-ops. That is the single
 * most expensive silent-failure trap in the plan, which is why
 * scripts/assert-instrumentation.mjs asserts BOTH and runs in the build.
 *
 * Deliberately NO `onRequestError` export: that hook landed in Next 15.0.0,
 * so on 14.2.35 it would never fire while reading as done.
 */
export async function register() {
  // The guard MUST be a nested `if (… === 'nodejs')` block, never an early
  // return. Next compiles this file for BOTH runtimes and replaces
  // process.env.NEXT_RUNTIME with a literal per bundle, so in the Edge bundle
  // this becomes `if ('edge' === 'nodejs')` and webpack eliminates the whole
  // block — dynamic import included. Written as `if (… !== 'nodejs') return`,
  // the import sits in the function body where dead-code elimination cannot
  // reach it, webpack still traces it into the Edge bundle, and the build
  // fails with `Module not found: Can't resolve 'crypto'` through the whole
  // fault → logger → observability chain. The two forms read as equivalent
  // and are not.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { installProcessFaultHandlers } = await import('@/lib/fault-process')
    installProcessFaultHandlers({ surface: 'next-server' })
  }
}
