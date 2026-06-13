import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { createLogger } from '@/lib/logger'
import { getPaperclipAuthHeaders, clearPaperclipSession } from '@/lib/paperclipSession'
import { PAPERCLIP_BASE_URL } from '@/lib/paperclipConfig'
import { loopDetector } from '@/lib/loop-detector'
import { breaker } from '@/lib/circuit-breaker'
import { withRetry } from '@/lib/retry'
import { getTenantId } from '@/lib/tenant-context'
import crypto from 'crypto'

const log = createLogger('paperclip/proxy')

const PAPERCLIP_BASE = PAPERCLIP_BASE_URL

// Allowed API path prefixes for the proxy — covers full Paperclip surface
const ALLOWED_PREFIXES = [
  '/api/companies',         // list + detail + create + nested resources
  '/api/health',            // health check
  '/api/issues',            // direct issue operations (PATCH, GET by ID)
  '/api/agents',            // agent status + management
  '/api/runs',              // agent run history
  '/api/projects',          // project lookups by ID or shortname
]

export async function GET(
  req: NextRequest,
  { params }: { params: { path: string[] } }
) {
  return proxyRequest(req, params.path, 'GET')
}

export async function POST(
  req: NextRequest,
  { params }: { params: { path: string[] } }
) {
  return proxyRequest(req, params.path, 'POST')
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { path: string[] } }
) {
  return proxyRequest(req, params.path, 'PATCH')
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { path: string[] } }
) {
  return proxyRequest(req, params.path, 'DELETE')
}

