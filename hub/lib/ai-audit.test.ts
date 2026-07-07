import { describe, it, expect } from 'vitest'
import { toAuditRow, fingerprintGateToken, SENSITIVE_TARGET_KEYS } from './ai-audit'

/* ════════════════════════════════════════════════════════════════════════════
   ai-audit — the REDACTION contract (NS-2).

   toAuditRow is a pure mapper and is the single place that guarantees a row
   records provenance, never content: message bodies are stripped from `target`,
   and the gate token is reduced to a non-reversible fingerprint (the full token
   is never present). These tests lock that contract without touching a DB.
   ════════════════════════════════════════════════════════════════════════════ */

describe('toAuditRow — redaction', () => {
  it('strips body-like keys from target, keeps routing metadata', () => {
    const row = toAuditRow({
      actionType: 'gmail_send',
      status: 'success',
      target: {
        to: 'ceo@rxfitatx.com',
        threadId: 'abc123',
        subject: 'Q3 numbers',            // sensitive — dropped
        message: 'Here are the private figures...', // body — dropped
        body: 'more body',                // dropped
        notes: 'internal',                // dropped
      },
    })
    expect(row.target).toEqual({ to: 'ceo@rxfitatx.com', threadId: 'abc123' })
    expect(JSON.stringify(row.target)).not.toContain('private figures')
    expect(JSON.stringify(row.target)).not.toMatch(/subject|message|body|notes/i)
  })

  it('drops nested objects from target (can smuggle bodies)', () => {
    const row = toAuditRow({
      actionType: 'chat_post',
      status: 'success',
      target: { spaceId: 'spaces/1', payload: { text: 'secret' } as unknown as string },
    })
    expect(row.target).toEqual({ spaceId: 'spaces/1' })
  })

  it('returns null target when nothing survives redaction', () => {
    const row = toAuditRow({
      actionType: 'gmail_send',
      status: 'success',
      target: { message: 'only a body here' },
    })
    expect(row.target).toBeNull()
  })

  it('keeps the token FINGERPRINT and never the full token', () => {
    const fullToken = 'eyJpbnRlbnQiOiJzZW5kX2dtYWlsIn0.SIGNATURE_PART_THAT_IS_SECRET'
    const row = toAuditRow({
      actionType: 'gmail_send',
      status: 'success',
      gateToken: fullToken,
    })
    expect(row.gateTokenId).toBe(fingerprintGateToken(fullToken))
    expect(row.gateTokenId).toHaveLength(16)
    expect(row.gateTokenId).not.toBe(fullToken)
    // Full token must never appear anywhere in the serialized row.
    expect(JSON.stringify(row)).not.toContain(fullToken)
    expect(JSON.stringify(row)).not.toContain('SIGNATURE_PART_THAT_IS_SECRET')
  })

  it('prefers an explicit gateTokenId over deriving from a token', () => {
    const row = toAuditRow({
      actionType: 'gmail_send',
      status: 'success',
      gateTokenId: 'preset-id',
      gateToken: 'some.token',
    })
    expect(row.gateTokenId).toBe('preset-id')
  })

  it('maps actor/action_type/status/intent and normalizes email', () => {
    const row = toAuditRow({
      userEmail: '  Danny@RxFitATX.com ',
      actor: 'ai',
      actionType: 'task_create',
      intent: 'create_task',
      requestId: 'req-1',
      status: 'failed',
      error: 'rate_limited',
    })
    expect(row).toMatchObject({
      userEmail: 'danny@rxfitatx.com',
      actor: 'ai',
      actionType: 'task_create',
      intent: 'create_task',
      requestId: 'req-1',
      status: 'failed',
      error: 'rate_limited',
    })
  })

  it('defaults actor to ai and nullable fields to null', () => {
    const row = toAuditRow({ actionType: 'gmail_send', status: 'success' })
    expect(row.actor).toBe('ai')
    expect(row.userEmail).toBeNull()
    expect(row.intent).toBeNull()
    expect(row.gateTokenId).toBeNull()
    expect(row.error).toBeNull()
  })
})

describe('fingerprintGateToken', () => {
  it('is deterministic, 16 hex chars, and non-reversible', () => {
    const a = fingerprintGateToken('token-xyz')
    const b = fingerprintGateToken('token-xyz')
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
    expect(a).not.toContain('token-xyz')
  })

  it('returns null for empty/absent tokens', () => {
    expect(fingerprintGateToken(null)).toBeNull()
    expect(fingerprintGateToken(undefined)).toBeNull()
    expect(fingerprintGateToken('')).toBeNull()
  })

  it('denylist covers the obvious body/secret keys', () => {
    for (const k of ['message', 'text', 'body', 'notes', 'subject', 'token', 'gatetoken']) {
      expect(SENSITIVE_TARGET_KEYS.has(k)).toBe(true)
    }
  })
})
