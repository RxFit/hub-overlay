'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { sanitizeEmailHtml } from '@/lib/sanitize-email'

interface EmailPreviewCardProps {
  htmlContent: string
  subject?: string
  recipient?: string
}

// Emails arrive as bare HTML fragments with no document scaffold, so the
// iframe falls back to browser defaults: Times serif, no viewport meta (iOS
// renders at 980px and shrinks), and images that overflow the phone width.
// Wrap the sanitized fragment in a minimal document that pins the viewport,
// applies readable base typography, constrains images/tables to the frame,
// and opens every link in a new tab (the iframe must never navigate).
//
// SECURITY MODEL (the Close.com pattern): sandbox WITHOUT allow-scripts —
// nothing in the email document can execute, which makes allow-same-origin
// safe and lets the PARENT measure content height directly instead of
// injecting a reporter script. A CSP meta of script-src 'none' backs the
// sandbox up as defense in depth. DOMPurify sanitization still runs first.
const buildSrcDoc = (sanitizedHtml: string) => `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="script-src 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base target="_blank">
<style>
  html, body { margin: 0; padding: 0; height: auto !important; }
  body {
    padding: 14px 16px;
    font: 15px/1.6 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
      'Helvetica Neue', Arial, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji';
    color: #1f2430;
    background: #ffffff;
    overflow-wrap: break-word;
    word-wrap: break-word;
    -webkit-text-size-adjust: 100%;
  }
  img { max-width: 100% !important; height: auto !important; }
  table { max-width: 100% !important; }
  a { color: #2563eb; }
  blockquote { margin: 0 0 0 0.8ex; border-left: 2px solid #d1d5db; padding-left: 1ex; color: #4b5563; }
  p:first-child { margin-top: 0; }
  p:last-child { margin-bottom: 0; }
  pre { white-space: pre-wrap; }
</style>
</head>
<body>${sanitizedHtml}</body>
</html>`

const MAX_IFRAME_HEIGHT = 2400
const MIN_IFRAME_HEIGHT = 48

export function EmailPreviewCard({ htmlContent, subject, recipient }: EmailPreviewCardProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const observerRef = useRef<ResizeObserver | null>(null)
  const [height, setHeight] = useState(MIN_IFRAME_HEIGHT)

  // Parent-side measurement (enabled by allow-same-origin + no scripts).
  // Reading both body and documentElement scrollHeight avoids the classic
  // iframe pitfall where one of the two reports the frame's own viewport
  // height instead of the content height.
  const measure = useCallback(() => {
    const doc = iframeRef.current?.contentDocument
    if (!doc?.body) return
    const h = Math.max(doc.body.scrollHeight, doc.documentElement?.scrollHeight ?? 0)
    if (h > 0) {
      setHeight(Math.min(Math.max(h, MIN_IFRAME_HEIGHT), MAX_IFRAME_HEIGHT))
    }
  }, [])

  // Track content growth after load: images decoding, fonts, and width
  // changes (rotation) all reflow the body — a ResizeObserver from the
  // parent realm on the iframe's body catches every case.
  const handleLoad = useCallback(() => {
    measure()
    const doc = iframeRef.current?.contentDocument
    if (!doc?.body || typeof ResizeObserver === 'undefined') return
    observerRef.current?.disconnect()
    const ro = new ResizeObserver(measure)
    ro.observe(doc.body)
    observerRef.current = ro
    // Re-measure once everything (images included) has finished loading.
    doc.defaultView?.addEventListener('load', measure)
  }, [measure])

  useEffect(() => {
    // Rotation / pane resize changes the iframe width → content reflows.
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('resize', measure)
      observerRef.current?.disconnect()
    }
  }, [measure])

  // Sanitize the sender-controlled email HTML first, then wrap it in our
  // trusted document scaffold. Memoized so height-state re-renders don't
  // re-sanitize.
  const safeHtml = useMemo(() => buildSrcDoc(sanitizeEmailHtml(htmlContent)), [htmlContent])

  return (
    <div className="email-preview-card" style={{
      border: '1px solid var(--border)',
      borderRadius: '10px',
      overflow: 'hidden',
      background: '#ffffff', // Emails usually expect white backgrounds
      display: 'flex',
      flexDirection: 'column'
    }}>
      {/* Header bar */}
      {(recipient || subject) && (
        <div style={{
          padding: '10px 16px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--surface-bg)',
          fontSize: '0.85rem',
          color: 'var(--text-primary)'
        }}>
          {recipient && (
            <div style={{ marginBottom: '4px' }}>
              <span style={{ color: 'var(--text-muted)' }}>To: </span>
              <span style={{ fontWeight: 600 }}>{recipient}</span>
            </div>
          )}
          {subject && (
            <div>
              <span style={{ color: 'var(--text-muted)' }}>Subject: </span>
              <span style={{ fontWeight: 600 }}>{subject}</span>
            </div>
          )}
        </div>
      )}

      {/* Sandbox iframe — scripts NEVER run inside (no allow-scripts). */}
      <iframe
        ref={iframeRef}
        srcDoc={safeHtml}
        title="Email content"
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        onLoad={handleLoad}
        style={{
          width: '100%',
          height: `${height}px`,
          border: 'none',
          display: 'block',
          background: '#ffffff',
          transition: 'height 0.15s ease-out'
        }}
      />
    </div>
  )
}
