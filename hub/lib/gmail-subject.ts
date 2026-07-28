/**
 * Subject-line resolution for outgoing Gmail sends.
 *
 * Extracted from the send route so the rule is unit-testable — it looked
 * harmless inline and was not.
 *
 * ── The bug this encodes against ──
 * The route previously fell back to `Re: ${inReplyTo}` when no subject was
 * supplied on a reply. But `inReplyTo` is a **Message-ID** (the GET handler
 * populates it from the message's `Message-ID` header), not a subject — so
 * those replies went out with a subject line like
 * `Re: <CAKx8s...@mail.gmail.com>`. That is visible to the recipient, looks
 * broken, and defeats the subject-based threading some clients still fall back
 * on.
 *
 * Threading is carried by `threadId` + `In-Reply-To` + `References`, so an
 * absent subject costs nothing structurally. A caller that wants "Re: …"
 * passes the original subject explicitly — which it can, since the thread GET
 * already returns each message's real subject.
 */

/** Placeholder Gmail itself uses for a subject-less message. */
export const NO_SUBJECT = '(no subject)'

/** True when a string looks like an RFC 2822 Message-ID rather than a subject. */
export function looksLikeMessageId(value: string): boolean {
  const trimmed = value.trim()
  return /^<[^\s<>]+@[^\s<>]+>$/.test(trimmed)
}

/**
 * Resolve the Subject header for an outgoing message.
 *
 * Never derives a subject from a Message-ID. A supplied subject is used as-is;
 * anything blank falls back to the placeholder.
 */
export function resolveSubject(subject: string | undefined | null): string {
  const trimmed = (subject ?? '').trim()
  if (!trimmed) return NO_SUBJECT
  // Defensive: a caller that wires the wrong field through shouldn't be able to
  // put a Message-ID in front of a recipient.
  if (looksLikeMessageId(trimmed)) return NO_SUBJECT
  return trimmed
}
