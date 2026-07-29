import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { generateKeyPairSync } from 'crypto'
import { summarizeGoogleError, remediationFor, checkSemanticBrainHealth } from './vertex-health'

/**
 * The point of this module is that "not connected" and "connected but nothing
 * indexed" must be DISTINGUISHABLE. searchSemanticBrain() returns null for both,
 * which is why nobody could tell whether semantic-brain-desktop was reachable.
 */

const realFetch = global.fetch
const ORIGINAL_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_KEY

afterEach(() => {
  global.fetch = realFetch
  if (ORIGINAL_KEY === undefined) delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  else process.env.GOOGLE_SERVICE_ACCOUNT_KEY = ORIGINAL_KEY
  vi.restoreAllMocks()
})

describe('summarizeGoogleError', () => {
  it('extracts status and message from a Google error envelope', () => {
    const body = JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'Caller lacks permission' } })
    expect(summarizeGoogleError(body)).toBe('PERMISSION_DENIED: Caller lacks permission')
  })

  it('falls back to raw text for a non-JSON body', () => {
    expect(summarizeGoogleError('<html>502 Bad Gateway</html>')).toContain('502 Bad Gateway')
  })

  it('reports an empty body rather than returning an empty string', () => {
    expect(summarizeGoogleError('')).toBe('(empty error body)')
  })

  it('bounds the length so a diagnostic cannot dump a wall of JSON', () => {
    const huge = JSON.stringify({ error: { message: 'x'.repeat(5000) } })
    expect(summarizeGoogleError(huge).length).toBeLessThanOrEqual(300)
  })
})

describe('remediationFor — each failure has a genuinely different fix', () => {
  it('403 points at IAM, not at the IDs', () => {
    expect(remediationFor(403, 'PERMISSION_DENIED: caller lacks permission')).toMatch(/discoveryengine\.viewer|IAM/i)
  })

  it('403 for a disabled API points at enabling the API', () => {
    const detail = 'Discovery Engine API has not been used in project 123 before or it is disabled'
    expect(remediationFor(403, detail)).toMatch(/services enable/i)
  })

  it('404 points at the engine ID being wrong (App ID, not datastore ID)', () => {
    expect(remediationFor(404, 'NOT_FOUND')).toMatch(/App ID/i)
  })

  it('400 points at the request shape and the datastore override', () => {
    expect(remediationFor(400, 'INVALID_ARGUMENT')).toMatch(/VERTEX_DATA_STORE_ID|request shape/i)
  })

  it('5xx is called out as transient and upstream', () => {
    expect(remediationFor(503, 'unavailable')).toMatch(/transient/i)
  })
})

describe('checkSemanticBrainHealth — config stage', () => {
  beforeEach(() => {
    global.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as typeof fetch
  })

  it('reports NOT connected, and skips later stages, with no key', async () => {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY
    const report = await checkSemanticBrainHealth()

    expect(report.healthy).toBe(false)
    expect(report.summary).toMatch(/not connected/i)
    expect(report.target.serviceAccountEmail).toBeNull()
    expect(report.stages.map(s => s.status)).toEqual(['fail', 'skipped', 'skipped'])
    expect(report.remediation).toMatch(/GOOGLE_SERVICE_ACCOUNT_KEY/)
    // No network call should have been attempted.
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('detects the .env.local.example placeholder specifically', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = 'REPLACE_ME_WITH_MINIFIED_JSON'
    const report = await checkSemanticBrainHealth()
    expect(report.stages[0].detail).toMatch(/placeholder/i)
  })

  it('reports malformed JSON with its length — the tell for a truncated secret', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = '{"client_email": "a@b.c", "private'
    const report = await checkSemanticBrainHealth()
    expect(report.healthy).toBe(false)
    expect(report.stages[0].detail).toMatch(/not valid JSON \(\d+ chars\)/)
  })

  it('names the specific fields a partial key is missing', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = JSON.stringify({ client_email: 'a@b.c' })
    const report = await checkSemanticBrainHealth()
    expect(report.stages[0].detail).toMatch(/private_key/)
    expect(report.stages[0].detail).toMatch(/token_uri/)
  })

  it('never echoes the key material into the report', async () => {
    const secret = 'SUPER-SECRET-PRIVATE-KEY-MATERIAL'
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = JSON.stringify({ client_email: 'a@b.c', private_key: secret })
    const report = await checkSemanticBrainHealth()
    expect(JSON.stringify(report)).not.toContain(secret)
  })

  it('reports the non-secret target so the operator can confirm the IDs', async () => {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY
    const report = await checkSemanticBrainHealth()
    expect(report.target.project).toBeTruthy()
    expect(report.target.engineId).toBeTruthy()
    expect(report.target.location).toBe('global')
  })
})

