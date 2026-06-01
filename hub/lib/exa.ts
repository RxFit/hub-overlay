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
}

export interface ExaSearchResult {
  title?: string
  url: string
  publishedDate?: string
  snippet?: string
}

export async function searchWeb(query: string, options?: SearchOptions): Promise<ExaSearchResult[]> {
  try {
    const res = await getExa().searchAndContents(query, {
      numResults: options?.numResults ?? 5,
      useAutoprompt: options?.useAutoprompt ?? true,
      text: { maxCharacters: 1000 },
      highlights: true,
    })

    return res.results.map((r: any) => ({
      title: r.title,
      url: r.url,
      publishedDate: r.publishedDate,
      // Use highlights if available, otherwise fall back to truncated text
      snippet: r.highlights && r.highlights.length > 0 ? r.highlights.join(' ... ') : r.text,
    }))
  } catch (err) {
    console.error('[exa] searchWeb error:', err)
    return []
  }
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
