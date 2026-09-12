import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateKeyPairSync } from 'crypto'

/**
 * Locks searchSemanticBrain's FAILURE CONTRACT.
 *
 * Every failure mode used to `return null`. Callers wrap the call in
 * `breaker.execute('vertex-ai', …)`, and CircuitBreaker counts a failure only
 * when the wrapped fn REJECTS — it resets `failures = 0` on any resolved value.
 * A `null` return is a resolved value, so every Vertex failure was scored as a
 * SUCCESS and reset the counter: the `vertex-ai` circuit could never open and the
 * CircuitOpenError handlers in app/api/chat/route.ts were dead code.
 *
 * lib/exa.ts:37-43 documents the identical defect being fixed for searchWeb; it
 * was never back-ported here. These tests are the back-port's guard rail.
 *
 * The distinction that must NOT collapse: unavailability REJECTS, a search that
 * genuinely matched nothing resolves to []. Reporting unavailability as "zero
 * matches" is what made the model tell users their own documents don't exist.
 */

// A real keypair so the production JWT-signing path actually runs.
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})

const SA_KEY = JSON.stringify({
  client_email: 'hub@semantic-brain-desktop.iam.gserviceaccount.com',
  private_key: privateKey as unknown as string,
  token_uri: 'https://oauth2.example/token',
})

const TOKEN_URI = 'https://oauth2.example/token'
const isTokenUrl = (url: unknown) => String(url) === TOKEN_URI

function tokenOk() {
  return { ok: true, status: 200, json: async () => ({ access_token: 'at-123', expires_in: 3600 }) }
}

/** Fresh module per test — getAccessToken memoizes the token at module scope. */
async function freshVertex() {
  vi.resetModules()
  return import('./vertex')
}

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  process.env.GOOGLE_SERVICE_ACCOUNT_KEY = SA_KEY
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY
})

describe('searchSemanticBrain — unavailability REJECTS so the circuit breaker can see it', () => {
  it('throws (not null) when no service account is configured', async () => {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY
    const { searchSemanticBrain, VertexUnavailableError } = await freshVertex()

    await expect(searchSemanticBrain('q')).rejects.toBeInstanceOf(VertexUnavailableError)
    await expect(searchSemanticBrain('q')).rejects.toMatchObject({ reason: 'unconfigured' })
    expect(fetchMock).not.toHaveBeenCalled() // never dials an upstream it cannot authenticate to
  })

  it('throws with the status when Discovery Engine returns a non-2xx', async () => {
    fetchMock.mockImplementation(async (url: unknown) =>
      isTokenUrl(url)
        ? tokenOk()
        : { ok: false, status: 403, text: async () => 'PERMISSION_DENIED: caller lacks permission' },
    )
    const { searchSemanticBrain, VertexUnavailableError } = await freshVertex()

    const err = await searchSemanticBrain('q').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(VertexUnavailableError)
    expect(err).toMatchObject({ reason: 'http', status: 403 })
    expect((err as Error).message).toContain('PERMISSION_DENIED')
  })

  it('throws when the service-account token exchange fails', async () => {
    fetchMock.mockImplementation(async (url: unknown) =>
      isTokenUrl(url) ? { ok: false, status: 401, json: async () => ({}) } : tokenOk(),
    )
    const { searchSemanticBrain, VertexUnavailableError } = await freshVertex()

    const err = await searchSemanticBrain('q').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(VertexUnavailableError)
    expect(err).toMatchObject({ reason: 'auth', status: 401 })
  })

  it('throws on a network/abort failure', async () => {
    fetchMock.mockImplementation(async (url: unknown) => {
      if (isTokenUrl(url)) return tokenOk()
      const e = new Error('The operation was aborted')
      e.name = 'TimeoutError'
      throw e
    })
    const { searchSemanticBrain, VertexUnavailableError } = await freshVertex()

    const err = await searchSemanticBrain('q').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(VertexUnavailableError)
    expect(err).toMatchObject({ reason: 'network' })
  })
})

describe('searchSemanticBrain — a search that genuinely matched nothing is NOT a failure', () => {
  it('resolves to [] when the engine returns no results', async () => {
    fetchMock.mockImplementation(async (url: unknown) =>
      isTokenUrl(url) ? tokenOk() : { ok: true, status: 200, json: async () => ({ results: [] }) },
    )
    const { searchSemanticBrain } = await freshVertex()

    // The whole point of the contract: empty resolves, so the breaker counts it
    // as the success it is and the prompt says "no matches", not "unavailable".
    await expect(searchSemanticBrain('q')).resolves.toEqual([])
  })

  it('maps documents, preferring extractive answers over snippets', async () => {
    fetchMock.mockImplementation(async (url: unknown) =>
      isTokenUrl(url)
        ? tokenOk()
        : {
            ok: true,
            status: 200,
            json: async () => ({
              results: [{
                document: {
                  derivedStructData: {
                    title: 'Intake SOP',
                    link: 'https://drive.example/1',
                    snippets: [{ snippet: 'snippet text' }],
                    extractive_answers: [{ content: 'the answer' }],
                  },
                },
              }],
            }),
          },
    )
    const { searchSemanticBrain } = await freshVertex()

    const out = await searchSemanticBrain('q')
    expect(out).toHaveLength(1)
    expect(out[0].title).toBe('Intake SOP')
    expect(out[0].uri).toBe('https://drive.example/1')
    expect(out[0].snippet).toContain('the answer')
    expect(out[0].source).toBe('vertex-ai')
  })
})

describe('searchSemanticBrain — the caller owns the deadline', () => {
  it('passes the caller signal to BOTH the token exchange and the search', async () => {
    fetchMock.mockImplementation(async (url: unknown) =>
      isTokenUrl(url) ? tokenOk() : { ok: true, status: 200, json: async () => ({ results: [] }) },
    )
    const { searchSemanticBrain } = await freshVertex()

    const ctrl = new AbortController()
    await searchSemanticBrain('q', undefined, ctrl.signal)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const [, init] of fetchMock.mock.calls) {
      // The token exchange previously passed NO signal at all — it was the one
      // unbounded hop in a branch its caller believed was capped.
      expect((init as RequestInit).signal).toBe(ctrl.signal)
    }
  })

  it('defaults to a bound no larger than the chat caller applies', async () => {
    const { VERTEX_SEARCH_MS, EXA_VERTEX_BRANCH_MS } = await import('./timeout-config')
    // An inner bound ABOVE the caller's is unreachable by construction: the
    // caller's withTimeout resolves its fallback first and this fetch keeps
    // running, unobserved. It was 10_000 against an 8_000 caller bound.
    expect(VERTEX_SEARCH_MS).toBeLessThanOrEqual(EXA_VERTEX_BRANCH_MS)
  })
})
