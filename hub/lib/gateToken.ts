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
  /** One-time token id — enforces single-use so a token can't be replayed. */
  jti?: string
  /** Caller binding: HMAC of the minting user's email (never the raw email). */
  sub?: string
}

/**
 * Single-use ledger (P1-S3): jti → expiry(ms). A consumed token's jti lives here
 * until it expires, so a second consume within the 5-min TTL is rejected as a
 * replay. Bounded + self-expiring like the rate-limiter Map: entries drop
 * themselves at expiry and a size-capped sweep evicts stale ids.
 *
 * NOTE: this is per-process/in-memory (mirrors lib/rate-limit + loop-detector).
 * A multi-instance deployment does not share it, so cross-instance replay within
 * the TTL is a known residual — acceptable for a 5-min, caller-bound token and
 * consistent with the app's other in-memory guards. A shared store (Redis) would
 * close it fully.
 */
const consumedJti = new Map<string, number>()
const JTI_SWEEP_THRESHOLD = 1000

function sweepConsumed(now: number): void {
  if (consumedJti.size < JTI_SWEEP_THRESHOLD) return
  for (const [id, exp] of consumedJti) {
    if (exp <= now) consumedJti.delete(id)
  }
}

/**
 * Atomically claim a jti. Returns false if it was already claimed and is still
 * unexpired (a replay); true on first use.
 */
function claimJti(jti: string, exp: number, now: number): boolean {
  sweepConsumed(now)
  const prior = consumedJti.get(jti)
  if (prior !== undefined && prior > now) return false // already used, still valid → replay
  consumedJti.set(jti, exp)
  return true
}

/** Test-only: clear the single-use ledger between cases. */
export function _resetConsumedJti(): void {
  consumedJti.clear()
}

/** Derive the bound-subject value (HMAC of the lowercased email — not reversible
 *  to the address without the server secret, and unforgeable). */
function subFor(email: string | null | undefined, secret: string): string | undefined {
  const e = (email || '').toLowerCase().trim()
  if (!e) return undefined
  return sign(`sub:${e}`, secret)
}

/** Options for {@link verifyGateToken}. A bare number is still accepted for
 *  `now` so existing call sites (`verifyGateToken(token, now)`) keep working. */
export interface GateVerifyOptions {
  /** Clock override (epoch ms). */
  now?: number
  /** When set, the token's bound subject MUST match this caller's email. */
  expectedEmail?: string | null
  /** When true, the token's jti is consumed (single-use) on a successful verify. */
  consume?: boolean
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
export function issueGateToken(
  intent: string,
  score: number,
  now: number = Date.now(),
  opts: { email?: string | null } = {},
): string {
  const secret = gateSecret()
  if (!secret) {
    throw new Error('Quality gate not configured: GATE_TOKEN_SECRET/NEXTAUTH_SECRET is unset')
  }
  const payload: GatePayload = {
    intent,
    score,
    exp: now + TOKEN_TTL_MS,
    jti: crypto.randomUUID(),          // single-use id (replay defense)
    sub: subFor(opts.email, secret),   // caller binding (omitted when no email)
  }
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
 *
 * Optional hardening (opt-in per call site, so unrelated verifiers are
 * unaffected):
 *  - `expectedEmail` — the token's bound subject must match this caller. A token
 *    minted for user A cannot be lifted and used by user B.
 *  - `consume` — burns the token's one-time `jti`, so it cannot be replayed
 *    within its TTL. Consumption happens LAST, only after every other check
 *    passes, so a token is never burned by a request that was going to fail.
 *
 * The second argument also accepts a bare `now` number for backward
 * compatibility with existing `verifyGateToken(token, now)` call sites.
 */
export function verifyGateToken(
  token: string | null | undefined,
  optsOrNow: number | GateVerifyOptions = {},
): GateVerifyResult {
  const opts: GateVerifyOptions = typeof optsOrNow === 'number' ? { now: optsOrNow } : optsOrNow
  const now = opts.now ?? Date.now()

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

  // Caller binding — enforced only when the verifier passes expectedEmail. The
  // signed `sub` must match; a sub-less token fails closed against a bound check.
  if (opts.expectedEmail != null && opts.expectedEmail !== '') {
    const expectedSub = subFor(opts.expectedEmail, secret)
    if (!payload.sub || payload.sub !== expectedSub) {
      return { valid: false, reason: 'user mismatch' }
    }
  }

  // Single-use — consume LAST so a token that would have failed above is not
  // burned and can be legitimately retried once the caller fixes the request.
  if (opts.consume) {
    if (!payload.jti) return { valid: false, reason: 'not single-use (missing jti)' }
    if (!claimJti(payload.jti, payload.exp, now)) {
      return { valid: false, reason: 'token already used' }
    }
  }

  return { valid: true, intent: payload.intent, score: payload.score }
}
