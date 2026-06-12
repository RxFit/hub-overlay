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

/* ── SSRF guard — block internal/private IP ranges ── */

/**
 * Returns true if an IPv4/IPv6 literal falls in a private, loopback,
 * link-local, or otherwise non-routable range.
 * Exported for unit testing of the SSRF guard.
 */
export function isPrivateAddress(addr: string): boolean {
  const ip = addr.toLowerCase().replace(/^\[|\]$/g, '')

  // IPv6 loopback / unspecified / unique-local / link-local
  if (ip === '::1' || ip === '::' || ip === '::0') return true
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true   // unique local fc00::/7
  if (ip.startsWith('fe80')) return true                         // link local
  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1) — extract the v4 tail
  const mapped = ip.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  const v4 = mapped ? mapped[1] : ip

  const octets = v4.split('.')
  if (octets.length === 4 && octets.every(o => /^\d{1,3}$/.test(o))) {
    const [a, b] = octets.map(Number)
    if (a === 10) return true
    if (a === 127) return true                                   // loopback
    if (a === 0) return true
    if (a === 169 && b === 254) return true                      // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true             // 172.16/12
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true            // CGNAT 100.64/10
  }
  return false
}

const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal'])

/**
 * Resolve the URL's hostname and confirm none of its IPs are private.
 * Defends against DNS-rebinding and IP-encoding bypasses that a regex
 * on the raw URL string cannot catch. Returns null if safe, or a reason.
 */
async function ssrfReason(url: string): Promise<string | null> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'malformed URL'
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'only http(s) URLs are allowed'
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (BLOCKED_HOSTNAMES.has(host)) return 'blocked hostname'

  // Literal IP in the host — check directly.
  if (/^[\d.]+$/.test(host) || host.includes(':')) {
    return isPrivateAddress(host) ? 'private IP address' : null
  }

  // Hostname — resolve to IPs and reject if ANY is private.
  try {
    const { lookup } = await import('dns/promises')
    const records = await lookup(host, { all: true })
    if (records.some(r => isPrivateAddress(r.address))) {
      return 'hostname resolves to a private IP'
    }
  } catch {
    return 'DNS resolution failed'
  }
  return null
}

/* ── Fetch URL content (server-side only) ── */

export async function fetchUrlContent(url: string): Promise<string> {
  // Block internal/private URLs to prevent SSRF (resolves DNS, blocks redirects)
  const blocked = await ssrfReason(url)
  if (blocked) {
    return '[Blocked: requests to internal or private network addresses are not allowed]'
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)

    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'error', // do not auto-follow — a redirect could point at an internal host
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
