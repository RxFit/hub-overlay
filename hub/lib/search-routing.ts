/**
 * Search-routing heuristics for the chat assistant.
 *
 * Decides whether a user message should fan out to internal (Vertex/pgvector)
 * or external (Exa) search. Extracted from the chat route so the logic is unit
 * testable and not duplicated.
 *
 * Matching rules:
 * - Single tokens are matched on WORD BOUNDARIES, so 'our' does not match
 *   'hour'/'source', 'team' does not match 'steam', and 'seo' does not match
 *   'museo'. This was the source of frequent false-positive search fan-out.
 * - Multi-word phrases are matched as plain substrings.
 */

export function matchesSignals(
  message: string,
  wordSignals: string[],
  phraseSignals: string[],
): boolean {
  const lower = message.toLowerCase()
  if (phraseSignals.some(p => lower.includes(p))) return true
  return wordSignals.some(w => new RegExp(`\\b${escapeRegExp(w)}\\b`).test(lower))
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export const INTERNAL_WORD_SIGNALS = [
  'our', 'my', 'kpi', 'kpis', 'paperclip', 'workspace',
  'team', 'sprint', 'issue', 'issues', 'rxfit',
]
export const INTERNAL_PHRASE_SIGNALS = ['project status', 'casa trejo']

/** True when the message likely references internal company data. */
export function needsInternalSearch(message: string): boolean {
  return matchesSignals(message, INTERNAL_WORD_SIGNALS, INTERNAL_PHRASE_SIGNALS)
}

export const EXTERNAL_WORD_SIGNALS = [
  'competitor', 'competitors', 'industry', 'trend', 'trends', 'benchmark',
  'comparison', 'tutorial', 'specification', 'seo', 'rankings', 'traffic', 'reviews',
]
export const EXTERNAL_PHRASE_SIGNALS = [
  // Explicit web/research intent
  'search for', 'search the web', 'look up', 'find out about', 'google ', 'research ',
  // Knowledge questions
  'what is a ', 'who is ', 'what are ', 'how to ', 'how does ',
  // Market signals
  'market ', 'compare with',
  // News/current events (multi-word to avoid false positives)
  'in the news', 'latest news', 'recent announcement',
  // Technical/external docs
  'documentation for', 'docs for', 'guide for', 'best practice',
  // Named external entities (URLs)
  'http://', 'https://',
  // Analysis that needs outside data
  'social media', 'public opinion',
]

/** True when the message likely needs external/web data. */
export function needsExternalSearch(message: string): boolean {
  return matchesSignals(message, EXTERNAL_WORD_SIGNALS, EXTERNAL_PHRASE_SIGNALS)
}

/**
 * Short greeting/acknowledgement messages that carry no information need, so
 * fanning them out to Vertex/pgvector is pure wasted cost + latency. Normalized
 * (lowercased, trimmed, punctuation-stripped) before comparison.
 */
export const TRIVIAL_MESSAGES = new Set([
  'thanks', 'thank you', 'thankyou', 'thx', 'ty', 'tysm',
  'ok', 'okay', 'k', 'kk', 'okey',
  'got it', 'gotit', 'cool', 'nice', 'great', 'awesome', 'sweet',
  'hi', 'hello', 'hey', 'yo', 'hiya', 'heya',
  'yes', 'yep', 'yeah', 'yup', 'no', 'nope', 'nah',
  'sure', 'perfect', 'done', 'ok thanks', 'okay thanks',
  '👍', '🙏', '👌',
])

/**
 * True ONLY for short greetings/acks that need no search context (thanks, ok,
 * got it, 👍). Deliberately conservative: any '?', any message >3 words, and any
 * internal/external search signal all return false so genuine questions are
 * NEVER suppressed. When uncertain, returns false (search still runs).
 */
export function isTrivialMessage(query: string): boolean {
  if (!query) return false
  const wordCount = query.split(/\s+/).filter(Boolean).length
  if (wordCount === 0 || wordCount > 3) return false
  if (query.includes('?')) return false
  if (needsInternalSearch(query) || needsExternalSearch(query)) return false
  // Normalize: lowercase, trim, strip common punctuation (keep emoji + letters).
  const normalized = query.toLowerCase().trim().replace(/[.,!;:'"()\-]/g, '').replace(/\s+/g, ' ').trim()
  return TRIVIAL_MESSAGES.has(normalized)
}
