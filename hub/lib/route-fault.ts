import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import crypto from 'crypto'
import { toFault, faultResponse, newFaultId, type FaultDraft } from '@/lib/fault'
import { reportFault } from '@/lib/fault-report'
import { createLogger } from '@/lib/logger'

/**
 * withFault — the route wrapper (ERROR_REPORTING_2026-08-24.md §3 Layer 3,
 * §12.2). This is the only available mechanism on next@14.2.x: middleware
 * structurally cannot catch route-handler throws (vercel/next.js#59868) and
 * onRequestError landed in Next 15.0.0.
 *
 * Duty order is FIXED and each step exists for a reason:
 *   1. requestId — the correlation spine. The header is trusted ONLY when it
 *      is exactly a UUID: on middleware-excluded paths (api/chat, api/worker,
 *      api/cron/, api/healthz, api/embeddings, api/webhooks) an external
 *      caller supplies it unvalidated — correlation poisoning plus unbounded
 *      log cardinality. Same posture as middleware deleting a
 *      client-supplied x-tenant-id.
 *   2. run the handler
 *   3. RE-THROW Next control flow FIRST — redirect() and notFound() are
 *      implemented as throws; a naive catch turns every intended navigation
 *      into a fake 500. Detected via the digest string, never instanceof.
 *   4. 2xx contract check — a 2xx JSON body carrying `error` is a silent
 *      failure, caught STRUCTURALLY so nobody has to remember. Gated hard:
 *      content-type application/json AND content-length present and ≤ 64 KB,
 *      read via res.clone() — a streamed or unsized body is never touched
 *      (reading one buffers it in memory; the chat SSE stream must pass
 *      through byte-identical). NOTE: NextResponse.json does not set
 *      content-length until serialization, so today this check arms only on
 *      explicitly-sized responses — partial coverage by design; Phase 2's
 *      no-200-errors build guard covers the rest.
 *   5. toFault → reportFault → faultResponse. The reporter must never be
 *      able to break a request: if normalization or reporting itself throws,
 *      the caller still gets a well-formed 500 problem+json.
 *
 * WHAT THIS CANNOT COVER, stated so "we centralized error handling" never
 * becomes a false claim: it cannot change a streamed response after the
 * shell is flushed (the terminal-frame contract, Phase 5); it cannot inspect
 * a streamed 2xx body; it cannot see Server Component render errors
 * (error.tsx / global-error.tsx, Phase 3); it cannot catch React
 * event-handler throws; and it MUST NOT make retry or compensation decisions
 * — a top-level handler cannot know which parts of an operation already
 * succeeded.
 */

/** Non-enumerable brand. tests/route-fault-coverage.test.ts (Phase 2) asserts
 *  on it — a brand survives re-exports; grepping for `withFault` passes on a
 *  commented-out import. */
export const FAULT_WRAPPED = Symbol.for('hub.faultWrapped')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A header-supplied id is accepted only if it is EXACTLY a UUID; else mint. */
export function safeRequestId(header: string | null): string {
  return header && UUID_RE.test(header) ? header.toLowerCase() : crypto.randomUUID()
}

/** redirect() and notFound() throw an Error carrying a NEXT_* digest. */
export function isNextControlFlow(err: unknown): boolean {
  const digest = (err as { digest?: unknown } | null)?.digest
  return typeof digest === 'string' && (digest.startsWith('NEXT_REDIRECT') || digest === 'NEXT_NOT_FOUND')
}

const MAX_INSPECT_BYTES = 64 * 1024

/**
 * Detect a 2xx JSON body that is actually a failure. Returns the offending
 * top-level key, or null. NEVER throws and never touches a body it cannot
 * cheaply and safely read — see the gate in the module header.
 */
export async function detectErrorIn2xx(res: Response): Promise<string | null> {
  try {
    if (res.status < 200 || res.status >= 300) return null
    const contentType = res.headers.get('content-type') ?? ''
    if (!contentType.includes('application/json')) return null
    const lengthHeader = res.headers.get('content-length')
    if (!lengthHeader) return null
    const length = Number(lengthHeader)
    if (!Number.isFinite(length) || length > MAX_INSPECT_BYTES) return null
    const body: unknown = await res.clone().json()
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null
    const record = body as Record<string, unknown>
    if (record.error) return 'error'
    if (record.reason) return 'reason'
    if (record.ok === false) return 'ok:false'
    if (record.success === false) return 'success:false'
    return null
  } catch {
    return null
  }
}

