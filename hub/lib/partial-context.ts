import { AsyncLocalStorage } from 'node:async_hooks'
import { setPartialMarker } from '@/lib/swallow'

/**
 * The request-scoped "partial" flag behind `emptyOn` (ERROR_REPORTING
 * 2026-08-24.md §3 Layer 9 #2) — the server half of lib/swallow.ts.
 *
 * SERVER-ONLY, by construction: this is the one place node:async_hooks may
 * appear in the swallow story. lib/swallow.ts must stay isomorphic for its 42
 * client call sites, so it exposes an injectable marker instead of importing
 * this module; we register ourselves on import (the last line of this file),
 * and lib/route-fault.ts — already server-only via pino — is what imports us.
 * Import this module from client code and the bundle breaks, which is the
 * intended failure: loud at build time, not silent at runtime.
 *
 * WHY AsyncLocalStorage and not a parameter: the 22 emptyOn sites sit inside
 * library functions several frames below the route handler, and threading a
 * "partial" bag through every signature is exactly the plumbing that makes
 * people fall back to `.catch(() => [])`. ALS gives the handler's whole async
 * subtree one flag with zero signature changes — the same reason Next uses it
 * for headers()/cookies().
 *
 * Scoping rules:
 *  - The flag lives only inside `runWithPartialFlag`. Outside a scope (a cron
 *    tick, a worker, module init) `markPartial` is a no-op and `isPartial` is
 *    false — an emptyOn there still counts, it just has no response to mark.
 *  - Two concurrent requests never see each other's flag: each `run` gets a
 *    fresh store, and ALS propagates it through awaits/promises per request.
 *  - Read `isPartial()` INSIDE the scope. After `await runWithPartialFlag(…)`
 *    resolves, the caller's continuation is back in the outer context, where
 *    the store is gone — withFault captures the flag before returning.
 */

interface PartialStore {
  partial: boolean
}

const partialFlag = new AsyncLocalStorage<PartialStore>()

/** Run `fn` with a fresh, request-scoped partial flag. Returns whatever `fn`
 *  returns (a promise for an async fn); throws propagate unchanged. */
export function runWithPartialFlag<T>(fn: () => T): T {
  return partialFlag.run({ partial: false }, fn)
}

/** True when an emptyOn() ran inside the CURRENT scope. False outside any. */
export function isPartial(): boolean {
  return partialFlag.getStore()?.partial === true
}

/** The marker registered with lib/swallow.ts. Exported so a test that reset
 *  swallow state can re-register it; production never calls it directly. */
export function markPartial(): void {
  const store = partialFlag.getStore()
  if (store) store.partial = true
}

setPartialMarker(markPartial)
