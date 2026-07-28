/**
 * Google Docs artifacts — markdown in, formatted Doc out.
 *
 * The old `createGoogleDoc` (lib/google.ts) made a Doc, then dropped the whole
 * body in as ONE `insertText` — so a document that looked like a report in chat
 * arrived in Drive as an undifferentiated wall of plain text, `##` and `**`
 * included.
 *
 * Since July 2024 Drive converts Markdown → Docs natively on upload, which
 * turns the entire problem into a single multipart request: headings, bold,
 * italics, ordered/unordered lists, tables and links all land as real Docs
 * formatting. It is also strictly fewer API calls than the old path (1 vs 2),
 * and — critically — involves no index arithmetic. Getting Docs `batchUpdate`
 * ranges right by hand is the classic way to produce a mangled document; the
 * conversion sidesteps it entirely.
 *
 * The file is created with `parents` already set, so it appears directly inside
 * the Hub workspace folder and never flickers at the user's Drive root.
 */

import { driveMultipartUpload, googleFetch, googleFetchRaw } from './client'
import { artifactAppProperties, artifactFileName } from './drive-workspace'

export const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document'
const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files'

export interface DocArtifact {
  documentId: string
  title: string
  documentUrl: string
  /** Present when the doc was filed into a workspace folder. */
  folderId?: string
}

/**
 * Markdown images (`![alt](url)`) convert poorly through the Drive importer —
 * a remote URL the importer cannot fetch becomes a broken placeholder in the
 * finished document. Replace them with their alt text so the prose still reads,
 * leaving deliberate image insertion to the Docs `insertInlineImage` path.
 *
 * Exported for unit testing; safe on markdown containing no images.
 */
export function stripMarkdownImages(markdown: string): string {
  return markdown.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_match, alt: string) => alt.trim())
}

/**
 * Create a real, formatted Google Doc from markdown.
 *
 * `folderId` places it in the Hub workspace (callers get one from
 * `ensureWorkspace`); omitting it falls back to Drive root, which keeps this
 * usable before a workspace exists.
 */
export async function createDocFromMarkdown(
  accessToken: string,
  input: {
    title: string
    markdown?: string
    folderId?: string
    tenantId?: string
    /** Skip the "YYYY-MM-DD — " filename prefix (used for template copies). */
    rawFileName?: boolean
  },
): Promise<DocArtifact> {
  const title = input.title.trim()
  const name = input.rawFileName ? title : artifactFileName(title)

  const metadata: Record<string, unknown> = {
    name,
    mimeType: GOOGLE_DOC_MIME,
    ...(input.folderId ? { parents: [input.folderId] } : {}),
    ...(input.tenantId ? { appProperties: artifactAppProperties(input.tenantId, 'doc') } : {}),
  }

  // Drive performs the markdown → Docs conversion because the metadata mimeType
  // (Google Doc) differs from the media content type (text/markdown).
  const created = await driveMultipartUpload<{ id: string; name?: string }>(
    accessToken,
    metadata,
    stripMarkdownImages(input.markdown ?? ''),
    'text/markdown',
    { fields: 'id,name' },
  )

  return {
    documentId: created.id,
    title: created.name ?? name,
    documentUrl: `https://docs.google.com/document/d/${created.id}/edit`,
    folderId: input.folderId,
  }
}

/**
 * Export a Hub-created Doc back to markdown — the read half of the revise loop
 * ("tighten section 3"): export → model revises → `replaceDocMarkdown`.
 *
 * Drive's export cap is 10 MB, which no chat-authored document approaches.
 */
export async function exportDocAsMarkdown(accessToken: string, documentId: string): Promise<string> {
  const res = await googleFetchRaw(
    `${DRIVE_FILES}/${documentId}/export?mimeType=text/markdown`,
    accessToken,
  )
  return res.text()
}

/**
 * Replace a Hub-created Doc's content with new markdown, keeping the same file
 * id (and therefore its link, and its place in the folder).
 *
 * Only ever called on documents the Hub itself created — `drive.file` scopes us
 * to exactly those. A user's own documents are never mutated; the design calls
 * for producing a revised *copy* in the workspace instead.
 */
export async function replaceDocMarkdown(
  accessToken: string,
  documentId: string,
  markdown: string,
): Promise<DocArtifact> {
  const updated = await driveMultipartUpload<{ id: string; name?: string }>(
    accessToken,
    { mimeType: GOOGLE_DOC_MIME },
    stripMarkdownImages(markdown),
    'text/markdown',
    { fileId: documentId, fields: 'id,name' },
  )

  return {
    documentId: updated.id,
    title: updated.name ?? '',
    documentUrl: `https://docs.google.com/document/d/${updated.id}/edit`,
  }
}

/**
 * Rename a Hub artifact (Doc, Sheet or deck — all Drive files).
 * Used by the artifact card's Rename action.
 */
export async function renameArtifact(
  accessToken: string,
  fileId: string,
  name: string,
): Promise<void> {
  await googleFetch<unknown>(`${DRIVE_FILES}/${fileId}?fields=id`, accessToken, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  })
}
