'use client'

import { useEffect, useRef, useState } from 'react'

interface EmailPreviewCardProps {
  htmlContent: string
  subject?: string
  recipient?: string
}

export function EmailPreviewCard({ htmlContent, subject, recipient }: EmailPreviewCardProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState('200px')

  // Auto-resize iframe based on content height
  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (e.data && e.data.type === 'resize' && e.data.height) {
        setHeight(`${e.data.height + 32}px`) // Add some padding
      }
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [])

  // Inject a small script into the srcDoc to report the height back to the parent
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
  
  // Clean up and inject the script before the closing </body> or at the end
  const safeHtml = htmlContent.includes('</body>')
    ? htmlContent.replace('</body>', `${scriptToInject}</body>`)
    : htmlContent + scriptToInject

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
          sandbox="allow-scripts allow-same-origin"
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
