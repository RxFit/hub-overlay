/**
 * On-demand retrieval tools for the AI assistant (SERVER-ONLY).
 *
 * WHY THIS EXISTS
 * ---------------
 * Until now the assistant only ever saw a fixed digest assembled before it ran
 * (lib/google-context.ts): Drive as a list of 12 filenames with NO contents, and
 * Chat as the last 5 messages from only the first 3 spaces. So "who is our
 * Nuvita account manager?" was unanswerable — the model could see that a Nuvita
 * space existed and nothing inside it — and the honest answer it gave ("I don't
 * have direct access… go search it yourself") read like a broken integration.
 *
 * These tools let the assistant actually go and look. They are executed
 * server-side against the user's own OAuth token, and their results are folded
 * into the prompt before the model answers.
 *
 * SCOPE NOTE: everything here is READ-ONLY. Writes stay where they already are
 * — behind the confirm-card gate in lib/actions/executeAction.ts — so widening
 * what the model can SEE never widens what it can DO.
 */

import {
  searchDriveFiles,
  readDriveFileText,
  listChatSpaces,
  listChatMessages,
  type ChatSpace,
  type ChatMessage,
} from './google'
import {
  resolveVisibleSpaces,
  EMPTY_CHAT_SPACE_PREFERENCES,
  type ChatSpacePreferences,
} from './chat-spaces'

/* ══════════════════════════════════════════
   Budgets
   ══════════════════════════════════════════ */

/**
 * Every cap here exists because this output lands in a prompt. The budget is
 * shared with the Workspace digest, the Paperclip context and the search
 * pipeline, so an unbounded document dump would evict the very context that
 * makes the answer good.
 */
export const RETRIEVAL_LIMITS = {
  /** Drive files listed per search. */
  driveMatches: 6,
  /** Top matches whose full text is extracted (the expensive part). */
  driveFilesRead: 2,
  /** Characters kept per extracted document. */
  driveCharsPerFile: 4_000,
  /** Spaces scanned per chat search. */
  chatSpacesScanned: 4,
  /** Messages pulled per space before keyword filtering. */
  chatMessagesPerSpace: 150,
  /** Matching messages reported. */
  chatMatches: 12,
  /** Characters kept per reported message. */
  chatCharsPerMessage: 400,
} as const

/* ══════════════════════════════════════════
   Drive
   ══════════════════════════════════════════ */

export interface DriveSearchResult {
  tool: 'search_drive'
  query: string
  /** Human-readable block to inject into the prompt. */
  rendered: string
  matchCount: number
}

/**
 * Search Drive and read the top hits.
 *
 * The read is the point. A list of filenames is what the assistant already had
 * and could not answer from; extracting the text of the best matches in the
 * same hop is what turns "I found a file called Nuvita Partnership" into an
 * actual answer — without needing a second model round-trip to pick a file.
 *
 * Failures degrade to a note rather than throwing: one unreadable file must not
 * cost the user the whole answer.
 */
export async function runDriveSearch(
  accessToken: string,
  query: string,
): Promise<DriveSearchResult> {
  const files = await searchDriveFiles(accessToken, query, {
    maxResults: RETRIEVAL_LIMITS.driveMatches,
  })

  if (files.length === 0) {
    return {
      tool: 'search_drive',
      query,
      matchCount: 0,
      rendered: `#### Drive search: "${query}"\nNo files matched (searched document contents and filenames).`,
    }
  }

  const toRead = files.slice(0, RETRIEVAL_LIMITS.driveFilesRead)
  const contents = await Promise.all(
    toRead.map(f =>
      readDriveFileText(accessToken, f.id, { maxChars: RETRIEVAL_LIMITS.driveCharsPerFile })
        .catch((err: unknown) => ({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          text: `[Could not read this file: ${err instanceof Error ? err.message : 'unknown error'}]`,
          truncated: false,
          webViewLink: f.webViewLink,
        })),
    ),
  )

  const lines: string[] = [`#### Drive search: "${query}" — ${files.length} match(es)`]

  for (const f of files) {
    lines.push(`  - ${f.name} (${f.mimeType.replace('application/vnd.google-apps.', 'google-')}, modified ${f.modifiedTime?.slice(0, 10) ?? 'unknown'})${f.webViewLink ? ` — ${f.webViewLink}` : ''}`)
  }

  for (const c of contents) {
    lines.push('')
    lines.push(`**Contents of "${c.name}"${c.truncated ? ' (truncated)' : ''}:**`)
    lines.push(c.text.trim() || '[empty file]')
  }

  return { tool: 'search_drive', query, matchCount: files.length, rendered: lines.join('\n') }
}

/* ══════════════════════════════════════════
   Chat
   ══════════════════════════════════════════ */

export interface ChatSearchResult {
  tool: 'search_chat'
  query: string
  spacesSearched: string[]
  rendered: string
  matchCount: number
}

/**
 * Pick which spaces to scan.
 *
 * When the planner names a space ("Nuvita"), match it by case-insensitive
 * substring — that is how a person refers to a space, and it tolerates the
 * decorations Google adds to display names. With no name given, fall back to
 * the user's visible spaces, which after the visibility work means real team
 * spaces rather than a pile of Meet conversations.
 */
