import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { generateKeyPairSync, createVerify } from 'crypto'
import {
  _resetServiceAccountTokenCacheForTests,
  buildServiceAccountAssertion,
  mintServiceAccountToken,
  readServiceAccountKey,
  type ServiceAccountKey,
} from './google-auth'

let key: ServiceAccountKey
let publicKey: string

beforeAll(() => {
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  publicKey = pair.publicKey
  key = {
    client_email: 'hub-sync@semantic-brain-desktop.iam.gserviceaccount.com',
    private_key: pair.privateKey,
    token_uri: 'https://oauth2.googleapis.com/token',
    client_id: '1234567890',
  }
})

const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))

describe('readServiceAccountKey', () => {
  it('parses a quoted key and rejects incomplete ones', () => {
    expect(readServiceAccountKey(`'${JSON.stringify(key)}'`)?.client_id).toBe('1234567890')
    expect(readServiceAccountKey('{"client_email":"x"}')).toBeNull()
    expect(readServiceAccountKey('not json')).toBeNull()
    expect(readServiceAccountKey(undefined)).toBeNull()
  })
})

describe('buildServiceAccountAssertion', () => {
  it('signs a JWT-bearer assertion; `sub` appears only when impersonating', () => {
    const plain = buildServiceAccountAssertion(key, 'scope-a', { nowSec: 1000 })
    const [h, p, sig] = plain.split('.')
    expect(decode(h)).toEqual({ alg: 'RS256', typ: 'JWT' })
    expect(decode(p)).toEqual({ iss: key.client_email, scope: 'scope-a', aud: key.token_uri, iat: 1000, exp: 4600 })
    const verifier = createVerify('RSA-SHA256')
    verifier.update(`${h}.${p}`)
    expect(verifier.verify(publicKey, sig, 'base64url')).toBe(true)

    const delegated = buildServiceAccountAssertion(key, 'scope-a', { subject: 'danny@rxfitatx.com', nowSec: 1000 })
    expect(decode(delegated.split('.')[1]).sub).toBe('danny@rxfitatx.com')
  })
})

describe('mintServiceAccountToken', () => {
  const original = process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  const fetchSpy = vi.fn<typeof fetch>()

  beforeEach(() => {
    _resetServiceAccountTokenCacheForTests()
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY = JSON.stringify(key)
    fetchSpy.mockReset()
    vi.stubGlobal('fetch', fetchSpy)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    if (original === undefined) delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY
    else process.env.GOOGLE_SERVICE_ACCOUNT_KEY = original
  })

  it('throws `unconfigured` without a key — never a silent null', async () => {
    delete process.env.GOOGLE_SERVICE_ACCOUNT_KEY
    await expect(mintServiceAccountToken({ scope: 's' })).rejects.toMatchObject({ failure: 'unconfigured' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('caches per (scope, subject)', async () => {
    fetchSpy.mockImplementation(async () => Response.json({ access_token: 'tok', expires_in: 3600 }))
    expect(await mintServiceAccountToken({ scope: 's', subject: 'a@b.co' })).toBe('tok')
    expect(await mintServiceAccountToken({ scope: 's', subject: 'a@b.co' })).toBe('tok')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    await mintServiceAccountToken({ scope: 's' })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('carries Google\'s OAuth error — `unauthorized_client` is the missing-delegation signature', async () => {
    fetchSpy.mockImplementation(async () =>
      Response.json(
        { error: 'unauthorized_client', error_description: 'Client is unauthorized to retrieve access tokens using this method.' },
        { status: 401 },
      ),
    )
    await expect(mintServiceAccountToken({ scope: 's', subject: 'a@b.co' })).rejects.toMatchObject({
      name: 'ServiceAccountTokenError',
      failure: 'rejected',
      httpStatus: 401,
      message: expect.stringContaining('unauthorized_client'),
    })
  })

  it('a socket failure is `network`', async () => {
    fetchSpy.mockRejectedValue(new TypeError('fetch failed'))
    await expect(mintServiceAccountToken({ scope: 's' })).rejects.toMatchObject({ failure: 'network' })
  })
})
