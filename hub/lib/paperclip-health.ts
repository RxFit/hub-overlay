/**
 * Error classification for the /api/admin/paperclip-health probe.
 *
 * Maps a thrown error from the Paperclip client stack (paperclipSession sign-in,
 * paperclipFetch, circuit breaker) onto a short actionable class an admin can
 * act on without reading Cloud Logging.
 */
export function classifyPaperclipError(err: unknown): string {
  const name = err instanceof Error ? err.name : ''
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  if (name === 'CircuitOpenError' || msg.includes('circuit open')) return 'circuit-open'
  if (name === 'PaperclipSchemaError' || msg.includes('schema mismatch')) return 'schema'
  if (msg.includes('no paperclip auth available')) return 'no-credentials'
  if (/(^|\D)(401|403)(\D|$)/.test(msg) || msg.includes('sign-in failed')) return 'auth'
  const httpMatch = msg.match(/paperclip api error (\d{3})/)
  if (httpMatch) return `http-${httpMatch[1]}`
  if (
    msg.includes('fetch failed') || msg.includes('econnrefused') ||
    msg.includes('enotfound') || msg.includes('etimedout') ||
    msg.includes('abort') || msg.includes('timeout') || msg.includes('socket')
  ) return 'network'
  return 'unknown'
}

/** Bound raw error text for the admin-only JSON response. */
export function truncatePaperclipError(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300)
}
