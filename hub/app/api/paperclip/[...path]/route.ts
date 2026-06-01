import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getPaperclipAuthHeaders, clearPaperclipSession } from '@/lib/paperclipSession'

const PAPERCLIP_BASE = process.env.PAPERCLIP_BASE_URL || 'https://rxfit-paperclip-11747747730.us-central1.run.app'

// Allowed API path prefixes for the proxy — covers full Paperclip surface
const ALLOWED_PREFIXES = [
  '/api/companies',         // list + detail + create
  '/api/health',            // health check
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
  if (companyMatch && role !== 'admin' && role !== 'superadmin') {
    const requestedCompanyId = companyMatch[1]
    if (!assignedProjects.includes(requestedCompanyId)) {
      return NextResponse.json(
        { error: 'Access denied: not assigned to this project' },
        { status: 403 }
      )
    }
  }

  // Forward request to Paperclip with session auth
  const url = `${PAPERCLIP_BASE}${apiPath}`
  let authHeaders: Record<string, string>
  try {
    authHeaders = await getPaperclipAuthHeaders()
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Paperclip auth failed'
    return NextResponse.json({ error: message }, { status: 502 })
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...authHeaders,
  }

  const fetchOpts: RequestInit = {
    method,
    headers,
    signal: AbortSignal.timeout(10_000), // 10s timeout to prevent indefinite hangs
  }

  // Forward body for POST/PUT/PATCH
  if (method !== 'GET' && method !== 'HEAD') {
    try {
      const body = await req.text()
      if (body) fetchOpts.body = body
    } catch {
      // No body — that's fine
    }
  }

  try {
    const upstream = await fetch(url, fetchOpts)

    // If Paperclip returns 401, clear session to force re-auth on next request
    if (upstream.status === 401) {
      clearPaperclipSession()
    }

    const data = await upstream.text()

    // If the user is staff (not admin) and this is a companies list,
    // filter to only their assigned projects
    if (apiPath === '/api/companies' && role !== 'admin' && role !== 'superadmin') {
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
    const message = err instanceof Error ? err.message : 'Paperclip API unreachable'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