export function selectSpacesToSearch(
  spaces: ChatSpace[],
  spaceQuery: string | undefined,
  limit = RETRIEVAL_LIMITS.chatSpacesScanned,
): ChatSpace[] {
  const needle = spaceQuery?.trim().toLowerCase()
  if (needle) {
    const matched = spaces.filter(s => (s.displayName ?? '').toLowerCase().includes(needle))
    // A named space that matches nothing must NOT silently fall back to
    // scanning everything — that would answer a question about Nuvita with
    // messages from unrelated spaces, which is worse than finding nothing.
    if (matched.length > 0) return matched.slice(0, limit)
    return []
  }
  return spaces.slice(0, limit)
}

/**
 * Does a message match the query?
 *
 * Deliberately an OR over terms rather than a phrase match: a user asking for
 * "account manager" should also surface a message that says "your manager on
 * the account is…". Precision is recovered downstream — the model reads the
 * matches and decides what is relevant.
 */
export function messageMatches(text: string, terms: string[]): boolean {
  if (terms.length === 0) return true
  const haystack = text.toLowerCase()
  return terms.some(t => haystack.includes(t))
}

/** Split a query into meaningful search terms, dropping filler words. */
export function queryTerms(query: string): string[] {
  const STOP = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'who', 'what', 'when', 'where',
    'why', 'how', 'our', 'my', 'we', 'us', 'for', 'of', 'to', 'in', 'on', 'at',
    'and', 'or', 'with', 'about', 'from', 'do', 'does', 'did', 'i', 'me',
  ])
  return Array.from(new Set(
    query
      .toLowerCase()
      .split(/[^a-z0-9@._-]+/)
      .map(t => t.trim())
      .filter(t => t.length > 2 && !STOP.has(t)),
  ))
}

/**
 * Search message history inside the user's Chat spaces.
 *
 * IMPORTANT — why this scans rather than queries: the Google Chat API has NO
 * full-text message search for user credentials. `spaces.messages.list` filters
 * only on createTime and thread, and the cross-space `spaces.search` method is
 * Workspace-admin-only. So the only way to answer "what did Nuvita say about
 * the account manager" with a normal OAuth token is to page recent messages out
 * of the candidate spaces and match locally. The caps in RETRIEVAL_LIMITS keep
 * that bounded; the trade-off is that it sees recent history, not all history.
 */
export async function runChatSearch(
  accessToken: string,
  query: string,
  spaceQuery: string | undefined,
  preferences: ChatSpacePreferences = EMPTY_CHAT_SPACE_PREFERENCES,
): Promise<ChatSearchResult> {
  const allSpaces = await listChatSpaces(accessToken)
  // Honor the user's visibility choices: a space they deliberately hid from the
  // panel should not be read out of by the assistant either.
  const visible = resolveVisibleSpaces(allSpaces, preferences)
  const targets = selectSpacesToSearch(visible, spaceQuery)

  if (targets.length === 0) {
    const available = visible.map(s => s.displayName).filter(Boolean).slice(0, 15)
    return {
      tool: 'search_chat',
      query,
      spacesSearched: [],
      matchCount: 0,
      rendered: `#### Chat search: "${query}"${spaceQuery ? ` in space matching "${spaceQuery}"` : ''}\nNo matching space. Visible spaces: ${available.length ? available.join(', ') : '(none)'}.`,
    }
  }

  const terms = queryTerms(query)

  const perSpace = await Promise.all(
    targets.map(async space => {
      try {
        const messages = await listChatMessages(
          accessToken,
          space.name,
          RETRIEVAL_LIMITS.chatMessagesPerSpace,
        )
        return { space, messages, error: null as string | null }
      } catch (err) {
        return {
          space,
          messages: [] as ChatMessage[],
          error: err instanceof Error ? err.message : 'unknown error',
        }
      }
    }),
  )

  const lines: string[] = []
  let matchCount = 0

  for (const { space, messages, error } of perSpace) {
    const label = space.displayName || space.name
    if (error) {
      lines.push(`**${label}** — [could not read: ${error}]`)
      continue
    }

    const hits = messages
      .filter(m => messageMatches(m.text ?? '', terms))
      // Newest first: recency is what usually settles "who is our contact now".
      .reverse()
      .slice(0, RETRIEVAL_LIMITS.chatMatches)

    if (hits.length === 0) {
      lines.push(`**${label}** — no messages matched in the last ${messages.length}.`)
      continue
    }

    matchCount += hits.length
    lines.push(`**${label}** — ${hits.length} matching message(s):`)
    for (const m of hits) {
      const who = m.sender?.displayName?.trim() || '(unknown sender)'
      const when = m.createTime ? m.createTime.slice(0, 10) : 'undated'
      const text = (m.text ?? '').replace(/\s+/g, ' ').trim().slice(0, RETRIEVAL_LIMITS.chatCharsPerMessage)
      lines.push(`  - [${when}] ${who}: ${text}`)
    }
  }

  const header = `#### Chat search: "${query}"${spaceQuery ? ` in "${spaceQuery}"` : ''} — searched ${targets.length} space(s), ${matchCount} match(es)`

  return {
    tool: 'search_chat',
    query,
    spacesSearched: targets.map(s => s.displayName || s.name),
    matchCount,
    rendered: [header, ...lines].join('\n'),
  }
}
