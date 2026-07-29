/**
 * Workspace search primitives — Drive contents and Chat message history.
 *
 * These return STRUCTURED results; the registry entries in ./registry.ts turn
 * them into `ToolResult`s. Keeping the search logic here (and free of prompt
 * formatting) is what makes the fiddly parts — space name resolution, keyword
 * matching, the Drive read budget — unit-testable without a registry or a model.
 */

import {
  searchDriveFiles,
  readDriveFileText,
  listChatSpaces,
  listChatMessages,
  type GoogleDriveFile,
  type ChatSpace,
  type ChatMessage,
} from '../google'
import {
  resolveVisibleSpaces,
  EMPTY_CHAT_SPACE_PREFERENCES,
  type ChatSpacePreferences,
} from '../chat-spaces'

/**
 * Every cap here exists because this output lands in a prompt, sharing a budget
 * with the Workspace digest, Paperclip context and search pipeline. An
 * unbounded document dump would evict the context that makes the answer good.
 */
export const WORKSPACE_SEARCH_LIMITS = {
  driveMatches: 6,
  /** Top matches whose full text is extracted — the expensive part. */
  driveFilesRead: 2,
  driveCharsPerFile: 4_000,
  chatSpacesScanned: 4,
  /** Messages pulled per space before keyword filtering. */
  chatMessagesPerSpace: 150,
  chatMatches: 12,
  chatCharsPerMessage: 400,
} as const

/* ══════════════════════════════════════════
   Drive
   ══════════════════════════════════════════ */

export interface DriveHit {
  name: string
  mimeType: string
  modifiedTime?: string
  webViewLink?: string
}

export interface DriveDocument {
  name: string
  text: string
  truncated: boolean
}

export interface DriveSearchOutcome {
  matches: DriveHit[]
  documents: DriveDocument[]
}

/**
 * Search Drive and read the top hits.
 *
 * The read is the point. A list of filenames is what the assistant already had
 * in its digest and could not answer from; extracting the text of the best
 * matches in the same hop is what turns "there is a file called Nuvita
 * Partnership" into an actual answer — with no second model round-trip needed
 * to choose a file.
 *
 * A file that cannot be read degrades to a note in its own `text`, so one
 * locked or binary document never costs the user the whole lookup.
 */
export async function searchDriveWithContents(
  accessToken: string,
  term: string,
): Promise<DriveSearchOutcome> {
  const files: GoogleDriveFile[] = await searchDriveFiles(accessToken, term, {
    maxResults: WORKSPACE_SEARCH_LIMITS.driveMatches,
  })

  if (files.length === 0) return { matches: [], documents: [] }

  const documents = await Promise.all(
    files.slice(0, WORKSPACE_SEARCH_LIMITS.driveFilesRead).map(f =>
      readDriveFileText(accessToken, f.id, { maxChars: WORKSPACE_SEARCH_LIMITS.driveCharsPerFile })
        .then(c => ({ name: c.name, text: c.text, truncated: c.truncated }))
        .catch((err: unknown) => ({
          name: f.name,
          text: `[Could not read this file: ${err instanceof Error ? err.message : 'unknown error'}]`,
          truncated: false,
        })),
    ),
  )

  return {
    matches: files.map(f => ({
      name: f.name,
      mimeType: f.mimeType,
      modifiedTime: f.modifiedTime,
      webViewLink: f.webViewLink,
    })),
    documents,
  }
}

/* ══════════════════════════════════════════
   Chat
   ══════════════════════════════════════════ */

/**
 * Pick which spaces to scan.
 *
 * When a space is named ("Nuvita"), match by case-insensitive substring — that
 * is how a person refers to a space, and it tolerates the decorations Google
 * adds to display names.
 *
 * A named space that matches NOTHING returns nothing rather than falling back
 * to scanning everything: answering a question about Nuvita with messages from
 * unrelated spaces is worse than finding nothing.
 */
