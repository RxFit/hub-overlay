/**
 * Shape the JSON body for the chat route's top-level 500 handler. The raw
 * error message is a server-internal string (provider/stack details), so it
 * is only included as `details` outside production — production clients get
 * the generic message and operators read the real error from `log.error`.
 */
export function chatErrorBody(
  err: unknown,
  isProd: boolean,
): { error: string; details?: string } {
  if (isProd) return { error: 'Chat request failed' }
  const details = err instanceof Error ? err.message : 'Unknown error'
  return { error: 'Chat request failed', details }
}
