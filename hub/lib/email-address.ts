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
