import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  encryptSecret,
  decryptSecret,
  encryptionConfigured,
  activeKeyId,
  SecretCryptoError,
} from './secret-crypto'

/* ════════════════════════════════════════════════════════════════════════════
   At-rest credential encryption.

   The properties under test are the ones whose failure is SILENT in
   production: this store has no read path, so a key mistake surfaces as
   "✓ Set" over garbage rather than as an error anyone sees.
   ════════════════════════════════════════════════════════════════════════════ */

const KEY_A = 'v1:' + Buffer.alloc(32, 1).toString('base64')
const KEY_B = 'v2:' + Buffer.alloc(32, 2).toString('base64')

describe('secret-crypto', () => {
  beforeEach(() => {
    vi.stubEnv('SECRET_ENCRYPTION_KEY', KEY_A)
    vi.stubEnv('SECRET_ENCRYPTION_KEYS_PREVIOUS', '')
    vi.stubEnv('NEXTAUTH_SECRET', 'a-totally-different-session-secret')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('round-trips a credential', () => {
    const { envelope, keyId } = encryptSecret('sk_live_abc123')
    expect(keyId).toBe('v1')
    expect(decryptSecret(envelope)).toBe('sk_live_abc123')
  })

  it('never stores the plaintext in the envelope', () => {
    const { envelope } = encryptSecret('sk_live_SUPERSECRET')
    expect(envelope).not.toContain('sk_live_SUPERSECRET')
    expect(envelope).not.toContain('SUPERSECRET')
    // Also not recoverable by naive base64 decoding of any segment.
    for (const part of envelope.split('.')) {
      expect(Buffer.from(part, 'base64url').toString('utf8')).not.toContain('SUPERSECRET')
    }
  })

  it('produces a different ciphertext each time (random iv)', () => {
    const a = encryptSecret('same-value').envelope
    const b = encryptSecret('same-value').envelope
    expect(a).not.toBe(b)
    expect(decryptSecret(a)).toBe(decryptSecret(b))
  })

  it('stamps the key id into the envelope so rotation is recoverable', () => {
    const { envelope } = encryptSecret('value')
    expect(envelope.split('.')[0]).toBe('v1')
    expect(activeKeyId()).toBe('v1')
  })

  /* The scenario that motivates the whole design: the runbook's documented
     rotation (`gcloud secrets versions add` + key:latest) swaps the key under
     existing rows. With the retired key listed, they still open. */
  it('decrypts rows written under a retired key after rotation', () => {
    const old = encryptSecret('written-before-rotation').envelope

    vi.stubEnv('SECRET_ENCRYPTION_KEY', KEY_B)
    vi.stubEnv('SECRET_ENCRYPTION_KEYS_PREVIOUS', KEY_A)

    expect(decryptSecret(old)).toBe('written-before-rotation')
    // New writes use the new key.
    expect(encryptSecret('after').keyId).toBe('v2')
  })

  it('reports the missing key by id when the retired key was NOT kept', () => {
    const old = encryptSecret('orphaned').envelope
    vi.stubEnv('SECRET_ENCRYPTION_KEY', KEY_B)
    vi.stubEnv('SECRET_ENCRYPTION_KEYS_PREVIOUS', '')

    expect(() => decryptSecret(old)).toThrow(/No key available for key id "v1"/)
  })

  /* Fail closed. The house convention for an unset optional secret is to
     no-op; here that would mean plaintext credentials in Postgres. */
  it('refuses to encrypt when no key is configured', () => {
    vi.stubEnv('SECRET_ENCRYPTION_KEY', '')
    expect(() => encryptSecret('value')).toThrow(SecretCryptoError)
    expect(() => encryptSecret('value')).toThrow(/refusing to store credentials unencrypted/i)
    expect(encryptionConfigured()).toBe(false)
  })

  it('refuses to reuse NEXTAUTH_SECRET as the at-rest key', () => {
    const shared = Buffer.alloc(32, 7)
    vi.stubEnv('NEXTAUTH_SECRET', shared.toString('utf8'))
    vi.stubEnv('SECRET_ENCRYPTION_KEY', 'v1:' + shared.toString('base64'))

    expect(() => encryptSecret('value')).toThrow(/must not be NEXTAUTH_SECRET/)
    expect(encryptionConfigured()).toBe(false)
  })

  it('rejects key material that is not exactly 32 bytes', () => {
    vi.stubEnv('SECRET_ENCRYPTION_KEY', 'v1:' + Buffer.alloc(16, 1).toString('base64'))
    expect(() => encryptSecret('value')).toThrow(/exactly 32 bytes/)
  })

  it('rejects a key spec with no key id', () => {
    vi.stubEnv('SECRET_ENCRYPTION_KEY', Buffer.alloc(32, 1).toString('base64'))
    expect(() => encryptSecret('value')).toThrow(/must be formatted/)
  })

  it('rejects a tampered ciphertext rather than returning garbage', () => {
    const { envelope } = encryptSecret('trusted-value')
    const [id, iv, tag, ct] = envelope.split('.')
    const flipped = Buffer.from(ct, 'base64url')
    flipped[0] ^= 0xff
    const tampered = [id, iv, tag, flipped.toString('base64url')].join('.')

    expect(() => decryptSecret(tampered)).toThrow(/failed authentication/)
  })

  it('rejects a malformed envelope', () => {
    expect(() => decryptSecret('not-an-envelope')).toThrow(/Malformed secret envelope/)
    expect(() => decryptSecret('v1.aaa.bbb')).toThrow(/Malformed secret envelope/)
  })

  it('refuses to encrypt an empty value', () => {
    expect(() => encryptSecret('')).toThrow(/empty value/)
  })

  it('round-trips unicode and long values intact', () => {
    const value = '🔐 ключ ' + 'x'.repeat(4096)
    expect(decryptSecret(encryptSecret(value).envelope)).toBe(value)
  })
})
