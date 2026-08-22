/**
 * At-rest encryption for Hub-managed third-party credentials.
 *
 * WHY THIS EXISTS
 * The Hub previously stored operator-entered API keys in Paperclip's Secrets
 * API. Paperclip is retired (AGENTS.md), so the Hub owns this storage now —
 * and it had no symmetric-encryption facility of any kind. Every other
 * node:crypto use in this repo is hashing, HMAC, or timingSafeEqual; this is
 * the first cipher. Read the whole header before changing it.
 *
 * ENVELOPE FORMAT — `<keyId>.<iv>.<authTag>.<ciphertext>`, all base64url.
 * The key id is INSIDE the stored value on purpose. deploy-runbook.md
 * documents `gcloud secrets versions add` + `key: latest` as *the* rotation
 * procedure; applied to the encryption key that silently makes every stored
 * ciphertext undecryptable. With a key id in the envelope a reader can say
 * *which* key a row needs, rows on a retired key are a query (`key_id`), and
 * a rotation becomes a migration instead of a data-loss event. Retrofitting
 * this later would require dual-read plumbing, so it lands on day one.
 *
 * FAILS CLOSED. The house convention for an unset optional secret is to
 * no-op (see lib/kpi-sources/stripe.ts). That convention is WRONG here: it
 * would silently write operator credentials to Postgres in plaintext, and
 * because no request path reads values back, nothing would ever surface it.
 * Missing or malformed key material throws instead.
 *
 * LAZY ENV READS. Every key read happens inside a function. `next build`
 * imports route and lib modules with no secrets present (see the Build step
 * in .github/workflows/ci.yml and the lazy-init note in lib/db.ts), so a
 * module-scope `process.env.X!` here would break the build, not just runtime.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12          // GCM standard nonce length
const KEY_BYTES = 32         // AES-256
const AUTH_TAG_BYTES = 16

/** Primary key used for all new writes. Format: `<keyId>:<base64 32 bytes>`. */
const PRIMARY_ENV = 'SECRET_ENCRYPTION_KEY'
/** Optional comma-separated retired keys, same format — read-only, for rotation. */
const PREVIOUS_ENV = 'SECRET_ENCRYPTION_KEYS_PREVIOUS'

export class SecretCryptoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SecretCryptoError'
  }
}

interface KeyEntry {
  id: string
  key: Buffer
}

/** Parse one `<keyId>:<base64>` spec into usable key material. */
function parseKeySpec(spec: string, source: string): KeyEntry {
  const trimmed = spec.trim()
  const sep = trimmed.indexOf(':')
  if (sep <= 0) {
    throw new SecretCryptoError(
      `${source} must be formatted "<keyId>:<base64-encoded 32 bytes>" (e.g. "v1:BASE64…"). The key id is required so stored values remain decryptable across a key rotation.`,
    )
  }

  const id = trimmed.slice(0, sep)
  // The id is a structural part of the envelope; '.' would break parsing.
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new SecretCryptoError(`${source} key id "${id}" must match [A-Za-z0-9_-]+.`)
  }

  let key: Buffer
  try {
    key = Buffer.from(trimmed.slice(sep + 1), 'base64')
  } catch {
    throw new SecretCryptoError(`${source} key material is not valid base64.`)
  }
  if (key.length !== KEY_BYTES) {
    throw new SecretCryptoError(
      `${source} key material must decode to exactly ${KEY_BYTES} bytes (got ${key.length}). Generate one with: openssl rand -base64 32`,
    )
  }
  return { id, key }
}

/**
 * Refuse to reuse NEXTAUTH_SECRET as the data-at-rest key.
 *
 * lib/gateToken.ts:27-30 deliberately falls back to NEXTAUTH_SECRET, with a
 * comment explaining that it avoids a new env var. That is fine for a signing
 * secret on a 5-minute token and catastrophic for data at rest: the runbook
 * documents rotating NEXTAUTH_SECRET as routine, and each rotation would
 * orphan every stored credential. House style invites this mistake, so the
 * refusal is enforced in code rather than left to review.
 */
function assertNotSessionSecret(entry: KeyEntry): void {
  const nextAuth = process.env.NEXTAUTH_SECRET
  if (!nextAuth) return
  const candidate = Buffer.from(nextAuth, 'utf8')
  if (candidate.length === entry.key.length && timingSafeEqual(candidate, entry.key)) {
    throw new SecretCryptoError(
      'SECRET_ENCRYPTION_KEY must not be NEXTAUTH_SECRET. NEXTAUTH_SECRET is documented as routinely rotatable; reusing it would make every stored credential undecryptable on the next session-secret rotation.',
    )
  }
}

/** Primary (write) key. Throws when unset — this store fails closed. */
function primaryKey(): KeyEntry {
  const raw = process.env[PRIMARY_ENV]
  if (!raw || !raw.trim()) {
    throw new SecretCryptoError(
      `${PRIMARY_ENV} is not set. Hub-managed credential storage is disabled until it is provisioned — refusing to store credentials unencrypted.`,
    )
  }
  const entry = parseKeySpec(raw, PRIMARY_ENV)
  assertNotSessionSecret(entry)
  return entry
}

/** Every key available for DECRYPTION, newest first. */
function decryptionKeys(): KeyEntry[] {
  const keys = [primaryKey()]
  const previous = process.env[PREVIOUS_ENV]
  if (previous?.trim()) {
    for (const spec of previous.split(',')) {
      if (spec.trim()) keys.push(parseKeySpec(spec, PREVIOUS_ENV))
    }
  }
  return keys
}

/**
 * True when credential storage is usable. Lets callers render an honest
 * "not configured" state instead of surfacing a 500 — without ever falling
 * back to storing plaintext.
 */
export function encryptionConfigured(): boolean {
  try {
    primaryKey()
    return true
  } catch {
    return false
  }
}

/** The key id new writes will be sealed under (for the `key_id` column). */
export function activeKeyId(): string {
  return primaryKey().id
}

/** Seal a credential. Returns the full envelope to persist. */
export function encryptSecret(plaintext: string): { envelope: string; keyId: string } {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new SecretCryptoError('Refusing to encrypt an empty value.')
  }
  const { id, key } = primaryKey()
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()

  const envelope = [
    id,
    iv.toString('base64url'),
    authTag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.')
  return { envelope, keyId: id }
}

/**
 * Open a sealed credential. Server-only — no API route returns this, and none
 * should; the browser contract is write-only. GCM authentication means a
 * tampered row throws rather than yielding attacker-chosen plaintext.
 */
export function decryptSecret(envelope: string): string {
  const parts = envelope.split('.')
  if (parts.length !== 4) {
    throw new SecretCryptoError('Malformed secret envelope (expected "<keyId>.<iv>.<tag>.<ciphertext>").')
  }
  const [keyId, ivB64, tagB64, ctB64] = parts

  const match = decryptionKeys().find((k) => k.id === keyId)
  if (!match) {
    throw new SecretCryptoError(
      `No key available for key id "${keyId}". If the encryption key was rotated, the retired key must be listed in ${PREVIOUS_ENV} until every row is re-sealed.`,
    )
  }

  const iv = Buffer.from(ivB64, 'base64url')
  const authTag = Buffer.from(tagB64, 'base64url')
  if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
    throw new SecretCryptoError('Malformed secret envelope (bad iv or auth tag length).')
  }

  const decipher = createDecipheriv(ALGORITHM, match.key, iv)
  decipher.setAuthTag(authTag)
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, 'base64url')),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    // Wrong key or tampered ciphertext — never leak which.
    throw new SecretCryptoError('Secret failed authentication and could not be decrypted.')
  }
}
