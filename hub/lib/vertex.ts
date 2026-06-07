/**
 * Vertex AI Search client for the Semantic Brain.
 *
 * Queries the Vertex AI Search engine to retrieve semantically relevant
 * content from indexed data stores (Google Drive, Gmail, Chat, etc.).
 *
 * Architecture:
 * - Each tenant gets their own Discovery Engine instance (full isolation)
 * - Engine config is stored in the `tenants` table
 * - Auth is handled by the consolidated google-auth.ts module
 *
 * Project: semantic-brain-desktop (default)
 */

import { getServiceAccountAccessToken } from '@/lib/google-auth'
import { createLogger } from '@/lib/logger'

const log = createLogger('vertex')

// Fallback defaults (used when tenant config is not yet in DB)
const DEFAULT_GCP_PROJECT = process.env.VERTEX_GCP_PROJECT ?? 'semantic-brain-desktop'
const DEFAULT_ENGINE_ID = process.env.VERTEX_ENGINE_ID ?? 'semanticbrain_1779229063037'

export interface VertexSearchResult {
  title: string
  snippet: string
  uri?: string
  source?: string
}

/* ── Per-Tenant Engine Config Cache ── */

interface TenantVertexConfig {
  engineId: string
  gcpProject: string
  fetchedAt: number
}

const CONFIG_CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes
const tenantConfigCache = new Map<string, TenantVertexConfig | null>()

/**
 * Look up a tenant's Vertex AI engine configuration from the database.
 * Results are cached for 5 minutes to avoid DB hits on every chat message.
 *
 * Falls back to env var defaults if the tenant has no config in the DB.
 */
async function getTenantVertexConfig(tenantId: string): Promise<{ engineId: string; gcpProject: string } | null> {
  const cached = tenantConfigCache.get(tenantId)
  if (cached !== undefined && Date.now() - cached!.fetchedAt < CONFIG_CACHE_TTL_MS) {
    if (cached === null) return null
    return { engineId: cached.engineId, gcpProject: cached.gcpProject }
  }

  try {
    const { db } = await import('@/lib/db')
    const { tenants } = await import('@/lib/schema')
    const { eq } = await import('drizzle-orm')

    const rows = await db.select({
      vertexEngineId: tenants.vertexEngineId,
      vertexGcpProject: tenants.vertexGcpProject,
      vertexStatus: tenants.vertexStatus,
    }).from(tenants).where(eq(tenants.id, tenantId)).limit(1)

    const tenant = rows[0]

    if (!tenant?.vertexEngineId || tenant.vertexStatus !== 'active') {
      // Tenant has no Vertex config or is disabled — try env var fallback
      if (DEFAULT_ENGINE_ID) {
        log.info({ tenantId }, 'Tenant has no Vertex config — using env var defaults')
        const fallback = { engineId: DEFAULT_ENGINE_ID, gcpProject: DEFAULT_GCP_PROJECT, fetchedAt: Date.now() }
        tenantConfigCache.set(tenantId, fallback)
        return { engineId: fallback.engineId, gcpProject: fallback.gcpProject }
      }
      tenantConfigCache.set(tenantId, null)
      return null
    }

    const config: TenantVertexConfig = {
      engineId: tenant.vertexEngineId,
      gcpProject: tenant.vertexGcpProject ?? DEFAULT_GCP_PROJECT,
      fetchedAt: Date.now(),
    }
    tenantConfigCache.set(tenantId, config)
    return { engineId: config.engineId, gcpProject: config.gcpProject }
  } catch (err) {
    log.warn({ err, tenantId }, 'Failed to lookup tenant Vertex config — using env var defaults')
    // Fallback to env vars on DB error
    if (DEFAULT_ENGINE_ID) {
      return { engineId: DEFAULT_ENGINE_ID, gcpProject: DEFAULT_GCP_PROJECT }
    }
    return null
  }
}

/* ── Vertex AI Search Query ── */

/**
 * Search the Semantic Brain for relevant content.
 *
 * Uses the tenant's dedicated Discovery Engine instance for full data isolation.
 * Falls back to env var defaults if the tenant has no config in the database.
 *
 * @param query - Natural language search query
 * @param tenantId - Tenant identifier (required — used to look up engine config)
 * @returns Array of search results, or null if Vertex is unavailable
 */
export async function searchSemanticBrain(
  query: string,
  tenantId: string,
): Promise<VertexSearchResult[] | null> {
  const token = await getServiceAccountAccessToken('https://www.googleapis.com/auth/cloud-platform')
  if (!token) {
    log.warn('No service account configured — skipping semantic search')
    return null
  }

  const config = await getTenantVertexConfig(tenantId)
  if (!config) {
    log.info({ tenantId }, 'Tenant has no Vertex AI engine configured — skipping')
    return null
  }

  try {
    const servingConfigPath = `projects/${config.gcpProject}/locations/global/collections/default_collection/engines/${config.engineId}/servingConfigs/default_serving_config`
    const url = `https://discoveryengine.googleapis.com/v1/${servingConfigPath}:search`

    const body: Record<string, unknown> = {
      query,
      pageSize: 5,
      // NOTE: queryExpansionSpec and spellCorrectionSpec are NOT supported
      // on multi-datastore engines (returns 400 INVALID_ARGUMENT)
      contentSearchSpec: {
        snippetSpec: { returnSnippet: true, maxSnippetCount: 3 },
        extractiveContentSpec: {
          maxExtractiveAnswerCount: 2,
          maxExtractiveSegmentCount: 3,
        },
      },
    }

    // No tenant filter needed — each tenant has their own isolated engine

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      log.error({ status: res.status, errBody, tenantId, engineId: config.engineId }, 'Vertex AI search failed')
      return null
    }

    const data = await res.json() as {
      results?: Array<{
        document?: {
          name?: string
          derivedStructData?: {
            title?: string
            link?: string
            snippets?: Array<{ snippet?: string }>
            extractive_answers?: Array<{ content?: string }>
            extractive_segments?: Array<{ content?: string }>
          }
        }
      }>
    }

    if (!data.results?.length) return []

    return data.results.map(r => {
      const doc = r.document?.derivedStructData
      const snippets = doc?.snippets?.map(s => s.snippet).filter(Boolean) ?? []
      const answers = doc?.extractive_answers?.map(a => a.content).filter(Boolean) ?? []
      const segments = doc?.extractive_segments?.map(s => s.content).filter(Boolean) ?? []

      // Prefer extractive answers > segments > snippets
      const bestContent = [...answers, ...segments, ...snippets].join('\n\n')

      return {
        title: doc?.title ?? 'Untitled',
        snippet: bestContent || '[No content extracted]',
        uri: doc?.link,
        source: 'vertex-ai',
      }
    })
  } catch (err) {
    log.error({ err, tenantId }, 'Vertex AI search error')
    return null
  }
}
