import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { dismissItem, undismissItem, isItemKey } from '@/lib/queue-dismissals'
import { getTenantId } from '@/lib/tenant-context'
import { withFault } from '@/lib/route-fault'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/execution/queue/dismiss { key, undo? } — hide (or un-hide) one
 * needs-you card for the caller (Phase 4 PR 2).
 *
 * A dismissal is a per-user overlay (lib/queue-dismissals.ts): the ledger
 * row behind the card is never touched, and nobody else's queue changes.
 * The key is validated against the closed key grammar so the table can
 * never hold free text. Idempotent both ways.
 */
export const POST = withFault('execution/queue/dismiss', async (req: NextRequest) => {
  const session = await getServerSession(authOptions)
  const user = session?.user as { email?: string | null } | undefined
  if (!user?.email) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  let body: { key?: unknown; undo?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  if (!isItemKey(body.key)) {
    return NextResponse.json({ error: 'key must look like run:<id>, action:<id>, deep:<id> or alert:<id>' }, { status: 400 })
  }
  const tenantId = getTenantId()
  if (body.undo === true) {
    await undismissItem(tenantId, user.email, body.key)
    return NextResponse.json({ ok: true, key: body.key, dismissed: false })
  }
  await dismissItem(tenantId, user.email, body.key)
  return NextResponse.json({ ok: true, key: body.key, dismissed: true })
})
