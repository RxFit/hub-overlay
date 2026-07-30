/**
 * RFC 2822 message construction for Gmail sends (PURE — no network, no auth).
 *
 * Extracted from app/api/google/gmail/route.ts, where it was inline and
 * untested. Two of the three things it does are security-relevant, which is a
 * poor combination with "no unit tests":
 *
 *  - HEADER INJECTION. Every value interpolated into a header line must not
 *    contain CR/LF. A recipient string carrying `\r\nBcc: attacker@evil.com`
 *    would otherwise add a header, silently copying mail to a third party.
 *  - RECIPIENT VALIDATION. A malformed address should fail closed at the route
 *    rather than produce a message Gmail rejects (or worse, misroutes).
 *  - base64url ENCODING. Gmail's `raw` field is base64url, not base64; standard
 *    base64 padding and `+/` characters produce a 400.
 *
 * Pure so each of those can be tested directly, and shared so the send path and
 * the new draft path cannot drift apart in how they build a message.
 */

/**
 * Strip CR/LF from a value destined for a header line.
 *
 * Newlines are replaced with a space rather than removed, so
 * `"Subject line\r\nBcc: x"` becomes one (harmless, visibly odd) subject rather
 * than silently concatenating into `Subject linBcc: x`. Visible corruption beats
 * an invisible header.
 */
export function stripHeader(value: unknown): string {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim()
}

/**
 * Pull the bare address out of `Name <addr@host>`, or return the input trimmed.
 *
 * Kept deliberately simple; a quoted display name containing a comma
 * (`"Lopez, Maria" <m@x.com>`) is split by the caller's comma parse and will
 * fail validation. That is the fail-closed direction.
 */
export function extractEmailAddress(value: string): string {
  const angle = value.match(/<([^>]+)>/)
  return (angle ? angle[1] : value).trim()
}

const EMAIL_RE = /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/

export interface RecipientParse {
  ok: boolean
  /** Normalized, comma-joined bare addresses — safe to place in a header. */
  value: string
  /** Addresses that failed validation, for an actionable error. */
  invalid: string[]
}

/**
 * Parse and validate a comma-separated recipient list.
 *
 * Returns `ok: false` when the list is empty or ANY entry is malformed — one
 * bad address fails the whole send rather than quietly dropping a recipient the
 * user believes they included.
 */
export function parseRecipientList(to: unknown): RecipientParse {
  const parts = stripHeader(to)
    .split(',')
    .map(p => extractEmailAddress(p))
    .filter(Boolean)

  const invalid = parts.filter(p => !EMAIL_RE.test(p))
  return {
    ok: parts.length > 0 && invalid.length === 0,
    value: parts.join(', '),
    invalid,
  }
}

export interface MimeMessage {
  from: string
  to: string
  subject: string
  /** Message-ID being replied to; sets In-Reply-To and References. */
  inReplyTo?: string
  body: string
}

/** Build the RFC 2822 text of a message. Every header value is CR/LF-stripped. */
export function buildMimeMessage(msg: MimeMessage): string {
  const inReplyTo = msg.inReplyTo ? stripHeader(msg.inReplyTo) : ''

  return [
    `From: ${stripHeader(msg.from)}`,
    `To: ${stripHeader(msg.to)}`,
    `Subject: ${stripHeader(msg.subject)}`,
    // Both headers carry the same Message-ID: In-Reply-To is what threads the
    // reply, References is what keeps the conversation intact for clients that
    // build the tree from it.
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`] : []),
    'Content-Type: text/plain; charset=UTF-8',
    // The blank line is the header/body separator — without it the body is
    // parsed as more headers and the message arrives empty.
    '',
    // The BODY is deliberately not header-stripped: newlines are its content.
    msg.body,
  ].join('\r\n')
}

/**
 * Encode a message for Gmail's `raw` field.
 *
 * base64url, unpadded — Gmail rejects standard base64 (`+`, `/`, trailing `=`)
 * with a 400 that does not say why.
 */
export function toGmailRaw(mime: string): string {
  return Buffer.from(mime)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/** Build and encode in one step — what both the send and draft paths call. */
export function encodeMimeMessage(msg: MimeMessage): string {
  return toGmailRaw(buildMimeMessage(msg))
}
