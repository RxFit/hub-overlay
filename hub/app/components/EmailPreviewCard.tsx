'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { sanitizeEmailHtml } from '@/lib/sanitize-email'

interface EmailPreviewCardProps {
  htmlContent: string
  subject?: string
  recipient?: string
}

// Trusted script appended to the srcDoc (after sanitization) to report the
// content height back to the parent for iframe auto-resize.
const scriptToInject = `
  <script>
    window.onload = () => {
      const height = document.documentElement.scrollHeight;
      window.parent.postMessage({ type: 'resize', height }, '*');
    };
    // Observe subsequent height changes (e.g. images loading)
    new ResizeObserver(() => {
      const height = document.documentElement.scrollHeight;
      window.parent.postMessage({ type: 'resize', height }, '*');
    }).observe(document.body);
  </script>
`

// Emails arrive as bare HTML fragments with no document scaffold, so the
// iframe falls back to browser defaults: Times serif, no viewport meta (iOS
// renders at 980px and shrinks), and images that overflow the phone width.
// Wrap the sanitized fragment in a minimal document that pins the viewport,
// applies readable base typography, constrains images/tables to the frame,
// and opens every link in a new tab (the iframe must never navigate).
const buildSrcDoc = (sanitizedHtml: string) => `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base target="_blank">
<style>
  html, body { margin: 0; padding: 0; }
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
<body>${sanitizedHtml}${scriptToInject}</body>
</html>`

export function EmailPreviewCard({ htmlContent, subject, recipient }: EmailPreviewCardProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState('120px')

  // Auto-resize iframe based on content height
  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      // Validate the message came from our iframe
      if (e.source !== iframeRef.current?.contentWindow) return
      if (e.data && e.data.type === 'resize' && e.data.height) {
        // Generous cap: the surrounding pane scrolls, so let all but
        // pathologically tall emails render fully instead of clipping at 600px.
        const capped = Math.min(e.data.height + 8, 2400)
        setHeight(`${capped}px`)
      }
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [])

  // Sanitize the sender-controlled email HTML first, then wrap it in our
  // trusted document scaffold (viewport + base styles + resize reporter).
  // Memoized so height-state re-renders don't re-sanitize.
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

      {/* Sandbox Iframe */}
      <iframe
        ref={iframeRef}
        srcDoc={safeHtml}
        title="Email Preview"
        sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
        style={{
          width: '100%',
          height,
          border: 'none',
          display: 'block',
          background: '#ffffff',
          transition: 'height 0.2s ease-out'
        }}
      />
    </div>
  )
}
