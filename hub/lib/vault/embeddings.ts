import { breaker, CircuitOpenError } from '@/lib/circuit-breaker'
import { generateEmbedding } from '@/lib/vector-store'
import { swallow } from '@/lib/swallow'
import { VaultUnavailableError } from './errors'

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

function classify(err: unknown): VaultUnavailableError {
  if (err instanceof VaultUnavailableError) return err
  if (err instanceof CircuitOpenError) {
    return new VaultUnavailableError('embedding', 'breaker_open', 'Embedding circuit is open after repeated failures')
  }
  const message = err instanceof Error ? err.message : String(err)
  if (/no gemini api key/i.test(message)) {
    return new VaultUnavailableError('embedding', 'unconfigured', 'No Gemini API key configured for embeddings')
  }
  const aborted = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
  return new VaultUnavailableError('embedding', aborted ? 'timeout' : 'http', `Embedding request failed: ${message.slice(0, 200)}`)
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
      throw classify(err)
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
    throw classify(err)
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}
