/**
 * Extract the bare address from an RFC-2822 From/To header value. Gmail
 * returns headers like `Acme Billing <billing@acme.com>`; anything we feed
 * back into a `To:` line (or validate as a recipient) needs just the
 * angle-bracketed address. Plain addresses pass through unchanged.
 */
export function extractEmail(fromHeader: string): string {
  const m = fromHeader.match(/<([^>]+)>/)
  return (m ? m[1] : fromHeader).trim()
}

/**
 * Build the Subject line for a reply. Prefixes `Re: ` when the original
 * subject does not already start with a (case-insensitive) `Re:`, so replies
 * never end up doubled (`Re: Re: …`). An empty/whitespace-only subject yields
 * `Re: (no subject)`. Feeding a real subject here keeps the Gmail send route
 * from falling back to stamping the Message-ID as the subject.
 */
export function replySubject(original: string): string {
  const trimmed = (original ?? '').trim()
  if (!trimmed) return 'Re: (no subject)'
  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`
}