describe('checkSemanticBrainHealth — auth and query stages', () => {
  /**
   * A REAL RSA key, generated here. `crypto.createSign` is non-configurable so
   * it cannot be spied on; signing for real is both possible and more faithful
   * — the JWT assembly and signature path run exactly as they do in production,
   * and only the network is stubbed.
   */
  const { privateKey: REAL_PRIVATE_KEY } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })

  const GOOD_KEY = JSON.stringify({
    client_email: 'brain@semantic-brain-desktop.iam.gserviceaccount.com',
    private_key: REAL_PRIVATE_KEY,
    token_uri: 'https://oauth2.googleapis.com/token',
  })

  /** Parseable JSON whose private_key is not a usable PEM — signing throws. */
  const UNSIGNABLE_KEY = JSON.stringify({
    client_email: 'brain@semantic-brain-desktop.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n',
    token_uri: 'https://oauth2.googleapis.com/token',
  })

  /** Stub Google: token endpoint always succeeds; the engine is configurable. */
  function stubGoogle(engineResponse: () => Response) {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('oauth2.googleapis.com')) {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 })
      }
      return engineResponse()
    }) as typeof fetch
  }

  it('fails at the auth stage when the key cannot sign, and skips the query', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = UNSIGNABLE_KEY
    stubGoogle(() => new Response('{}', { status: 200 }))

    const report = await checkSemanticBrainHealth()

    expect(report.healthy).toBe(false)
    expect(report.stages.find(s => s.stage === 'auth')!.status).toBe('fail')
    expect(report.stages.find(s => s.stage === 'query')!.status).toBe('skipped')
    // The service-account identity IS reported — it is a non-secret identifier
    // and it is what tells the operator which account to fix in IAM.
    expect(report.target.serviceAccountEmail).toContain('semantic-brain-desktop')
  })

  it('reports a rejected token exchange with its HTTP status', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = GOOD_KEY
    global.fetch = vi.fn(async () => new Response(
      JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }),
      { status: 400 },
    )) as typeof fetch

    const report = await checkSemanticBrainHealth()

    expect(report.healthy).toBe(false)
    const auth = report.stages.find(s => s.stage === 'auth')!
    expect(auth.status).toBe('fail')
    expect(auth.httpStatus).toBe(400)
    expect(report.remediation).toMatch(/IAM|escaping/i)
  })

  it('reports CONNECTED with resultCount 0 when the engine serves an empty result set', async () => {
    // The distinction this whole module exists for: reaching the engine is what
    // is being tested, so no results is HEALTHY, not a failure.
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = GOOD_KEY
    stubGoogle(() => new Response(JSON.stringify({ results: [] }), { status: 200 }))

    const report = await checkSemanticBrainHealth('nuvita')

    expect(report.healthy).toBe(true)
    expect(report.resultCount).toBe(0)
    expect(report.summary).toMatch(/CONNECTED but the probe query matched nothing/)
    expect(report.remediation).toBeUndefined()
    expect(report.stages.map(s => s.status)).toEqual(['ok', 'ok', 'ok'])
  })

  it('reports CONNECTED with a result count when the engine returns documents', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = GOOD_KEY
    stubGoogle(() => new Response(
      JSON.stringify({ results: [{ document: {} }, { document: {} }] }),
      { status: 200 },
    ))

    const report = await checkSemanticBrainHealth()

    expect(report.healthy).toBe(true)
    expect(report.resultCount).toBe(2)
    expect(report.summary).toMatch(/connected and returning results/i)
  })

  it('queries the configured engine at the documented serving-config path', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = GOOD_KEY
    stubGoogle(() => new Response(JSON.stringify({ results: [] }), { status: 200 }))

    await checkSemanticBrainHealth()

    const urls = (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(c => String(c[0]))
    const engineCall = urls.find(u => u.includes('discoveryengine'))!
    expect(engineCall).toContain('/collections/default_collection/engines/')
    expect(engineCall).toContain('/servingConfigs/default_serving_config:search')
  })

  it('reports a 403 on the engine as NOT serving, with IAM remediation', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = GOOD_KEY
    stubGoogle(() => new Response(
      JSON.stringify({ error: { status: 'PERMISSION_DENIED', message: 'Caller lacks permission' } }),
      { status: 403 },
    ))

    const report = await checkSemanticBrainHealth()

    expect(report.healthy).toBe(false)
    const query = report.stages.find(s => s.stage === 'query')!
    expect(query.status).toBe('fail')
    expect(query.httpStatus).toBe(403)
    expect(report.summary).toMatch(/NOT serving/)
    expect(report.remediation).toMatch(/discoveryengine\.viewer|IAM/i)
  })

  it('reports a 404 as an ID-resolution problem', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = GOOD_KEY
    stubGoogle(() => new Response(
      JSON.stringify({ error: { status: 'NOT_FOUND', message: 'Engine not found' } }),
      { status: 404 },
    ))

    const report = await checkSemanticBrainHealth()
    expect(report.healthy).toBe(false)
    expect(report.remediation).toMatch(/App ID/i)
  })

  it('reports a network failure as unreachable, not misconfigured', async () => {
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = GOOD_KEY
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('oauth2.googleapis.com')) {
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 })
      }
      throw new Error('ETIMEDOUT')
    }) as typeof fetch

    const report = await checkSemanticBrainHealth()

    expect(report.healthy).toBe(false)
    expect(report.summary).toMatch(/NOT reachable/)
    expect(report.remediation).toMatch(/egress|network/i)
  })
})
