import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { createLogger } from '@/lib/logger'
import { getPaperclipAuthHeaders, clearPaperclipSession } from '@/lib/paperclipSession'
import { PAPERCLIP_BASE_URL } from '@/lib/paperclipConfig'
import { loopDetector } from '@/lib/loop-detector'
import { breaker } from '@/lib/circuit-breaker'
import { withRetry } from '@/lib/retry'
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

  const apiPath = '/api/' + pathSegments.join('/')

  // Validate path is allowed
  const isAllowed = ALLOWED_PREFIXES.some(prefix => apiPath.startsWith(prefix))
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
  } else if (
    role !== 'superadmin' &&
    !assignedProjects.includes('*') &&
    !apiPath.startsWith('/api/health') &&
    !apiPath.startsWith('/api/companies')
  ) {
    // Direct access to issues, agents, runs, etc. without a company prefix
    // is forbidden for non-superadmins because we cannot reliably check tenancy.
    return NextResponse.json(
      { error: 'Direct access to global resources requires superadmin role. Use company-scoped paths instead.' },
      { status: 403 }
    )
  }

  // Forward request to Paperclip with session auth
  const url = `${PAPERCLIP_BASE}${apiPath}`

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
      loopDetector.detectAndRecord(method, apiPath, requestBody)
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
    const upstream = await breaker.execute('paperclip-api', () => withRetry(execute, { maxAttempts: 2, deadlineMs: 12_000 }))
    const data = await upstream.text()

    // If the user is staff (not admin) and this is a companies list,
    // filter to only their assigned projects
    const isCompaniesList = apiPath.replace(/\/$/, '') === '/api/companies';
    if (isCompaniesList && role !== 'superadmin' && !assignedProjects.includes('*')) {
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
