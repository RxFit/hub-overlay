/**
 * Content fetching utilities for chat context attachments.
 *
 * - fetchUrlContent:      strips a web page down to readable text
 * - fetchDriveDocContent: exports a Google Doc/Sheet/Slide as plain text via Drive API
 */

const MAX_TEXT_LENGTH = 16_000  // ~4K tokens

/* ── HTML → plain text (lightweight, no npm dep) ── */

function htmlToText(html: string): string {
  return html
    // Remove script/style blocks
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // Convert block elements to newlines
    .replace(/<\/?(p|div|br|h[1-6]|li|tr|blockquote|section|article|header|footer)[^>]*>/gi, '\n')
    // Remove all remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode common HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Collapse whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/* ── Fetch URL content (server-side only) ── */

export async function fetchUrlContent(url: string): Promise<string> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'HubBot/1.0 (context-fetch)',
        'Accept': 'text/html, text/plain, application/json',
      },
    })
    clearTimeout(timeout)

    if (!res.ok) {
      return `[Failed to fetch URL: HTTP ${res.status}]`
    }

    const contentType = res.headers.get('content-type') ?? ''
    const raw = await res.text()

    let text: string
    if (contentType.includes('application/json')) {
      // Pretty-print JSON
      try {
        text = JSON.stringify(JSON.parse(raw), null, 2)
      } catch {
        text = raw
      }
    } else if (contentType.includes('text/plain')) {
      text = raw
    } else {
      // HTML → plain text
      text = htmlToText(raw)
    }

    // Truncate to budget
    if (text.length > MAX_TEXT_LENGTH) {
      text = text.slice(0, MAX_TEXT_LENGTH) + '\n\n[...truncated to fit context window]'
    }

    return text
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return `[Failed to fetch URL: ${msg}]`
  }
}

/* ── Fetch Google Drive document content ── */

const DRIVE_EXPORT_BASE = 'https://www.googleapis.com/drive/v3/files'

/**
 * Export a Google Doc/Sheet/Slides as plain text.
 * For native Google formats, uses the export endpoint.
 * For other files, tries to download the raw content.
 */
export async function fetchDriveDocContent(
  accessToken: string,
  fileId: string,
  mimeType?: string
): Promise<string> {
  try {
    const isGoogleDoc = mimeType?.startsWith('application/vnd.google-apps.')

    let text: string

    if (isGoogleDoc) {
      // Export as plain text
      const exportMime = 'text/plain'
      const res = await fetch(
        `${DRIVE_EXPORT_BASE}/${fileId}/export?mimeType=${encodeURIComponent(exportMime)}`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      )
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        return `[Failed to export Google Doc: HTTP ${res.status} ${body}]`
      }
      text = await res.text()
    } else {
      // For non-Google files (PDF, plain text, etc.) — download content
      const res = await fetch(
        `${DRIVE_EXPORT_BASE}/${fileId}?alt=media`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      )
      if (!res.ok) {
        return `[Failed to download file: HTTP ${res.status}]`
      }
      const contentType = res.headers.get('content-type') ?? ''
      if (contentType.includes('text/') || contentType.includes('application/json')) {
        text = await res.text()
      } else {
        return `[Binary file — cannot extract text content (${mimeType ?? contentType})]`
      }
    }

    // Truncate to budget
    if (text.length > MAX_TEXT_LENGTH) {
      text = text.slice(0, MAX_TEXT_LENGTH) + '\n\n[...truncated to fit context window]'
    }

    return text
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return `[Failed to fetch document: ${msg}]`
  }
}
