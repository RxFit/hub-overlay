import { describe, it, expect, beforeEach } from 'vitest'
import {
  issueGateToken,
  verifyGateToken,
  GATE_PASS_THRESHOLD,
  _resetConsumedJti,
} from '@/lib/gateToken'

// The secret is read at call-time, so setting it here is sufficient.
// Reset the single-use ledger so consume tests don't leak across cases.
beforeEach(() => {
  process.env.GATE_TOKEN_SECRET = 'unit-test-secret'
  _resetConsumedJti()
})

describe('gateToken', () => {
  it('round-trips a freshly issued token', () => {
    const token = issueGateToken('create_paperclip_issue', 92)
    const result = verifyGateToken(token)
    expect(result.valid).toBe(true)
    expect(result.intent).toBe('create_paperclip_issue')
    expect(result.score).toBe(92)
  })

  it('rejects a missing token (fail closed)', () => {
    expect(verifyGateToken(undefined).valid).toBe(false)
    expect(verifyGateToken(null).valid).toBe(false)
    expect(verifyGateToken('').valid).toBe(false)
  })

  it('rejects a malformed token', () => {
    expect(verifyGateToken('not-a-token').valid).toBe(false)
    expect(verifyGateToken('only.').valid).toBe(false)
    expect(verifyGateToken('.onlysig').valid).toBe(false)
  })

  it('rejects a tampered payload (signature mismatch)', () => {
    const token = issueGateToken('send_communication', 90)
    const [body, sig] = token.split('.')
    // Flip the payload but keep the original signature.
    const forgedBody = Buffer.from(JSON.stringify({ intent: 'x', score: 100, exp: Date.now() + 10000 }))
      .toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(verifyGateToken(`${forgedBody}.${sig}`).valid).toBe(false)
    // Sanity: untouched token still verifies.
    expect(verifyGateToken(`${body}.${sig}`).valid).toBe(true)
  })

  it('rejects a token signed with a different secret', () => {
    const token = issueGateToken('create_agent', 95)
    process.env.GATE_TOKEN_SECRET = 'a-different-secret'
    expect(verifyGateToken(token).valid).toBe(false)
  })

  it('rejects an expired token', () => {
    const past = Date.now() - 60 * 60 * 1000 // issued an hour ago
    const token = issueGateToken('launch_campaign', 88, past)
    const result = verifyGateToken(token)
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('expired')
  })

  it('rejects a token below the pass threshold', () => {
    const token = issueGateToken('create_paperclip_issue', GATE_PASS_THRESHOLD - 1)
    const result = verifyGateToken(token)
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('score below threshold')
  })

  it('accepts a token exactly at the pass threshold', () => {
    const token = issueGateToken('create_paperclip_issue', GATE_PASS_THRESHOLD)
    expect(verifyGateToken(token).valid).toBe(true)
  })

  it('fails closed when no secret is configured', () => {
    delete process.env.GATE_TOKEN_SECRET
    delete process.env.NEXTAUTH_SECRET
    expect(() => issueGateToken('create_paperclip_issue', 90)).toThrow()
    expect(verifyGateToken('anything').valid).toBe(false)
  })
})

describe('gateToken — single-use (jti) + caller binding (P1-S3)', () => {
  it('accepts a single consume, then rejects the replay within the TTL', () => {
    const token = issueGateToken('create_paperclip_issue', 92)
    expect(verifyGateToken(token, { consume: true }).valid).toBe(true)
    const replay = verifyGateToken(token, { consume: true })
    expect(replay.valid).toBe(false)
    expect(replay.reason).toBe('token already used')
  })

  it('does not burn the token unless consume is requested (verify stays pure)', () => {
    const token = issueGateToken('create_paperclip_issue', 92)
    expect(verifyGateToken(token).valid).toBe(true)
    expect(verifyGateToken(token).valid).toBe(true) // repeatable — not consumed
    // A later consume still works exactly once.
    expect(verifyGateToken(token, { consume: true }).valid).toBe(true)
    expect(verifyGateToken(token, { consume: true }).valid).toBe(false)
  })

  it('preserves the backward-compatible positional `now` argument', () => {
    const past = Date.now() - 60 * 60 * 1000
    const token = issueGateToken('launch_campaign', 88, past)
    // second arg as a bare number is still treated as `now`.
    expect(verifyGateToken(token, past + 1000).valid).toBe(true)
    expect(verifyGateToken(token).reason).toBe('expired')
  })

  it('binds the token to the minting user (case-insensitive email match)', () => {
    const token = issueGateToken('send_gmail', 95, Date.now(), { email: 'Danny@RxFitATX.com' })
    expect(verifyGateToken(token, { expectedEmail: 'danny@rxfitatx.com' }).valid).toBe(true)
  })

  it('rejects a token presented by a DIFFERENT user (wrong-user token)', () => {
    const token = issueGateToken('send_gmail', 95, Date.now(), { email: 'danny@rxfitatx.com' })
    const res = verifyGateToken(token, { expectedEmail: 'attacker@evil.com' })
    expect(res.valid).toBe(false)
    expect(res.reason).toBe('user mismatch')
  })

  it('fails closed when a bound check is run against a subject-less token', () => {
    const token = issueGateToken('send_gmail', 95) // minted with no email → no sub
    expect(verifyGateToken(token, { expectedEmail: 'danny@rxfitatx.com' }).reason).toBe('user mismatch')
  })

  it('still verifies a bound token when the verifier passes no expectedEmail (backward compatible)', () => {
    const token = issueGateToken('send_gmail', 95, Date.now(), { email: 'danny@rxfitatx.com' })
    expect(verifyGateToken(token).valid).toBe(true)
  })

  it('does NOT consume a token that fails an earlier check (expired bails before the jti burn)', () => {
    const past = Date.now() - 60 * 60 * 1000
    const token = issueGateToken('create_paperclip_issue', 92, past)
    const res = verifyGateToken(token, { consume: true })
    expect(res.valid).toBe(false)
    expect(res.reason).toBe('expired') // not 'token already used' → jti was never claimed
  })

  it('enforces binding AND single-use together (the write-route contract)', () => {
    const token = issueGateToken('create_paperclip_issue', 92, Date.now(), { email: 'danny@rxfitatx.com' })
    const opts = { expectedEmail: 'danny@rxfitatx.com', consume: true }
    expect(verifyGateToken(token, opts).valid).toBe(true)
    const replay = verifyGateToken(token, opts)
    expect(replay.valid).toBe(false)
    expect(replay.reason).toBe('token already used')
  })
})
