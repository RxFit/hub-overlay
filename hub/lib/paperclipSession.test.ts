import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * paperclipSession — session-cookie auth with mutex, cache, and API-key
 * fallback. Env vars are read at MODULE SCOPE, so every scenario reloads the
 * module (vi.resetModules + dynamic import) after stubbing the env it needs.
 * fetch is mocked — no real network.
 */

const fetchMock = vi.fn()

function signInResponse(setCookies: string[], ok = true, status = 200) {
  return {
    ok,
    status,
    headers: {
      getSetCookie: () => setCookies,
      get: (name: string) => (name === 'set-cookie' ? setCookies.join(', ') || null : null),
    },
    text: async () => 'body',
  }
}

async function loadModule(env: Record<string, string>) {
  vi.resetModules()
  vi.unstubAllEnvs()
  vi.stubEnv('PAPERCLIP_BASE_URL', 'https://paperclip.test')
  vi.stubEnv('PAPERCLIP_AUTH_EMAIL', '')
  vi.stubEnv('PAPERCLIP_AUTH_PASSWORD', '')
  vi.stubEnv('PAPERCLIP_API_KEY', '')
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  return import('./paperclipSession')
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('getPaperclipAuthHeaders', () => {
  it('throws a clear configuration error when NO auth mechanism is configured', async () => {
    const mod = await loadModule({})
    await expect(mod.getPaperclipAuthHeaders()).rejects.toThrow(/No Paperclip auth available/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses the API key as Bearer auth when only PAPERCLIP_API_KEY is set', async () => {
    const mod = await loadModule({ PAPERCLIP_API_KEY: 'pk-123' })
    await expect(mod.getPaperclipAuthHeaders()).resolves.toEqual({
      Authorization: 'Bearer pk-123',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('signs in with email/password and returns the session cookie', async () => {
    fetchMock.mockResolvedValueOnce(
      signInResponse(['__session_token=abc123; Path=/; HttpOnly', 'other=x; Path=/']),
    )
    const mod = await loadModule({
      PAPERCLIP_AUTH_EMAIL: 'Bot@Example.com',
      PAPERCLIP_AUTH_PASSWORD: 'hunter2',
    })

    const headers = await mod.getPaperclipAuthHeaders()
    expect(headers).toEqual({ Cookie: '__session_token=abc123' })

    // Sign-in request shape: POST to the auth endpoint with LOWERCASED email.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://paperclip.test/api/auth/sign-in/email')
    expect(JSON.parse(init.body)).toEqual({ email: 'bot@example.com', password: 'hunter2' })
  })

  it('caches the cookie — a second call does not sign in again', async () => {
    fetchMock.mockResolvedValue(signInResponse(['session_token=once; Path=/']))
    const mod = await loadModule({
      PAPERCLIP_AUTH_EMAIL: 'bot@example.com',
      PAPERCLIP_AUTH_PASSWORD: 'pw',
    })

    await mod.getPaperclipAuthHeaders()
    await mod.getPaperclipAuthHeaders()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('clearPaperclipSession forces a fresh sign-in on the next call', async () => {
    fetchMock.mockResolvedValue(signInResponse(['session_token=fresh; Path=/']))
    const mod = await loadModule({
      PAPERCLIP_AUTH_EMAIL: 'bot@example.com',
      PAPERCLIP_AUTH_PASSWORD: 'pw',
    })

    await mod.getPaperclipAuthHeaders()
    mod.clearPaperclipSession()
    await mod.getPaperclipAuthHeaders()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('falls back to the API key when session sign-in fails', async () => {
    // 401 is deterministic (non-retryable) so the failure is immediate.
    fetchMock.mockResolvedValueOnce(signInResponse([], false, 401))
    const mod = await loadModule({
      PAPERCLIP_AUTH_EMAIL: 'bot@example.com',
      PAPERCLIP_AUTH_PASSWORD: 'wrong',
      PAPERCLIP_API_KEY: 'pk-fallback',
    })

    await expect(mod.getPaperclipAuthHeaders()).resolves.toEqual({
      Authorization: 'Bearer pk-fallback',
    })
  })

  it('accepts non-session cookies as a fallback when no session_token is returned', async () => {
    fetchMock.mockResolvedValueOnce(signInResponse(['csrf=zzz; Path=/']))
    const mod = await loadModule({
      PAPERCLIP_AUTH_EMAIL: 'bot@example.com',
      PAPERCLIP_AUTH_PASSWORD: 'pw',
    })
    await expect(mod.getPaperclipAuthHeaders()).resolves.toEqual({ Cookie: 'csrf=zzz' })
  })

  it('deduplicates CONCURRENT sign-ins through the mutex (one fetch, both resolve)', async () => {
    let release: (v: unknown) => void = () => {}
    fetchMock.mockImplementationOnce(async () => {
      await new Promise((r) => (release = r))
      return signInResponse(['session_token=shared; Path=/'])
    })
    const mod = await loadModule({
      PAPERCLIP_AUTH_EMAIL: 'bot@example.com',
      PAPERCLIP_AUTH_PASSWORD: 'pw',
    })

    const p1 = mod.getPaperclipAuthHeaders()
    const p2 = mod.getPaperclipAuthHeaders()
    // Let the in-flight promise register before releasing the response.
    await new Promise((r) => setTimeout(r, 5))
    release(undefined)

    const [h1, h2] = await Promise.all([p1, p2])
    expect(h1).toEqual({ Cookie: 'session_token=shared' })
    expect(h2).toEqual({ Cookie: 'session_token=shared' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
