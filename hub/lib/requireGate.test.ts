import { describe, it, expect, beforeEach } from 'vitest'
import { issueGateToken } from '@/lib/gateToken'
import { requireAiGate, AI_INTENT_HEADER, GATE_TOKEN_HEADER } from '@/lib/requireGate'

// The secret is read at call-time, so setting it here is sufficient
// (mirrors gateToken.test.ts).
beforeEach(() => {
  process.env.GATE_TOKEN_SECRET = 'unit-test-secret'
})

function headersWith(entries: Record<string, string>): Headers {
  return new Headers(entries)
}

describe('requireAiGate', () => {
  it('passes a request with no AI-intent header (manual send — gate not applicable)', () => {
    const result = requireAiGate(headersWith({}), ['send_gmail'])
    expect(result).toEqual({ ok: true })
  })

  it('ignores a stray gate token when the AI marker is absent', () => {
    const token = issueGateToken('send_gmail', 95)
    const result = requireAiGate(headersWith({ [GATE_TOKEN_HEADER]: token }), ['send_gmail'])
    expect(result).toEqual({ ok: true })
  })

  it('passes an AI request with a valid token whose intent matches the header', () => {
    const token = issueGateToken('send_gmail', 95)
    const result = requireAiGate(
      headersWith({ [AI_INTENT_HEADER]: 'send_gmail', [GATE_TOKEN_HEADER]: token }),
      ['send_gmail']
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.intent).toBe('send_gmail')
  })

  it('rejects an AI request with no gate token (403, fail closed)', () => {
    const result = requireAiGate(
      headersWith({ [AI_INTENT_HEADER]: 'send_gmail' }),
      ['send_gmail']
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(403)
      expect(result.error).toContain('missing gate token')
    }
  })

  it('rejects a forged/garbage token (403)', () => {
    for (const garbage of ['not-a-token', 'aaaa.bbbb', 'x'.repeat(200)]) {
      const result = requireAiGate(
        headersWith({ [AI_INTENT_HEADER]: 'send_gmail', [GATE_TOKEN_HEADER]: garbage }),
        ['send_gmail']
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.status).toBe(403)
    }
  })

  it('rejects a valid token minted for a different intent (403)', () => {
    // Token genuinely passed the gate — but for create_task, not send_gmail.
    const token = issueGateToken('create_task', 95)
    const result = requireAiGate(
      headersWith({ [AI_INTENT_HEADER]: 'send_gmail', [GATE_TOKEN_HEADER]: token }),
      ['send_gmail']
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(403)
      expect(result.error).toContain('intent mismatch')
    }
  })

  it('rejects an expired token (403)', () => {
    const past = Date.now() - 60 * 60 * 1000 // issued an hour ago
    const token = issueGateToken('send_gmail', 95, past)
    const result = requireAiGate(
      headersWith({ [AI_INTENT_HEADER]: 'send_gmail', [GATE_TOKEN_HEADER]: token }),
      ['send_gmail']
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(403)
      expect(result.error).toContain('expired')
    }
  })

  it('rejects a declared intent not in allowedIntents even with a valid token (403)', () => {
    const token = issueGateToken('send_gmail', 95)
    const result = requireAiGate(
      headersWith({ [AI_INTENT_HEADER]: 'send_gmail', [GATE_TOKEN_HEADER]: token }),
      ['post_chat_message']
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(403)
      expect(result.error).toContain('not permitted')
    }
  })

  it('fails closed when no secret is configured', () => {
    const token = issueGateToken('send_gmail', 95)
    delete process.env.GATE_TOKEN_SECRET
    delete process.env.NEXTAUTH_SECRET
    const result = requireAiGate(
      headersWith({ [AI_INTENT_HEADER]: 'send_gmail', [GATE_TOKEN_HEADER]: token }),
      ['send_gmail']
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
  })
})
