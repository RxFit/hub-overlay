import { breaker, CircuitOpenError } from '@/lib/circuit-breaker'
import { parseGeminiError } from '@/lib/gemini-error'
import { EMBEDDING_MODEL, generateEmbedding } from '@/lib/vector-store'
import { swallow } from '@/lib/swallow'
import { classifyHttpStatus, VaultUnavailableError, type VaultFailureReason } from './errors'

/**
 * Embedding calls for the vault corpus, behind their own circuit.
 *
 * Same model and dimensionality as everything else (lib/vector-store's
 * EMBEDDING_MODEL / 768 dims) — the vault index must live in the SAME vector
 * space as the query embedding, and lib/vector-store is the one place that
 * decides which space that is. Only the failure contract differs: every
 * failure REJECTS with VaultUnavailableError (stage 'embedding') so the
 * `vault-embeddings` circuit sees it, and so a search never reports an
 * embedding outage as "no matches".
 *
 * The key is separate from any other breaker key on purpose: an embedding
 * outage during a sync must not open a circuit that the chat path relies on,
 * and vice versa.
 */

export const VAULT_EMBEDDINGS_BREAKER_KEY = 'vault-embeddings'

export type EmbedFn = (text: string, opts?: { signal?: AbortSignal }) => Promise<number[]>

/**
 * Gemini's own ErrorInfo reasons that mean "the API key was rejected": the
 * canonical API_KEY_INVALID plus the key-restriction family
 * (API_KEY_SERVICE_BLOCKED, API_KEY_HTTP_REFERRER_BLOCKED, API_KEY_IP_ADDRESS_BLOCKED, …).
 * A 400 is promoted to `auth` ONLY on one of these — never on the wording of
 * the sentence, so a request-shape or billing 400 that happens to mention a
 * key is not misreported as a credential problem.
 */
const KEY_REJECTED_REASON = /^API_KEY(_|$)/

/**
 * Google's exact sentence for a bad key. Used only when the response carried
 * no details at all (older/intermediate proxies), so the classification still
 * lands where an operator can act on it.
 */
const KEY_REJECTED_SENTENCE = /^API key not valid\./i

const NETWORK_MESSAGE = /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up|network/i

/**
 * Map whatever the embedding call threw to the vault failure contract, keeping
 * the provider's status and reason FIRST in the message so a 200-char bound
 * still names the cause:
 *
 *   Gemini embedContent (gemini-embedding-2) answered HTTP 400 API_KEY_INVALID: API key not valid. …
 *
 * reason: 401/403, or a 400 whose ErrorInfo reason is API_KEY_* → `auth` (OUR
 * upstream credential was rejected — nothing the caller sent); 404 →
 * `not_found` (the model id is unknown to the API for embedContent); any other
 * status → `http` with the status attached; no status → `network`, `timeout`,
 * `unconfigured` or `breaker_open` by cause. Never carries the key or the text
 * being embedded.
 */
export function classifyEmbeddingError(err: unknown): VaultUnavailableError {
  if (err instanceof VaultUnavailableError) return err
  if (err instanceof CircuitOpenError) {
    return new VaultUnavailableError('embedding', 'breaker_open', 'Embedding circuit is open after repeated failures')
  }
  const raw = err instanceof Error ? err.message : String(err)
  if (/no gemini api key/i.test(raw)) {
    return new VaultUnavailableError('embedding', 'unconfigured', 'No Gemini API key configured for embeddings')
  }
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return new VaultUnavailableError('embedding', 'timeout', `Embedding request failed: ${raw.slice(0, 200)}`)
  }

  const provider = parseGeminiError(err)
  if (provider.status !== null) {
    const { status, reason: code, message: said } = provider
    const summary = `Gemini embedContent (${EMBEDDING_MODEL}) answered HTTP ${status}${code ? ` ${code}` : ''}${said ? `: ${said}` : ''}`
    let reason: VaultFailureReason = classifyHttpStatus(status)
    if (status === 400 && (code ? KEY_REJECTED_REASON.test(code) : KEY_REJECTED_SENTENCE.test(said))) reason = 'auth'
    return new VaultUnavailableError('embedding', reason, summary, status)
  }

  const reason: VaultFailureReason = NETWORK_MESSAGE.test(provider.message) ? 'network' : 'http'
  return new VaultUnavailableError('embedding', reason, `Embedding request failed: ${provider.message || raw.slice(0, 200)}`)
}

/**
 * Embed one text under the vault circuit. If `signal` aborts first, the call
 * rejects with a `timeout` — the underlying request is left to finish on its
 * own (the SDK offers no cancellation hook) and its result is discarded.
 */
export const embedForVault: EmbedFn = async (text, opts) => {
  const signal = opts?.signal
  if (signal?.aborted) throw new VaultUnavailableError('embedding', 'timeout', 'Deadline already expired before embedding')

  const work = breaker.execute(VAULT_EMBEDDINGS_BREAKER_KEY, () => generateEmbedding(text))
  if (!signal) {
    try {
      return await work
    } catch (err) {
      throw classifyEmbeddingError(err)
    }
  }

  let onAbort: (() => void) | null = null
  const abortP = new Promise<never>((_, reject) => {
    onAbort = () => reject(new VaultUnavailableError('embedding', 'timeout', 'Deadline expired while embedding'))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([work, abortP])
  } catch (err) {
    // Whichever branch lost the race may still settle later; keep it quiet.
    void work.catch((late: unknown) => swallow(late, { module: 'vault-embeddings', op: 'lateRejection', severity: 'expected' }))
    throw classifyEmbeddingError(err)
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}
