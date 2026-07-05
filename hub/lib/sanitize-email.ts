/**
 * Email HTML sanitization (audit F4).
 *
 * Email bodies rendered in the hub are sender-controlled HTML. Even inside a
 * sandboxed iframe, embedded `<script>` tags execute (tracking beacons, remote
 * fetches, resource abuse). Reading an email must never run its scripts, so we
 * sanitize with DOMPurify before rendering and only then append our own trusted
 * resize-reporter script.
 *
 * Browser-only: DOMPurify sanitizes against the live DOM, so this module must
 * only be imported from client components ('use client' contexts) — never from
 * server-side code.
 */

import DOMPurify from 'dompurify'

/**
 * Strip active content (scripts, event handlers, javascript: URLs, embedded
 * frames/forms) from sender-controlled email HTML while preserving the markup
 * marketing-style emails rely on: links, images, tables, inline styles.
 * Plain-text bodies pass through unchanged.
 */
export function sanitizeEmailHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'base', 'meta', 'link'],
    ALLOW_DATA_ATTR: false,
  })
}
