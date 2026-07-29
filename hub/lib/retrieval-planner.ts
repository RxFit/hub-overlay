/**
 * Retrieval planning (PURE — no network, no model, no Google).
 *
 * DESIGN NOTE: why a planner pass and not native function calling
 * ---------------------------------------------------------------
 * The obvious way to let a model fetch data is provider-native tool calling in
 * the streaming loop. This codebase makes that a bad trade. `streamChat` is a
 * dual-provider rotating chain (Claude models, then Gemini models) with
 * cooldowns, connect/idle watchdogs, zero-text completion guards and a hard
 * invariant that once a token is on the wire it must NOT rotate. Tool calling
 * has a different wire protocol per provider, and a mid-stream tool call would
 * cut straight across that invariant — a tool round-trip after partial output
 * either duplicates the answer on rotation or strands the stream.
 *
 * So retrieval happens BEFORE the stream instead: one cheap non-streaming model
 * call decides what to look up, the server executes those reads in parallel,
 * and the results are injected as context. The streaming path is untouched, all
 * of its hard-won failure handling still applies, and the user gets an answer
 * grounded in real Drive and Chat content.
 *
 * The cost is that retrieval is single-hop — the model cannot read a document
 * and then decide to read another. That is a real limitation, and the executor
 * is shaped so a bounded second hop can be added later without touching the
 * streaming layer.
 */

/** Tools the planner is allowed to request. Read-only, by construction. */
export const RETRIEVAL_TOOLS = ['search_drive', 'search_chat'] as const
export type RetrievalTool = (typeof RETRIEVAL_TOOLS)[number]

export interface RetrievalStep {
  tool: RetrievalTool
  /** What to look for. */
  query: string
  /** search_chat only: restrict to spaces whose name contains this. */
  space?: string
}

/** Hard ceiling on reads per turn — bounds latency and prompt size. */
export const MAX_RETRIEVAL_STEPS = 3

export const MAX_QUERY_LENGTH = 200

/**
 * The planner's instructions.
 *
 * Written to be conservative: the default is to retrieve NOTHING. A plan that
 * fires on every message would add a Google round-trip to "thanks" and bury the
 * real context under irrelevant search output. Retrieval has to earn its place.
 */
export function buildPlannerPrompt(spaceNames: string[]): string {
  const spaceList = spaceNames.length
    ? spaceNames.map(n => `- ${n}`).join('\n')
    : '(no chat spaces visible)'

  return `You decide whether answering the user's message requires looking up data the assistant does not already have. You do not answer the question yourself.

You may request these READ-ONLY lookups:

1. search_drive — searches Google Drive file CONTENTS and filenames, and returns the text of the best matches. Use for documents, agreements, notes, spreadsheets, reports.
2. search_chat — searches message history inside the user's Google Chat spaces. Use for "what did X say", "who is our contact at Y", decisions or details discussed in a space. Set "space" to narrow to one space when the question names an organisation, team or project that matches a space below.

The user's visible Chat spaces:
${spaceList}

Reply with ONLY a JSON array, no prose and no code fence. Each element:
  {"tool": "search_drive", "query": "..."}
  {"tool": "search_chat", "query": "...", "space": "..."}

Rules:
- Return [] when the message is chit-chat, a greeting, a thank-you, a follow-up answerable from conversation, or a request to WRITE or SEND something. Returning [] is the correct and common answer.
- At most ${MAX_RETRIEVAL_STEPS} lookups. Prefer one well-aimed lookup over three vague ones.
- "query" holds the KEYWORDS to search for, not the user's sentence. For "who is our account manager at Nuvita?" use query "account manager contact" with space "Nuvita" — not the whole question.
- Only set "space" to a name from the list above.
- If the question could be answered from either Drive or Chat, request both.

Examples:
User: "thanks, that's great" -> []
User: "draft an email to Sarah" -> []
User: "who is our account manager at Nuvita?" -> [{"tool":"search_chat","query":"account manager contact point of contact","space":"Nuvita"},{"tool":"search_drive","query":"Nuvita"}]
User: "what did we agree on pricing for the corporate wellness deal?" -> [{"tool":"search_chat","query":"pricing rate cost","space":"Corporate Wellness"},{"tool":"search_drive","query":"corporate wellness pricing"}]`
}

/**
 * Strip a fenced code block if the model wrapped its JSON in one.
 *
 * Models do this constantly despite being told not to; refusing to parse it
 * would silently disable retrieval for a purely cosmetic reason.
 */
function unfence(raw: string): string {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  return (fence ? fence[1] : raw).trim()
}

/**
 * Parse and HARDEN a planner response into executable steps.
 *
 * Never throws. Anything malformed yields `[]`, which degrades to exactly the
 * pre-existing behavior (digest-only context) rather than failing the turn — a
 * planner hiccup must never cost the user their answer.
 *
 * Validation is strict about the things that matter downstream: the tool name
 * must be one we implement (so a hallucinated `delete_file` can never reach an
 * executor), and the query must be a non-empty bounded string.
 */
export function parseRetrievalPlan(raw: string): RetrievalStep[] {
  if (!raw || typeof raw !== 'string') return []

  let parsed: unknown
  try {
    parsed = JSON.parse(unfence(raw))
  } catch {
    // Last resort: pull the first bracketed array out of surrounding prose.
    const match = unfence(raw).match(/\[[\s\S]*\]/)
    if (!match) return []
    try {
      parsed = JSON.parse(match[0])
    } catch {
      return []
    }
  }

  if (!Array.isArray(parsed)) return []

  const steps: RetrievalStep[] = []
  const seen = new Set<string>()

  for (const entry of parsed) {
    if (steps.length >= MAX_RETRIEVAL_STEPS) break
    if (!entry || typeof entry !== 'object') continue

    const e = entry as Record<string, unknown>
    const tool = typeof e.tool === 'string' ? e.tool.trim() : ''
    if (!(RETRIEVAL_TOOLS as readonly string[]).includes(tool)) continue

    const query = typeof e.query === 'string' ? e.query.trim().slice(0, MAX_QUERY_LENGTH) : ''
    if (!query) continue

    const space = typeof e.space === 'string' && e.space.trim()
      ? e.space.trim().slice(0, MAX_QUERY_LENGTH)
      : undefined

    // Deduplicate: the planner sometimes emits the same lookup twice, and each
    // duplicate is a wasted Google round-trip plus duplicated prompt text.
    const key = `${tool}|${query.toLowerCase()}|${(space ?? '').toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)

    steps.push({ tool: tool as RetrievalTool, query, ...(space ? { space } : {}) })
  }

  return steps
}

/**
 * Wrap executed lookups into the context block handed to the model.
 *
 * The framing matters as much as the data. Without the explicit "this is what
 * came back, cite it, and say so if it is not here" instruction, a model that
 * finds nothing tends to fall back on plausible invention — which for "who is
 * our account manager" would be a confidently wrong name.
 */
export function renderRetrievalContext(blocks: string[]): string {
  if (blocks.length === 0) return ''
  return [
    '## Retrieved on demand (live Google Drive / Chat lookups for THIS question)',
    '',
    'These are real results fetched just now from the user\'s own Drive and Chat.',
    'Answer from them and name the file or the message (sender and date) you used.',
    'If they do not contain the answer, say plainly that you searched and did not find it —',
    'never guess a name, date, figure or contact that does not appear below.',
    '',
    blocks.join('\n\n'),
    '',
  ].join('\n')
}
