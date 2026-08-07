/**
 * Turn Google Drive links pasted into a chat message into readable context.
 *
 * Before this existed, a pasted drive.google.com / docs.google.com URL was
 * invisible to the model: nothing extracted the file id, and generic URL
 * attachments are fetched WITHOUT the user's OAuth token — which for any
 * private Drive file yields a sign-in page or a redirect error. The result was
 * the assistant claiming it "can't see" a document the user just linked.
 *
 * This module is deliberately deterministic (regex extraction, no planner in
 * the loop) so a pasted link works every time, in every chat mode.
 *
 * The result is split in two on purpose: `content` is document text and status
 * notes — untrusted data the prompt builder fences — while `advisory` is OUR
 * instruction to the model (sign-in guidance, "don't claim it doesn't exist").
 * The fence policy orders the model to ignore instructions found INSIDE a
 * fence, so guidance placed there would be discarded; it must render outside.
 */

import { readDriveFileText } from '@/lib/google'
import { createLogger } from '@/lib/logger'

const log = createLogger('drive-links')

export interface DriveLink {
  fileId: string
  url: string
  /** True for drive folder links, which cannot be read as a document. */
  isFolder: boolean
}

// Drive file ids are url-safe base64-ish; 10+ avoids matching path words while
// accepting the shortest real-world ids. Optional /u/<n>/ covers multi-account
// sessions. The open? query-string scan is BOUNDED ({0,256}) — an unbounded
// lazy [^\s]*? is quadratic on adversarial whitespace-free input, and this
// runs synchronously on every chat message.
const FILE_LINK_PATTERNS = [
  /https?:\/\/docs\.google\.com\/(?:document|spreadsheets|presentation|forms)\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{10,})/g,
  /https?:\/\/drive\.google\.com\/(?:file\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{10,})|open\?[^\s]{0,256}?\bid=([A-Za-z0-9_-]{10,}))/g,
]

const FOLDER_LINK_PATTERN = /https?:\/\/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]{10,})/g

/** Max linked files read per message — same cost/latency reasoning as the attachment cap. */
const MAX_LINKS = 3

/** Extraction never needs to look past this much message text. */
const MAX_SCAN_CHARS = 20_000

/** Extract every Google Drive file/folder link from free text, deduped by file id. */
export function extractDriveLinks(text: string): DriveLink[] {
  const scan = text.slice(0, MAX_SCAN_CHARS)
  const seen = new Set<string>()
  const links: DriveLink[] = []

  for (const match of scan.matchAll(FOLDER_LINK_PATTERN)) {
    const fileId = match[1]
    if (!seen.has(fileId)) {
      seen.add(fileId)
      links.push({ fileId, url: match[0], isFolder: true })
    }
  }
  for (const pattern of FILE_LINK_PATTERNS) {
    for (const match of scan.matchAll(pattern)) {
      const fileId = match[1] ?? match[2]
      if (fileId && !seen.has(fileId)) {
        seen.add(fileId)
        links.push({ fileId, url: match[0], isFolder: false })
      }
    }
  }
  return links
}

/** Why Google access is unavailable this turn — mirrors GoogleTokenState. */
export type DriveLinkAuthReason = 'reauth' | 'transient' | 'expired'

export interface DriveLinkContext {
  /** Document text + per-link status notes. UNTRUSTED — must be fenced. */
  content: string
  /** Our own guidance to the model. Trusted — must render OUTSIDE the fence. */
  advisory: string
}

const EMPTY: DriveLinkContext = { content: '', advisory: '' }

/**
 * Resolve Drive links found in the user's message, reading each file with the
 * USER'S OAuth token. Returns empty parts when the message contains no Drive
 * links. Never throws: a link that cannot be read degrades to a status note
 * plus an advisory so the model tells the user what happened instead of
 * denying the file exists.
 */
export async function resolveDriveLinkContext(
  messageText: string | undefined,
  accessToken: string | undefined,
  opts?: { unavailableReason?: DriveLinkAuthReason },
): Promise<DriveLinkContext> {
  if (!messageText) return EMPTY
  const links = extractDriveLinks(messageText).slice(0, MAX_LINKS)
  if (links.length === 0) return EMPTY

  if (!accessToken) {
    // Matches the googleAuthNotice wording for the same token state so the
    // model never receives contradictory recovery advice in one prompt.
    const recovery =
      opts?.unavailableReason === 'reauth' || opts?.unavailableReason === undefined
        ? 'Tell the user to sign out of the Hub and sign back in to reconnect Google Drive.'
        : 'Tell the user this is temporary and to retry in a moment.'
    return {
      content: `The user linked ${links.length} Google Drive item(s): ${links.map(l => l.url).join(', ')}`,
      advisory: `The linked file(s) could NOT be read because the user's Google session has no valid access token right now. ${recovery} Do NOT claim the documents don't exist.`,
    }
  }

  const advisories = new Set<string>()
  const blocks = await Promise.all(
    links.map(async link => {
      if (link.isFolder) {
        advisories.add(
          'One linked item is a Drive FOLDER, which cannot be read as a document — ask the user to link the specific file inside it.',
        )
        return `### Linked Drive folder: ${link.url}\n\n[folder — no readable document content]`
      }
      try {
        const file = await readDriveFileText(accessToken, link.fileId, { maxChars: 12_000 })
        const truncNote = file.truncated ? '\n\n[...truncated to fit context window]' : ''
        return `### Linked Drive file: "${file.name}" (${link.url})\n\n${file.text}${truncNote}`
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown error'
        log.warn({ err, fileId: link.fileId }, 'Failed to read linked Drive file')
        advisories.add(
          /\b(404|403)\b/.test(msg)
            ? 'A linked file could not be read — it may not be shared with the signed-in Google account, or the link may be wrong. Say so, and do NOT claim the document doesn\'t exist.'
            : 'A linked file failed to load with what looks like a temporary error — suggest the user try again, and do NOT claim the document doesn\'t exist.',
        )
        return `### Linked Drive file: ${link.url}\n\n[read failed: ${msg.slice(0, 160)}]`
      }
    }),
  )

  return {
    content: blocks.join('\n\n---\n\n'),
    advisory: [...advisories].join(' '),
  }
}
