/**
 * Google Chat attachment presentation (PURE, client-safe).
 *
 * The Chat API's `attachment[]` entries come in two sources with different
 * link stories: a DRIVE_FILE carries a `driveDataRef.driveFileId` (stable Drive
 * viewer URL), while UPLOADED_CONTENT carries a `downloadUri` that works for a
 * signed-in human in a browser tab. This module reduces either to one
 * renderable chip — label, coarse kind for the icon, and a safe href — so the
 * panel never reasons about Google's attachment shapes inline.
 *
 * Free of React/`next/*` imports (same rule as lib/chat-spaces.ts /
 * lib/chat-threads.ts) so tests and any server consumer can share it.
 */

/** Structural subset of lib/google.ts `ChatAttachment` this module needs. */
export interface AttachmentLike {
  name?: string
  contentName?: string
  contentType?: string
  downloadUri?: string
  source?: string
  driveDataRef?: { driveFileId?: string }
}

export type AttachmentKind = 'image' | 'video' | 'audio' | 'pdf' | 'file'

export interface RenderableAttachment {
  /** Stable React key: the attachment resource name, or a positional fallback. */
  key: string
  /** Filename to show; never empty. */
  label: string
  /** Coarse type for icon selection. */
  kind: AttachmentKind
  /** Where the chip links. null → nothing safe to open (render unlinked). */
  href: string | null
}

function kindOf(contentType: string | undefined): AttachmentKind {
  const ct = (contentType ?? '').toLowerCase()
  if (ct.startsWith('image/')) return 'image'
  if (ct.startsWith('video/')) return 'video'
  if (ct.startsWith('audio/')) return 'audio'
  if (ct === 'application/pdf') return 'pdf'
  return 'file'
}

/**
 * Only https URLs may become hrefs. `downloadUri` is Google-authored, but it
 * still transits our API response — a bad value must degrade to an unlinked
 * chip, never to a javascript:/data: link in the DOM.
 */
function safeHref(uri: string | undefined): string | null {
  return uri && /^https:\/\//i.test(uri) ? uri : null
}

/** Drive file ids are URL path segments — refuse anything outside their charset. */
function driveHref(driveFileId: string | undefined): string | null {
  return driveFileId && /^[\w-]+$/.test(driveFileId)
    ? `https://drive.google.com/file/d/${driveFileId}/view`
    : null
}

export function renderableAttachments(attachments: AttachmentLike[] | undefined): RenderableAttachment[] {
  return (attachments ?? []).map((a, i) => ({
    key: a.name?.trim() || `attachment-${i}`,
    label: a.contentName?.trim() || 'Attachment',
    kind: kindOf(a.contentType),
    // Drive ref wins: the Drive viewer link is stable and permission-aware,
    // while downloadUri is a one-shot content URL.
    href: driveHref(a.driveDataRef?.driveFileId) ?? safeHref(a.downloadUri),
  }))
}
