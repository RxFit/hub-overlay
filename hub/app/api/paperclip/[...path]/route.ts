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
import { verifyGateToken } from '@/lib/gateToken'
import { requiredWriteRank, ROLE_RANK } from '@/lib/proxyAuthz'
import crypto from 'crypto'

const log = createLogger('paperclip/proxy')

const PAPERCLIP_BASE = PAPERCLIP_BASE_URL

/** Resource listing endpoints that require company-scoped access for non-superadmin users. */
const SCOPED_LIST_PATHS = ['/api/issues', '/api/agents', '/api/projects', '/api/runs']

/**
 * Determines whether a request to a list endpoint should be blocked for scoped users.
 * Allows: POST /api/issues (issue creation) and /api/runs?companyId=... (scoped run queries).
 */
function isBlockedListAccess(
  apiPath: string,
  method: string,
  searchParams: URLSearchParams
): boolean {
  const matchesList = SCOPED_LIST_PATHS.some(
    p => apiPath === p || apiPath.startsWith(`${p}?`)
  )
  if (!matchesList) return false

  // Allow POST to /api/issues (issue creation)
  if (method.toUpperCase() === 'POST' && (apiPath === '/api/issues' || apiPath.startsWith('/api/issues?'))) {
    return false
  }
  // Allow /api/runs with companyId query (scoped run query)
  if (apiPath.startsWith('/api/runs') && searchParams.has('companyId')) {
    return false
  }
  return true
}

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
  // Destructive operations are role-gated inside proxyRequest via
  // requiredWriteRank() — the real security boundary (client-side Interview Mode
  // name-matching is just UX). Pre-fetch the session here only to avoid a second
  // getServerSession call in proxyRequest.
  const session = await getServerSession(authOptions)
  return proxyRequest(req, params.path, 'DELETE', session)
}

async function proxyRequest(
  req: NextRequest,
  pathSegments: string[],
  method: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  preAuthSession?: any
) {
  // Auth check — reuse pre-authenticated session if provided (DELETE handler)
  const session = preAuthSession ?? await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Normalize: clients historically call both /api/paperclip/companies/...
  // and /api/paperclip/api/companies/... — strip a leading 'api' segment so
  // we never build a double-prefixed upstream path like /api/api/companies.
  const segments = pathSegments[0] === 'api' ? pathSegments.slice(1) : pathSegments
  const apiPath = '/api/' + segments.join('/')

  // SECURITY (P0): all authorization decisions below (role tier, company scope,
  // and issue/agent/project ownership pre-checks) match the path
  // case-INSENSITIVELY via `matchPath`. Postgres resolves UUIDs
  // case-insensitively, so `/api/companies/<UPPERCASE-UUID>` hits the same
  // upstream row as its lowercase form; matching case-sensitively here let an
  // uppercase-UUID mutation slip past the role gate AND skip the company-scope
  // check entirely (privilege escalation). The request still forwards the
  // ORIGINAL-case `apiPath` upstream — only the authz matching is canonicalized.
  const matchPath = apiPath.toLowerCase()

  // Validate path is allowed (boundary-safe: exact match or '/' follows)
  const isAllowed = ALLOWED_PREFIXES.some(
    prefix => matchPath === prefix || matchPath.startsWith(prefix + '/') || matchPath.startsWith(prefix + '?')
  )
  if (!isAllowed) {
    return NextResponse.json({ error: 'Forbidden path' }, { status: 403 })
  }

  // Project-scoped access control
  const user = session.user as Record<string, unknown>
  const role = user.role as string
  const assignedProjects = (user.assignedProjects as string[]) ?? []

  // P0-1: Role-tier enforcement for mutations. Mirrors INTENT_PERMISSIONS so a
  // scoped staff user cannot bypass client-side gating by calling the API
  // directly (e.g. PATCH an issue, restart/create an agent).
  const requiredRank = requiredWriteRank(method, matchPath)
  if (requiredRank > 0 && (ROLE_RANK[role] ?? 0) < requiredRank) {
    return NextResponse.json(
      { error: 'Forbidden — insufficient role for this operation' },
      { status: 403 }
    )
  }

  // P0-2: High-stakes issue creation must carry a server-issued, HMAC-signed
  // quality-gate token. Every POST /api/issues originates from Interview Mode's
  // executeAction (high-stakes intents: create issue / send comm / create agent
  // / launch campaign). Without a valid, unexpired, above-threshold token we
  // fail closed — the gate is no longer bypassable from the browser.
  if (method.toUpperCase() === 'POST' && matchPath === '/api/issues') {
    // Single-use (jti) + caller-binding (email): a gate token is consumed on
    // first use and is bound to the user it was minted for, so it cannot be
    // replayed within its 5-min TTL or lifted from another user's session.
    const gate = verifyGateToken(req.headers.get('x-gate-token'), {
      expectedEmail: session.user.email,
      consume: true,
    })
    if (!gate.valid) {
      log.warn({ path: apiPath, reason: gate.reason }, 'Quality-gate token rejected')
      return NextResponse.json(
        {
          error: `Quality gate not satisfied (${gate.reason ?? 'no valid gate token'}). Re-run this action through the assistant so it can be re-validated.`,
        },
        { status: 403 }
      )
    }
  }

  // If the request targets a specific company, check access (case-insensitive —
  // see the `matchPath` note above; an uppercase UUID must not skip this scope check).
  const companyMatch = matchPath.match(/\/api\/companies\/([a-f0-9-]+)/)
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

  // Block direct lists for scoped users (case-insensitive match)
  if (role !== 'superadmin' && !assignedProjects.includes('*')) {
    if (isBlockedListAccess(matchPath, method, req.nextUrl.searchParams)) {
      return NextResponse.json(
        { error: 'Access denied: direct resource listing is restricted' },
        { status: 403 }
      )
    }

    // For allowed /api/runs?companyId=..., verify the user is assigned to that company
    if (matchPath.startsWith('/api/runs') && req.nextUrl.searchParams.has('companyId')) {
      const qCompanyId = req.nextUrl.searchParams.get('companyId')
      if (qCompanyId && !assignedProjects.includes(qCompanyId)) {
        return NextResponse.json(
          { error: 'Access denied: not assigned to this project' },
          { status: 403 }
        )
      }
    }
  }

  // KNOWN LIMITATION (TOCTOU): This GET-then-mutate pattern has a theoretical
  // time-of-check/time-of-use race — the resource's companyId could change
  // between the pre-check GET and the forwarded mutation. Practical risk is
  // near-zero: company reassignment is an admin-only, infrequent operation.
  // Accepted risk per code review 2026-06-13 (R2).
  // Pre-check for specific resources (issues/agents/projects) on mutation
  // (PATCH/DELETE). Case-insensitive (`matchPath`) so an uppercase-UUID mutation
  // cannot bypass the ownership pre-check by failing the matcher.
  const issueMatch = matchPath.match(/\/api\/issues\/([a-f0-9-]+)/)
  const agentMatch = matchPath.match(/\/api\/agents\/([a-f0-9-]+)/)
  const projectMatch = matchPath.match(/\/api\/projects\/([a-f0-9-]+)/)

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
    // filter to only their assigned projects (case-insensitive match).
    if (matchPath === '/api/companies' && role !== 'superadmin' && !assignedProjects.includes('*')) {
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
