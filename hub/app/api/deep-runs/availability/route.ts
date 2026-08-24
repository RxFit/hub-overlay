import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { canAccessStaffRoute } from '@/lib/roles'
import { isMissingTableError, workerFresh } from '@/lib/dispatch-store'
import { dispatchFreshMs, isDispatchConfigured, isDispatchEnabled } from '@/lib/agy-dispatch'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/deep-runs/availability — the deep engine's honest availability
 * (DEEP_LANE_2026-08-23.md §6.3, PR D).
 *
 * Drives the featured chips and the popover tier: a featured tool that
 * silently queued into a dead worker would burn trust in exactly the surface
 * being promoted, so the chips reflect the engine. Cheap by construction —
 * the same ~5 ms indexed worker-liveness read the chat lane's rung-1 gate
 * uses; polled by the client on a slow clock.
 *
 * Never 500s into the UI: any read failure reports available:false with a
 * reason — offline-by-error and offline-by-fact render the same honest way.
 */
export async function GET() {
  const session = await getServerSession(authOptions)
  const user = session?.user as { email?: string | null; role?: string | null } | undefined
  if (!user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!canAccessStaffRoute(user.role)) {
    return NextResponse.json({ error: 'Forbidden — staff access required' }, { status: 403 })
  }

  const enabled = isDispatchEnabled() && isDispatchConfigured()
  if (!enabled) {
    return NextResponse.json({ available: false, reason: 'dispatch_disabled', workerFresh: false })
  }
  try {
    const fresh = await workerFresh(dispatchFreshMs())
    return NextResponse.json({
      available: fresh,
      reason: fresh ? null : 'no_worker',
      workerFresh: fresh,
    })
  } catch (err) {
    if (!isMissingTableError(err)) {
      console.warn('[deep-availability]', err instanceof Error ? err.message : err)
    }
    return NextResponse.json({ available: false, reason: 'no_worker', workerFresh: false })
  }
}