// Module-scope logger, deliberately NOT per-request: createLogger() builds a
// fresh pino instance per call (lib/logger.ts — the Phase 2 refactor makes it
// a child of one root). requestId/route travel as log fields instead.
const log = createLogger('route-fault')

type Handler<A extends unknown[]> = (req: NextRequest, ...args: A) => Promise<Response> | Response

export function withFault<A extends unknown[]>(
  name: string,
  handler: Handler<A>,
): (req: NextRequest, ...args: A) => Promise<Response> {
  const wrapped = async (req: NextRequest, ...args: A): Promise<Response> => {
    const requestId = safeRequestId(req.headers.get('x-hub-request-id'))
    const isProd = process.env.NODE_ENV === 'production'

    try {
      const res = await handler(req, ...args)

      const violation = await detectErrorIn2xx(res)
      if (violation) {
        const fault = toFault(new Error(`2xx body carries ${violation}`), {
          layer: 'route',
          code: 'contract_violation',
          route: name,
          method: req.method,
          module: name,
          requestId,
          httpStatus: res.status,
        })
        log.error({ requestId, route: name, violation, faultId: fault.faultId }, `${name} returned a 2xx carrying a failure body`)
        reportFault(fault)
        // Fail loud where a developer is watching; never break production on
        // our own assertion. The RECORD keeps httpStatus 200 (the truth — the
        // mid-contract-violation signature); only the dev response is a 500.
        if (!isProd) return faultResponse({ ...fault, httpStatus: 500 }, isProd)
      }

      // fetch()-produced Responses have immutable headers — skip silently.
      try {
        res.headers.set('x-hub-request-id', requestId)
      } catch {
        /* immutable headers (proxied Response) */
      }
      return res
    } catch (err) {
      if (isNextControlFlow(err)) throw err

      try {
        const fault = toFault(err, {
          layer: 'route',
          route: name,
          method: req.method,
          module: name,
          requestId,
        })
        log.error({ err, requestId, route: name, faultId: fault.faultId, code: fault.code }, `${name} failed`)
        reportFault(fault, { rawStack: err instanceof Error ? err.stack : null })
        return faultResponse(fault, isProd)
      } catch (reporterErr) {
        // The reporter can never break a request: even with toFault or
        // reportFault broken, the caller gets a well-formed 500.
        return fallbackResponse(requestId, reporterErr)
      }
    }
  }

  Object.defineProperty(wrapped, FAULT_WRAPPED, { value: true, enumerable: false })
  Object.defineProperty(wrapped, 'name', { value: `withFault(${name})` })
  return wrapped
}

/** The response of last resort — hand-built, no dependencies that can fail. */
function fallbackResponse(requestId: string, reporterErr: unknown): NextResponse {
  const faultId = safeNewFaultId()
  try {
    // Best-effort trace of the reporter's own failure; guarded because a
    // broken console is one of the failure modes under test.
    console.error('[route-fault] fault reporter failed', reporterErr instanceof Error ? reporterErr.message : reporterErr)
  } catch {
    /* even the console can be gone */
  }
  return NextResponse.json(
    { type: 'about:blank', title: 'Request failed', status: 500, instance: faultId, code: 'internal', error: 'Something went wrong. Please try again.', requestId },
    { status: 500, headers: { 'x-hub-fault-id': faultId, 'x-hub-request-id': requestId, 'content-type': 'application/problem+json' } },
  )
}

function safeNewFaultId(): string {
  try {
    return newFaultId()
  } catch {
    return 'HUB-UNKNOWN'
  }
}

/** True when a handler function carries the withFault brand. */
export function isFaultWrapped(fn: unknown): boolean {
  return typeof fn === 'function' && (fn as unknown as Record<symbol, unknown>)[FAULT_WRAPPED] === true
}

export type { FaultDraft }
