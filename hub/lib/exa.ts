/**
 * Exa.AI Search client for the Hub AI assistant.
 *
 * Used for external/public web queries — competitor intel, market research,
 * public documentation, news, and any question that requires live web data.
 *
 * Vertex AI handles internal data (Google Drive, Gmail, Chat).
 * Exa.AI handles everything external.
 *
 * API Docs: https://docs.exa.ai
 */

const EXA_API_KEY = process.env.EXA_API_KEY ?? ''
const EXA_SEARCH_URL = 'https://api.exa.ai/search'
const EXA_CONTENTS_URL = 'https://api.exa.ai/contents'

export interface ExaSearchResult {
  title: string
  url: string
  snippet: string
  publishedDate?: string
  author?: string
  source: 'exa-ai'
}

/**
 * Search the web using Exa.AI.
 *
 * @param query - Natural language search query
 * @param opts  - Optional configuration
 * @returns Array of search results, or null if Exa is unavailable
 */
export async function searchWeb(
  query: string,
  opts?: {
    numResults?: number
    type?: 'auto' | 'neural' | 'keyword'
    useAutoprompt?: boolean
    includeDomains?: string[]
    excludeDomains?: string[]
    startPublishedDate?: string
    category?: string
  }
): Promise<ExaSearchResult[] | null> {
  if (!EXA_API_KEY) {
    console.warn('[exa] EXA_API_KEY not configured — skipping web search')
    return null
  }

  try {
    const body: Record<string, unknown> = {
      query,
      numResults: opts?.numResults ?? 5,
      type: opts?.type ?? 'auto',
      useAutoprompt: opts?.useAutoprompt ?? true,
      contents: {
        text: { maxCharacters: 3000 },
        highlights: { numSentences: 3, highlightsPerUrl: 2 },
      },
    }

    if (opts?.includeDomains?.length) body.includeDomains = opts.includeDomains
    if (opts?.excludeDomains?.length) body.excludeDomains = opts.excludeDomains
    if (opts?.startPublishedDate) body.startPublishedDate = opts.startPublishedDate
    if (opts?.category) body.category = opts.category

    const res = await fetch(EXA_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': EXA_API_KEY,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })

    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      console.error(`[exa] Search failed: ${res.status} ${errBody}`)
      return null
    }

    const data = await res.json() as {
      results?: Array<{
        title?: string
        url?: string
        text?: string
        highlights?: string[]
        publishedDate?: string
        author?: string
      }>
    }

    if (!data.results?.length) return []

    return data.results.map(r => ({
      title: r.title ?? 'Untitled',
      url: r.url ?? '',
      snippet: r.highlights?.join(' … ') || r.text?.slice(0, 500) || '[No content]',
      publishedDate: r.publishedDate,
      author: r.author,
      source: 'exa-ai' as const,
    }))
  } catch (err) {
    console.error('[exa] Search error:', err)
    return null
  }
}

/**
 * Fetch and extract content from a URL using Exa.AI.
 * More reliable than raw fetch for JS-heavy pages.
 *
 * @param url - The URL to fetch content from
 * @returns Extracted text content, or null if unavailable
 */
export async function fetchUrlWithExa(url: string): Promise<string | null> {
  if (!EXA_API_KEY) return null

  try {
    const res = await fetch(EXA_CONTENTS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': EXA_API_KEY,
      },
      body: JSON.stringify({
        urls: [url],
        text: { maxCharacters: 16_000 },
      }),
      signal: AbortSignal.timeout(15_000),
    })

    if (!res.ok) return null

    const data = await res.json() as {
      results?: Array<{ text?: string; title?: string }>
    }

    const result = data.results?.[0]
    if (!result?.text) return null

    return result.text
  } catch {
    return null
  }
}
