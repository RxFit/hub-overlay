/**
 * JEV evaluator seam — POST-RETRIEVAL ONLY, DEFAULT OFF, SHADOW-ONLY.
 *
 * A place to hand a search's hits to an external judge (JEV) for relevance
 * scoring, without letting that judge anywhere near the retrieval path:
 *
 *   - `evaluateHits` returns `{ status: 'disabled' }` unless JEV_API_KEY is
 *     set. It is the ONLY thing this module does today.
 *   - When enabled (a future PR), the evaluation is SHADOW: its verdicts are
 *     logged for comparison and never re-rank, filter or gate the hits a
 *     caller receives. The search route calls this seam after the response is
 *     assembled and never depends on its result — an evaluator outage cannot
 *     make a search fail or slow it down.
 *   - No network call is made anywhere in this module; tests need no mocks.
 *
 * JEV is usage-priced (per evaluation), which is the second reason it stays
 * shadow-only until the owner opts in: cost is a deliberate decision, not a
 * side effect of enabling a key. See docs/runbooks/vault-search.md.
 */

export interface EvaluableHit {
  vaultPath: string
  headingPath: string | null
  excerpt: string
  similarity: number
}

export interface EvaluateHitsInput {
  queryId: string
  /** Query LENGTH only — the raw query never leaves the search route. */
  queryLength: number
  hits: EvaluableHit[]
}

export type EvaluateHitsResult =
  | { status: 'disabled' }
  | { status: 'skipped'; reason: string }
  | { status: 'shadow'; queryId: string; evaluated: number }

export function isJevConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.JEV_API_KEY && env.JEV_API_KEY.trim())
}

/**
 * Evaluate a hit list. Never throws, never blocks retrieval, never calls out
 * while shadow mode is unimplemented. Returns `disabled` without a key.
 */
export function evaluateHits(input: EvaluateHitsInput, env: Record<string, string | undefined> = process.env): EvaluateHitsResult {
  if (!isJevConfigured(env)) return { status: 'disabled' }
  if (input.hits.length === 0) return { status: 'skipped', reason: 'no hits to evaluate' }
  // Shadow mode placeholder: the key is present, but the evaluator client is
  // not wired in this lane. Report what WOULD be evaluated so the log line
  // exists for the owner to size the cost before enabling for real.
  return { status: 'shadow', queryId: input.queryId, evaluated: input.hits.length }
}
