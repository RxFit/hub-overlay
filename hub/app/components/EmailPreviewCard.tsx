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

export function EmailPreviewCard({ htmlContent, subject, recipient }: EmailPreviewCardProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState('200px')

  // Auto-resize iframe based on content height
  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      // Validate the message came from our iframe
      if (e.source !== iframeRef.current?.contentWindow) return
      if (e.data && e.data.type === 'resize' && e.data.height) {
        const capped = Math.min(e.data.height + 32, 600) // Cap at 600px
        setHeight(`${capped}px`)
      }
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [])

  // Sanitize the sender-controlled email HTML first, then append our trusted
  // resize-reporter script (sanitized output has no guaranteed <body> wrapper).
  // Memoized so height-state re-renders don't re-sanitize.
  const safeHtml = useMemo(() => sanitizeEmailHtml(htmlContent) + scriptToInject, [htmlContent])

  return (
    <div className="email-preview-card" style={{
      border: '1px solid var(--border-color)',
      borderRadius: 'var(--radius-lg)',
      overflow: 'hidden',
      background: '#ffffff', // Emails usually expect white backgrounds
      margin: '12px 0',
      display: 'flex',
      flexDirection: 'column'
    }}>
      {/* Header bar */}
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid var(--border-color)',
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
      
      {/* Sandbox Iframe */}
      <div style={{ padding: '0', background: '#ffffff', flex: 1 }}>
        <iframe
          ref={iframeRef}
          srcDoc={safeHtml}
          title="Email Preview"
          sandbox="allow-scripts"
          style={{
            width: '100%',
            height,
            border: 'none',
            display: 'block',
            transition: 'height 0.2s ease-out'
          }}
        />
      </div>
    </div>
  )
}
