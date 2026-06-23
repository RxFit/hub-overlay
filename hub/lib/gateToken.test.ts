import { describe, it, expect, beforeEach } from 'vitest'
import { issueGateToken, verifyGateToken, GATE_PASS_THRESHOLD } from '@/lib/gateToken'

// The secret is read at call-time, so setting it here is sufficient.
beforeEach(() => {
  process.env.GATE_TOKEN_SECRET = 'unit-test-secret'
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
