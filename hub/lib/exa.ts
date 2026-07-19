import Exa from 'exa-js'

/* ── Lazy-initialized Exa client ──
   Avoids module-scope crash if EXA_API_KEY is not set. */
let _exa: InstanceType<typeof Exa> | null = null
function getExa(): InstanceType<typeof Exa> {
  if (!_exa) {
    const key = process.env.EXA_API_KEY
    if (!key) throw new Error('EXA_API_KEY not configured')
    _exa = new Exa(key)
  }
  return _exa
}

interface SearchOptions {
  numResults?: number
  useAutoprompt?: boolean
  /** Per-result text budget. EXA Search mode passes a larger budget so the
   *  synthesis model has real material to cite, not 1000-char stubs. */
  maxCharacters?: number
  /** Exa search tier: 'auto' (~1s, default) | 'fast' | 'instant' |
   *  'deep-lite' | 'deep' (4-15s, server-side parallel search agents) |
   *  'deep-reasoning'. Deep variants run Exa's own multi-agent fan-out. */
  type?: string
  /** Extra query variations for deep-search variants — Exa runs them
   *  alongside the main query in its parallel agents. */
  additionalQueries?: string[]
}

export interface ExaSearchResult {
  title?: string
  url: string
  publishedDate?: string
  snippet?: string
}

/**
 * THROWS on upstream failure (missing key, HTTP error, network) instead of
 * returning []. Swallowing errors here made a broken EXA_API_KEY look like
 * "no results" — the circuit breaker wrapped around this function never saw
 * a failure (so it could never trip), and the chat told users the search
 * "came back empty" when in truth it never ran. Callers already catch.
 */
export async function searchWeb(query: string, options?: SearchOptions): Promise<ExaSearchResult[]> {
  try {
    const searchOpts: Record<string, unknown> = {
      numResults: options?.numResults ?? 5,
      useAutoprompt: options?.useAutoprompt ?? true,
      // Exa's agent guide: highlights carry the most relevant excerpts at ~10x
      // fewer tokens than full text, with no latency penalty — the intended
      // context-compression mode for agent pipelines. Each content type is
      // billed per page, so requesting text AND highlights doubled content
      // cost while the mapper discarded the text whenever highlights existed.
      // Full text is now fetched ONLY when a caller explicitly sizes it
      // (maxCharacters) — e.g. the deep-research path's 3000-char excerpts.
      highlights: true,
    }
    if (options?.maxCharacters) searchOpts.text = { maxCharacters: options.maxCharacters }
    if (options?.type) searchOpts.type = options.type
    if (options?.additionalQueries?.length) searchOpts.additionalQueries = options.additionalQueries
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await getExa().searchAndContents(query, searchOpts as any)

    return res.results.map((r: any) => ({
      title: r.title,
      url: r.url,
      publishedDate: r.publishedDate,
      // Use highlights if available, otherwise fall back to truncated text
      snippet: r.highlights && r.highlights.length > 0 ? r.highlights.join(' ... ') : r.text,
    }))
  } catch (err) {
    console.error('[exa] searchWeb error:', err)
    throw err
  }
}

/**
 * Parse a planner model's sub-query list. Defensive: malformed output falls
 * back to just the original query. The original query always leads, planner
 * queries follow (deduped, clipped), capped at `max` total.
 */
export function parseSubQueries(raw: string, originalQuery: string, max = 4): string[] {
  const queries: string[] = [originalQuery.trim()]
  const match = raw.match(/\[[\s\S]*\]/)
  if (match) {
    try {
      const parsed = JSON.parse(match[0])
      if (Array.isArray(parsed)) {
        for (const q of parsed) {
          if (queries.length >= max) break
          if (typeof q !== 'string') continue
          const clean = q.trim().slice(0, 200)
          if (!clean) continue
          if (queries.some(existing => existing.toLowerCase() === clean.toLowerCase())) continue
          queries.push(clean)
        }
      }
    } catch {
      // fall through — original query alone
    }
  }
  return queries
}

/**
 * Merge parallel search-result lists: round-robin interleave (keeps source
 * diversity across sub-queries instead of letting one query dominate),
 * dedupe by normalized URL, cap the total.
 */
export function mergeExaResults(lists: ExaSearchResult[][], cap = 12): ExaSearchResult[] {
  const seen = new Set<string>()
  const merged: ExaSearchResult[] = []
  const maxLen = Math.max(0, ...lists.map(l => l.length))
  for (let i = 0; i < maxLen && merged.length < cap; i++) {
    for (const list of lists) {
      if (merged.length >= cap) break
      const r = list[i]
      if (!r?.url) continue
      const key = r.url.replace(/\/+$/, '').toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(r)
    }
  }
  return merged
}

export async function fetchUrlWithExa(url: string): Promise<string> {
  try {
    const res = await getExa().getContents([url], {
      text: true
    })

    if (res.results && res.results.length > 0) {
      return res.results[0].text
    }

    throw new Error('No content returned from Exa')
  } catch (err) {
    console.error('[exa] fetchUrlWithExa error:', err)
    throw err  // Re-throw so caller can fall back to raw fetch
  }
}