export function selectSpacesToSearch(
  spaces: ChatSpace[],
  spaceQuery: string | undefined,
  limit = WORKSPACE_SEARCH_LIMITS.chatSpacesScanned,
): ChatSpace[] {
  const needle = spaceQuery?.trim().toLowerCase()
  if (needle) {
    const matched = spaces.filter(s => (s.displayName ?? '').toLowerCase().includes(needle))
    return matched.slice(0, limit)
  }
  return spaces.slice(0, limit)
}

/** Split a query into search terms, dropping filler that would match anything. */
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
 * Does a message match?
 *
 * An OR over terms, deliberately: someone asking for "account manager" should
 * also surface "your manager on the account is…". Precision is recovered
 * downstream — the model reads the matches and decides what is relevant.
 */
export function messageMatches(text: string, terms: string[]): boolean {
  if (terms.length === 0) return true
  const haystack = text.toLowerCase()
  return terms.some(t => haystack.includes(t))
}

export interface ChatHit {
  space: string
  sender: string
  date: string
  text: string
}

export interface ChatSearchOutcome {
  /** Display names of the spaces actually scanned. */
  spacesSearched: string[]
  hits: ChatHit[]
  /** Spaces that could not be read, with the reason. */
  failures: { space: string; reason: string }[]
  /** Visible space names, supplied when a named space matched nothing. */
  availableSpaces?: string[]
}

/**
 * Search message history inside the user's Chat spaces.
 *
 * WHY THIS SCANS RATHER THAN QUERIES: the Google Chat API has NO full-text
 * message search for user credentials. `spaces.messages.list` filters only on
 * createTime and thread, and the cross-space `spaces.search` method is
 * Workspace-admin-only. So with a normal OAuth token the only way to answer
 * "what did Nuvita say about the account manager" is to page recent messages
 * out of the candidate spaces and match locally. The caps above bound that; the
 * trade-off is that it sees recent history, not all history.
 *
 * Honors the user's space visibility preferences — a space deliberately hidden
 * from the panel is not read out of by the assistant either.
 */
export async function searchChatHistory(
  accessToken: string,
  query: string,
  spaceQuery: string | undefined,
  preferences: ChatSpacePreferences = EMPTY_CHAT_SPACE_PREFERENCES,
): Promise<ChatSearchOutcome> {
  const visible = resolveVisibleSpaces(await listChatSpaces(accessToken), preferences)
  const targets = selectSpacesToSearch(visible, spaceQuery)

  if (targets.length === 0) {
    return {
      spacesSearched: [],
      hits: [],
      failures: [],
      availableSpaces: visible.map(s => s.displayName).filter(Boolean).slice(0, 15),
    }
  }

  const terms = queryTerms(query)
  const hits: ChatHit[] = []
  const failures: { space: string; reason: string }[] = []

  const perSpace = await Promise.all(
    targets.map(async space => {
      try {
        const messages = await listChatMessages(
          accessToken,
          space.name,
          WORKSPACE_SEARCH_LIMITS.chatMessagesPerSpace,
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

  for (const { space, messages, error } of perSpace) {
    const label = space.displayName || space.name
    if (error) {
      failures.push({ space: label, reason: error })
      continue
    }
    const matched = messages
      .filter(m => messageMatches(m.text ?? '', terms))
      // Newest first — recency usually settles "who is our contact now".
      .reverse()
      .slice(0, WORKSPACE_SEARCH_LIMITS.chatMatches)

    for (const m of matched) {
      hits.push({
        space: label,
        sender: m.sender?.displayName?.trim() || '(unknown sender)',
        date: m.createTime ? m.createTime.slice(0, 10) : 'undated',
        text: (m.text ?? '').replace(/\s+/g, ' ').trim().slice(0, WORKSPACE_SEARCH_LIMITS.chatCharsPerMessage),
      })
    }
  }

  return { spacesSearched: targets.map(s => s.displayName || s.name), hits, failures }
}
