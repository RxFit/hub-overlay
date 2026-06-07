import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { searchSemanticBrain } from '@/lib/vertex'
import { createLogger } from '@/lib/logger'

const log = createLogger('admin-vertex-status')

export const runtime = 'nodejs'

/**
 * GET /api/admin/vertex-status
 *
 * Returns the Vertex AI engine configuration and health status for the
 * current tenant. Admin-only endpoint.
 */
export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const chatUser = session.user as Record<string, unknown>
  const role = chatUser.role as string
  if (role !== 'admin' && role !== 'superadmin') {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  try {
    const tenantId = process.env.NEXT_PUBLIC_TENANT_ID || 'rxfit'

    // Load tenant config from DB
    const { db } = await import('@/lib/db')
    const { tenants } = await import('@/lib/schema')
    const { eq } = await import('drizzle-orm')

    const rows = await db.select({
      id: tenants.id,
      name: tenants.name,
      vertexEngineId: tenants.vertexEngineId,
      vertexGcpProject: tenants.vertexGcpProject,
      workspaceDomain: tenants.workspaceDomain,
      vertexStatus: tenants.vertexStatus,
    }).from(tenants).where(eq(tenants.id, tenantId)).limit(1)

    const tenant = rows[0]
    if (!tenant) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 404 })
    }

    // Health check: fire a test query
    let healthStatus: 'healthy' | 'degraded' | 'unavailable' = 'unavailable'
    let healthDetails = ''

    if (tenant.vertexEngineId && tenant.vertexStatus === 'active') {
      try {
        const results = await searchSemanticBrain('health check test query', tenantId)
        if (results !== null) {
          healthStatus = 'healthy'
          healthDetails = `Engine responding — ${results.length} results for test query`
        } else {
          healthStatus = 'degraded'
          healthDetails = 'Engine returned null — may be misconfigured or SA key missing'
        }
      } catch (err) {
        healthStatus = 'unavailable'
        healthDetails = `Health check failed: ${err instanceof Error ? err.message : 'Unknown error'}`
        log.warn({ err }, 'Vertex AI health check failed')
      }
    } else {
      healthDetails = tenant.vertexEngineId
        ? `Engine configured but status is "${tenant.vertexStatus}"`
        : 'No engine configured for this tenant'
    }

    return NextResponse.json({
      tenant: {
        id: tenant.id,
        name: tenant.name,
      },
      vertex: {
        engineId: tenant.vertexEngineId ?? null,
        gcpProject: tenant.vertexGcpProject ?? null,
        workspaceDomain: tenant.workspaceDomain ?? null,
        status: tenant.vertexStatus ?? 'pending',
        health: healthStatus,
        healthDetails,
      },
    })
  } catch (err) {
    log.error({ err }, 'Failed to fetch Vertex AI status')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
