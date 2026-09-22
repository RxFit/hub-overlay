import { describe, it, expect, beforeEach } from 'vitest'
import {
  authenticateSearchBearer,
  bearerToken,
  constantTimeEquals,
  describeSearchKeys,
  isSyncKeyConfigured,
  parseSearchKeys,
  verifySyncBearer,
  _resetSearchKeyCacheForTests,
} from './auth'

const KEY_A = 'instinct-key-0123456789abcdef'
const KEY_B = 'claude-code-key-fedcba9876543210'
const KEYS = JSON.stringify({
  [KEY_A]: { harness: 'instinct', tenantId: 'rxfit' },
  [KEY_B]: { harness: 'claude-code', tenantId: 'rxfit' },
})

beforeEach(() => _resetSearchKeyCacheForTests())

describe('bearerToken / constantTimeEquals', () => {
  it('extracts the token case-insensitively and rejects other schemes', () => {
    expect(bearerToken('Bearer abc')).toBe('abc')
    expect(bearerToken('bearer abc')).toBe('abc')
    expect(bearerToken('Basic abc')).toBeNull()
    expect(bearerToken('Bearer')).toBeNull()
    expect(bearerToken(null)).toBeNull()
  })

  it('compares in constant time and is false on any length mismatch', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true)
    expect(constantTimeEquals('abc', 'abd')).toBe(false)
    expect(constantTimeEquals('abc', 'abcd')).toBe(false)
    expect(constantTimeEquals('', '')).toBe(true)
  })
})

describe('verifySyncBearer — fails closed', () => {
  const env = { VAULT_SYNC_API_KEY: 'sync-key-0123456789abcdef' }

  it('accepts exactly the configured key', () => {
    expect(verifySyncBearer(`Bearer ${env.VAULT_SYNC_API_KEY}`, env)).toBe(true)
  })

  it('rejects a wrong key of the same length, a different length, a missing header and an unset secret', () => {
    expect(verifySyncBearer('Bearer sync-key-0123456789abcdeX', env)).toBe(false)
    expect(verifySyncBearer('Bearer nope', env)).toBe(false)
    expect(verifySyncBearer(null, env)).toBe(false)
    expect(verifySyncBearer('Bearer ', {})).toBe(false)
    expect(verifySyncBearer('Bearer x', { VAULT_SYNC_API_KEY: '' })).toBe(false)
  })

  it('refuses a configured key that is too short to be a credential', () => {
    expect(verifySyncBearer('Bearer short', { VAULT_SYNC_API_KEY: 'short' })).toBe(false)
    expect(isSyncKeyConfigured({ VAULT_SYNC_API_KEY: 'short' })).toBe(false)
    expect(isSyncKeyConfigured(env)).toBe(true)
  })
})

describe('parseSearchKeys', () => {
  it('parses the key → {harness, tenantId} map', () => {
    const parsed = parseSearchKeys(KEYS)
    expect(parsed.malformed).toBe(false)
    expect(parsed.rejected).toBe(0)
    expect(parsed.bindings.get(KEY_A)).toEqual({ harness: 'instinct', tenantId: 'rxfit' })
    expect(parsed.bindings.size).toBe(2)
  })

  it('is empty (fail closed) when unset, malformed JSON, or not an object', () => {
    expect(parseSearchKeys(undefined).bindings.size).toBe(0)
    expect(parseSearchKeys('{not json').malformed).toBe(true)
    expect(parseSearchKeys('[1,2]').malformed).toBe(true)
    expect(parseSearchKeys('"str"').malformed).toBe(true)
  })

  it('drops weak keys and malformed bindings, counting them', () => {
    const parsed = parseSearchKeys(JSON.stringify({
      short: { harness: 'a', tenantId: 'rxfit' },
      [KEY_A]: { harness: 'Bad Harness!', tenantId: 'rxfit' },
      [KEY_B]: { harness: 'ok', tenantId: '' },
      ['x'.repeat(20)]: { harness: 'hermes', tenantId: 'rxfit' },
      ['y'.repeat(20)]: null,
    }))
    expect(parsed.rejected).toBe(4)
    expect([...parsed.bindings.values()]).toEqual([{ harness: 'hermes', tenantId: 'rxfit' }])
  })

  it('memoizes on the raw string', () => {
    const a = parseSearchKeys(KEYS)
    const b = parseSearchKeys(KEYS)
    expect(a).toBe(b)
    expect(parseSearchKeys(KEYS + ' ')).toBe(a) // trimmed
  })
})

describe('authenticateSearchBearer', () => {
  const env = { VAULT_SEARCH_KEYS: KEYS }

  it('resolves a known key to its bound harness + tenant', () => {
    expect(authenticateSearchBearer(`Bearer ${KEY_B}`, env)).toEqual({ harness: 'claude-code', tenantId: 'rxfit', via: 'bearer' })
  })

  it('returns null for a wrong key (same length), a missing header, or no configured keys', () => {
    expect(authenticateSearchBearer(`Bearer ${KEY_A.slice(0, -1)}X`, env)).toBeNull()
    expect(authenticateSearchBearer(null, env)).toBeNull()
    expect(authenticateSearchBearer(`Bearer ${KEY_A}`, {})).toBeNull()
    expect(authenticateSearchBearer(`Bearer ${KEY_A}`, { VAULT_SEARCH_KEYS: '{oops' })).toBeNull()
  })
})

describe('describeSearchKeys', () => {
  it('reports presence and counts only', () => {
    expect(describeSearchKeys({ VAULT_SEARCH_KEYS: KEYS })).toEqual({ configured: true, count: 2, rejected: 0, malformed: false })
    expect(describeSearchKeys({})).toEqual({ configured: false, count: 0, rejected: 0, malformed: false })
    expect(describeSearchKeys({ VAULT_SEARCH_KEYS: 'nope' })).toMatchObject({ configured: false, malformed: true })
  })
})
