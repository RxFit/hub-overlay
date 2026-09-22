/**
 * Read a Gemini API failure the way an operator needs it: status, Google's
 * machine-readable reason, and the provider's own sentence — in that order.
 *
 * @google/generative-ai (0.24, the installed SDK) throws a
 * GoogleGenerativeAIFetchError for any non-2xx whose message is
 *   `[GoogleGenerativeAI Error]: Error fetching from <url>: [400 Bad Request] <sentence> <details JSON>`
 * with the same facts also on the object: `status`, `statusText` and
 * `errorDetails` (the response's `error.details[]`, whose google.rpc.ErrorInfo
 * entry carries `reason`, e.g. API_KEY_INVALID). ~185 chars of that message are
 * framing, so any bounded field (a health detail, a ledger column, a fault
 * report) that stores the raw message loses the part that says WHY — which is
 * how a production probe came to report only "HTTP 400" for gemini-embedding-2.
 *
 * Shared by every consumer of lib/vector-store's embedding request: its error
 * log carries the parsed summary, and lib/vault/embeddings.ts maps it onto the
 * vault failure contract. Duck-typed rather than `instanceof` so it also reads
 * the SDK's transport wrapper (no status) and errors from another module copy.
 * Never includes the API key or the text that was being embedded.
 */

export interface GeminiErrorSummary {
  /** HTTP status the provider answered with, or null when it never answered (DNS/TLS/socket). */
  status: number | null
  /** google.rpc.ErrorInfo.reason from the response details, when present (API_KEY_INVALID, …). */
  reason: string | null
  /** The provider's own sentence, without the SDK framing; bounded. */
  message: string
}

/** Bound on the provider's sentence — enough for Google's longest standard messages. */
export const GEMINI_MESSAGE_MAX = 160

/** The first google.rpc.ErrorInfo `reason` in the provider's details, if any. */
export function geminiReasonCode(details: unknown): string | null {
  if (!Array.isArray(details)) return null
  for (const entry of details) {
    if (entry && typeof entry === 'object') {
      const reason = (entry as Record<string, unknown>).reason
      if (typeof reason === 'string' && reason) return reason
    }
  }
  return null
}

/**
 * The provider's own sentence, without the SDK's framing: the
 * `[GoogleGenerativeAI Error]: ` tag, the `Error fetching from <url>: ` line,
 * the `[400 Bad Request] ` status tag and the trailing details JSON array.
 * A message that carries none of them is returned unchanged (whitespace folded).
 */
export function geminiProviderMessage(raw: string): string {
  return raw
    .replace(/^\[GoogleGenerativeAI Error\]:\s*/, '')
    .replace(/^Error fetching from \S+:\s*/, '')
    .replace(/^\[\d{3}[^\]]*\]\s*/, '')
    .replace(/\s*\[\{[\s\S]*\}\]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function parseGeminiError(err: unknown): GeminiErrorSummary {
  const raw = err instanceof Error ? err.message : String(err)
  const bag = err instanceof Error ? (err as Error & { status?: unknown; errorDetails?: unknown }) : null
  const status = bag && typeof bag.status === 'number' ? bag.status : null
  return {
    status,
    reason: bag ? geminiReasonCode(bag.errorDetails) : null,
    message: geminiProviderMessage(raw).slice(0, GEMINI_MESSAGE_MAX),
  }
}
