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
// sessions.
const FILE_LINK_PATTERNS = [
  /https?:\/\/docs\.google\.com\/(?:document|spreadsheets|presentation|forms)\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{10,})/g,
  /https?:\/\/drive\.google\.com\/(?:file\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{10,})|open\?[^\s]*?\bid=([A-Za-z0-9_-]{10,}))/g,
]

const FOLDER_LINK_PATTERN = /https?:\/\/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]{10,})/g

/** Max linked files read per message — same cost/latency reasoning as the attachment cap. */
const MAX_LINKS = 3

/** Extract every Google Drive file/folder link from free text, deduped by file id. */
export function extractDriveLinks(text: string): DriveLink[] {
  const seen = new Set<string>()
  const links: DriveLink[] = []

  for (const match of text.matchAll(FOLDER_LINK_PATTERN)) {
    const fileId = match[1]
    if (!seen.has(fileId)) {
      seen.add(fileId)
      links.push({ fileId, url: match[0], isFolder: true })
    }
  }
  for (const pattern of FILE_LINK_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const fileId = match[1] ?? match[2]
      if (fileId && !seen.has(fileId)) {
        seen.add(fileId)
        links.push({ fileId, url: match[0], isFolder: false })
      }
    }
  }
  return links
}

/**
 * Resolve Drive links found in the user's message into an injected-context
 * block, reading each file with the USER'S OAuth token. Returns '' when the
 * message contains no Drive links. Never throws: a link that cannot be read
 * degrades to an explanatory note so the model tells the user what happened
 * instead of denying the file exists.
 */
export async function resolveDriveLinkContext(
  messageText: string | undefined,
  accessToken: string | undefined,
): Promise<string> {
  if (!messageText) return ''
  const links = extractDriveLinks(messageText).slice(0, MAX_LINKS)
  if (links.length === 0) return ''

  if (!accessToken) {
    return (
      `## User-Linked Google Drive Documents\n\n` +
      `The user linked ${links.length} Google Drive item(s), but their Google session has no valid access token (missing or expired), so the content could not be read. ` +
      `Tell the user to sign out and sign back in to re-connect Google Drive — do NOT claim the documents don't exist.`
    )
  }

  const blocks = await Promise.all(
    links.map(async link => {
      if (link.isFolder) {
        return `### Linked Drive folder: ${link.url}\n\n[This link is a Drive FOLDER. Folders can't be read as a document — ask the user to link the specific file inside it.]`
      }
      try {
        const file = await readDriveFileText(accessToken, link.fileId, { maxChars: 12_000 })
        const truncNote = file.truncated ? '\n\n[...truncated to fit context window]' : ''
        return `### Linked Drive file: "${file.name}" (${link.url})\n\n${file.text}${truncNote}`
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown error'
        log.warn({ err, fileId: link.fileId }, 'Failed to read linked Drive file')
        const hint = /\b(404|403)\b/.test(msg)
          ? 'The file may not be shared with the signed-in Google account, or the link may be wrong.'
          : 'This looks like a temporary error — suggest trying again.'
        return `### Linked Drive file: ${link.url}\n\n[Could not read this Drive link (${msg.slice(0, 160)}). ${hint} Do NOT claim the document doesn't exist.]`
      }
    }),
  )

  return `## User-Linked Google Drive Documents\n\nThe user's message links the following Google Drive item(s), read just now with their Google account:\n\n${blocks.join('\n\n---\n\n')}`
}
