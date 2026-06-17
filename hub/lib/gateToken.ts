/**
 * Quality-Gate Token (P0-2)
 *
 * The Interview-Mode context-sufficiency gate (the "a non-technical owner can't
 * be harmed by a misinformed agent" guarantee) historically lived entirely in
 * the browser, so it gated nothing at the API boundary. This module makes the
 * server's own gate decision unforgeable and enforceable at the write route:
 *
 *  - `/api/chat/score-context` evaluates the gate server-side and, on a genuine
 *    pass, mints a short-lived HMAC-signed token via `issueGateToken`.
 *  - Interview Mode threads that token into the high-stakes issue POST.
 *  - The Paperclip proxy calls `verifyGateToken` on `POST /api/issues` and fails
 *    closed when it is missing, forged, expired, or below threshold.
 *
 * The token is signed with a server-only secret, so a client cannot manufacture
 * a passing score. There is intentionally no decode path that trusts unsigned
 * input.
 */
import crypto from 'crypto'

/** Minimum score that counts as a pass (mirrors the UI's 80% threshold). */
export const GATE_PASS_THRESHOLD = 80

/** Tokens are valid for 5 minutes — long enough to confirm, short enough to limit replay. */
const TOKEN_TTL_MS = 5 * 60 * 1000

/** Server-only signing secret. Reuses NEXTAUTH_SECRET so no new env var is required. */
function gateSecret(): string {
  return process.env.GATE_TOKEN_SECRET || process.env.NEXTAUTH_SECRET || ''
}

interface GatePayload {
  /** The interview intent the gate passed for (audit/debug context). */
  intent: string
  /** The server-evaluated context-sufficiency score (0–100). */
  score: number
  /** Absolute expiry, epoch ms. */
  exp: number
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

function sign(body: string, secret: string): string {
  return b64url(crypto.createHmac('sha256', secret).update(body).digest())
}

/**
 * Mint a signed gate token attesting that the server scored `intent` at `score`.
 * @throws if no signing secret is configured (fail closed — never mint an unsigned token).
 */
export function issueGateToken(intent: string, score: number, now: number = Date.now()): string {
  const secret = gateSecret()
  if (!secret) {
    throw new Error('Quality gate not configured: GATE_TOKEN_SECRET/NEXTAUTH_SECRET is unset')
  }
  const payload: GatePayload = { intent, score, exp: now + TOKEN_TTL_MS }
  const body = b64url(Buffer.from(JSON.stringify(payload)))
  return `${body}.${sign(body, secret)}`
}

export interface GateVerifyResult {
  valid: boolean
  reason?: string
  intent?: string
  score?: number
}

/**
 * Verify a gate token. Returns `valid: true` only for a well-formed token with a
 * matching HMAC signature, an unexpired `exp`, and a score at/above threshold.
 * Any other input — including a missing secret — fails closed.
 */
export function verifyGateToken(
  token: string | null | undefined,
  now: number = Date.now()
): GateVerifyResult {
  const secret = gateSecret()
  if (!secret) return { valid: false, reason: 'gate secret not configured' }
  if (!token) return { valid: false, reason: 'missing gate token' }

  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return { valid: false, reason: 'malformed token' }
  const body = token.slice(0, dot)
  const sig = token.slice(dot + 1)

  const expected = sign(body, secret)
  const sigBuf = Buffer.from(sig)
  const expBuf = Buffer.from(expected)
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return { valid: false, reason: 'bad signature' }
  }

  let payload: GatePayload
  try {
    payload = JSON.parse(b64urlDecode(body).toString('utf8'))
  } catch {
    return { valid: false, reason: 'unparseable payload' }
  }

  if (typeof payload.exp !== 'number' || payload.exp < now) {
    return { valid: false, reason: 'expired' }
  }
  if (typeof payload.score !== 'number' || payload.score < GATE_PASS_THRESHOLD) {
    return { valid: false, reason: 'score below threshold' }
  }

  return { valid: true, intent: payload.intent, score: payload.score }
}
