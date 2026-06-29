import { describe, it, expect, afterEach, vi } from 'vitest'

/* ════════════════════════════════════════════════════════════════════════════
   VALIDATE-KEYS TEST SUITE
   ────────────────────────────────────────────────────────────────────────────
   Tests the startup key validation module (lib/validate-keys.ts).
   Follows the same env-var pattern as gemini.test.ts — set process.env in
   each test and clean up in afterEach.
   ════════════════════════════════════════════════════════════════════════════ */

// Keys to clean up between tests
const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'Anthropic_API_Key',
  'anthropic_token',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
]

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k]
})

describe('getKeyStatus', () => {
  it('returns "valid" for keys with correct prefixes', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-test-key-123'
    process.env.GEMINI_API_KEY = 'AIzaSyTestKey123'

    const { getKeyStatus } = await import('./validate-keys')
    const statuses = getKeyStatus()

    const anthropic = statuses.find(s => s.provider === 'anthropic')
    const gemini = statuses.find(s => s.provider === 'gemini')

    expect(anthropic?.status).toBe('valid')
    expect(anthropic?.envVar).toBe('ANTHROPIC_API_KEY')
    expect(anthropic?.formatWarning).toBeUndefined()

    expect(gemini?.status).toBe('valid')
    expect(gemini?.envVar).toBe('GEMINI_API_KEY')
    expect(gemini?.formatWarning).toBeUndefined()
  })

  it('returns "present" for keys with unknown prefixes', async () => {
    process.env.ANTHROPIC_API_KEY = 'unknown-prefix-key'
    process.env.GEMINI_API_KEY = 'not-a-google-key'

    const { getKeyStatus } = await import('./validate-keys')
    const statuses = getKeyStatus()

    const anthropic = statuses.find(s => s.provider === 'anthropic')
    const gemini = statuses.find(s => s.provider === 'gemini')

    expect(anthropic?.status).toBe('present')
    expect(anthropic?.formatWarning).toContain('sk-ant-')

    expect(gemini?.status).toBe('present')
    expect(gemini?.formatWarning).toContain('AIza')
  })

  it('returns "missing" for undefined keys', async () => {
    // All env vars are already deleted by afterEach

    const { getKeyStatus } = await import('./validate-keys')
    const statuses = getKeyStatus()

    const anthropic = statuses.find(s => s.provider === 'anthropic')
    const gemini = statuses.find(s => s.provider === 'gemini')

    expect(anthropic?.status).toBe('missing')
    expect(gemini?.status).toBe('missing')
  })
})

describe('getAvailableProviders', () => {
  it('returns correct provider list based on key presence', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-real-key'
    // Gemini key intentionally missing

    const { getAvailableProviders } = await import('./validate-keys')
    const providers = getAvailableProviders()

    expect(providers).toContain('anthropic')
    expect(providers).not.toContain('gemini')
  })
})

describe('logKeyStatus', () => {
  it('calls console.log with the correct format', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-valid'
    process.env.GEMINI_API_KEY = 'AIzaSyValid'

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const { logKeyStatus } = await import('./validate-keys')
      logKeyStatus()

      expect(spy).toHaveBeenCalled()
      const loggedMessage = spy.mock.calls.find(
        call => typeof call[0] === 'string' && call[0].includes('[keys]')
      )?.[0] as string

      expect(loggedMessage).toBeDefined()
      expect(loggedMessage).toContain('[keys] Provider status:')
      expect(loggedMessage).toContain('Anthropic=✅ valid')
      expect(loggedMessage).toContain('Gemini=✅ valid')
    } finally {
      spy.mockRestore()
    }
  })
})