async function proxyRequest(
  req: NextRequest,
  pathSegments: string[],
  method: string
) {
  // Auth check
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Normalize: clients historically call both /api/paperclip/companies/...
  // and /api/paperclip/api/companies/... — strip a leading 'api' segment so
  // we never build a double-prefixed upstream path like /api/api/companies.
  const segments = pathSegments[0] === 'api' ? pathSegments.slice(1) : pathSegments
  const apiPath = '/api/' + segments.join('/')

  // Validate path is allowed (boundary-safe: exact match or '/' follows)
  const isAllowed = ALLOWED_PREFIXES.some(
    prefix => apiPath === prefix || apiPath.startsWith(prefix + '/') || apiPath.startsWith(prefix + '?')
  )
  if (!isAllowed) {
    return NextResponse.json({ error: 'Forbidden path' }, { status: 403 })
  }

  // Project-scoped access control
  const user = session.user as Record<string, unknown>
  const role = user.role as string
  const assignedProjects = (user.assignedProjects as string[]) ?? []

  // If the request targets a specific company, check access
  const companyMatch = apiPath.match(/\/api\/companies\/([a-f0-9-]+)/)
  if (companyMatch) {
    const requestedCompanyId = companyMatch[1]
    if (
      role !== 'superadmin' &&
      !assignedProjects.includes('*') &&
      !assignedProjects.includes(requestedCompanyId)
    ) {
      return NextResponse.json(
        { error: 'Access denied: not assigned to this project' },
        { status: 403 }
      )
    }
  }

  // Block direct lists for scoped users
  if (role !== 'superadmin' && !assignedProjects.includes('*')) {
    if (
      apiPath === '/api/issues' ||
      apiPath === '/api/agents' ||
      apiPath === '/api/projects' ||
      apiPath === '/api/runs' ||
      apiPath.startsWith('/api/issues?') ||
      apiPath.startsWith('/api/agents?') ||
      apiPath.startsWith('/api/projects?') ||
      apiPath.startsWith('/api/runs?')
    ) {
      const isPost = method.toUpperCase() === 'POST'
      const hasCompanyQuery = req.nextUrl.searchParams.has('companyId')
      if (!(isPost && (apiPath === '/api/issues' || apiPath.startsWith('/api/issues?'))) && !(apiPath.startsWith('/api/runs') && hasCompanyQuery)) {
        return NextResponse.json(
          { error: 'Access denied: direct resource listing is restricted' },
          { status: 403 }
        )
      }

      if (apiPath.startsWith('/api/runs') && hasCompanyQuery) {
        const qCompanyId = req.nextUrl.searchParams.get('companyId')
        if (qCompanyId && !assignedProjects.includes(qCompanyId)) {
          return NextResponse.json(
            { error: 'Access denied: not assigned to this project' },
            { status: 403 }
          )
        }
      }
    }
  }

  // Pre-check for specific resources (issues/agents/projects) on mutation (PATCH/DELETE)
  const issueMatch = apiPath.match(/\/api\/issues\/([a-f0-9-]+)/)
  const agentMatch = apiPath.match(/\/api\/agents\/([a-f0-9-]+)/)
  const projectMatch = apiPath.match(/\/api\/projects\/([a-f0-9-]+)/)

  const needPreCheck = method !== 'GET' && method !== 'HEAD' && (issueMatch || agentMatch || projectMatch)

  if (role !== 'superadmin' && !assignedProjects.includes('*') && needPreCheck) {
    let checkPath = ''
    if (issueMatch) checkPath = `/api/issues/${issueMatch[1]}`
    else if (agentMatch) checkPath = `/api/agents/${agentMatch[1]}`
    else if (projectMatch) checkPath = `/api/projects/${projectMatch[1]}`

    try {
      const checkUrl = `${PAPERCLIP_BASE}${checkPath}`
      const checkRes = await fetch(checkUrl, await buildFetchOpts())
      if (!checkRes.ok) {
        return NextResponse.json(
          { error: 'Access denied: resource not found or inaccessible' },
          { status: 403 }
        )
      }
      const checkData = await checkRes.json()
      const companyId = checkData.companyId || checkData.issue?.companyId || checkData.agent?.companyId || checkData.project?.companyId
      if (!companyId || !assignedProjects.includes(companyId)) {
        return NextResponse.json(
          { error: 'Access denied: not assigned to this project' },
          { status: 403 }
        )
      }
    } catch (err) {
      log.error({ err, checkPath }, 'Scope-check pre-verification failed')
      return NextResponse.json(
        { error: 'Access denied: verification failed' },
        { status: 403 }
      )
    }
  }

  // Forward request to Paperclip with session auth — preserve the query
  // string (e.g. ?limit=50&status=in_progress), which lives on req.nextUrl,
  // not in the catch-all path segments.
  const url = `${PAPERCLIP_BASE}${apiPath}${req.nextUrl.search}`

  // Read body once (for POST/PUT/PATCH) — we may need to retry
  let requestBody: string | undefined
  if (method !== 'GET' && method !== 'HEAD') {
    try {
      const body = await req.text()
      if (body) requestBody = body
    } catch {
      // No body — that's fine
    }
  }

  // 1. Loop detection: Throw error and block sequential redundant writes
  if (requestBody && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase())) {
    try {
      loopDetector.detectAndRecord(method, apiPath, requestBody, session.user.email ?? '__global__')
    } catch (err) {
      log.error({ err, path: apiPath, method }, 'Loop detected in proxy')
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Write loop detected' },
        { status: 400 }
      )
    }
  }

  /** Build fetch options with current auth headers */
  async function buildFetchOpts(): Promise<RequestInit> {
    let authHeaders: Record<string, string>
    try {
      authHeaders = await getPaperclipAuthHeaders()
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : 'Paperclip auth failed')
    }

    const headers = new Headers({
      'Content-Type': 'application/json',
      Origin: PAPERCLIP_BASE,
      ...authHeaders,
    })

    // 2. Idempotency headers: Attach unique key for writes to prevent duplicate execution on retry
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase())) {
      if (!headers.has('Idempotency-Key')) {
        headers.set('Idempotency-Key', crypto.randomUUID())
      }
    }

    const opts: RequestInit = {
      method,
      headers: Object.fromEntries(headers.entries()),
      signal: AbortSignal.timeout(10_000),
    }
    if (requestBody) opts.body = requestBody
    return opts
  }

  try {
    const execute = async () => {
      let upstream = await fetch(url, await buildFetchOpts())

      // Auto-retry on 401: clear session, re-authenticate, retry once
      if (upstream.status === 401) {
        log.warn({ path: apiPath }, 'Upstream 401, re-authenticating')
        clearPaperclipSession()
        upstream = await fetch(url, await buildFetchOpts())
      }

      // Throw retryable errors so withRetry triggers
      if (upstream.status >= 500 && upstream.status <= 504) {
        throw new Error(`Paperclip proxy error status ${upstream.status}`)
      }

      return upstream
    }

    // 3. Circuit breaker & Retry wrapper
    const tenantId = getTenantId()
    const upstream = await breaker.execute(`${tenantId}:paperclip-api`, () => withRetry(execute))
    const data = await upstream.text()

    // If the user is staff (not admin) and this is a companies list,
    // filter to only their assigned projects
    if (apiPath === '/api/companies' && role !== 'superadmin' && !assignedProjects.includes('*')) {
      try {
        const parsed = JSON.parse(data)
        // Handle both array and wrapped responses
        const companies = Array.isArray(parsed) ? parsed : parsed.companies
        if (companies && Array.isArray(companies)) {
          const filtered = companies.filter(
            (c: { id: string }) => assignedProjects.includes(c.id)
          )
          const result = Array.isArray(parsed) ? filtered : { ...parsed, companies: filtered }
          return NextResponse.json(result, { status: upstream.status })
        }
      } catch {
        // Not JSON or parse error — return as-is
      }
    }

    // Post-check for GET requests
    if (role !== 'superadmin' && !assignedProjects.includes('*') && method === 'GET') {
      if (issueMatch || agentMatch || projectMatch) {
        try {
          const parsed = JSON.parse(data)
          const companyId = parsed.companyId || parsed.issue?.companyId || parsed.agent?.companyId || parsed.project?.companyId
          if (!companyId || !assignedProjects.includes(companyId)) {
            return NextResponse.json(
              { error: 'Access denied: not assigned to this project' },
              { status: 403 }
            )
          }
        } catch {
          return NextResponse.json(
            { error: 'Access denied: resource cannot be verified' },
            { status: 403 }
          )
        }
      }
    }

    return new Response(data, {
      status: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('Content-Type') || 'application/json' },
    })
  } catch (err) {
    log.error({ err, path: apiPath, method }, 'Proxy request failed')
    const message = err instanceof Error ? err.message : 'Paperclip API unreachable'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
