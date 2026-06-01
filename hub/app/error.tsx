'use client'

import { useEffect } from 'react'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error('[GlobalError]', error)
  }, [error])

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#0a0a0f',
      color: '#e4e4e7',
      fontFamily: 'Inter, system-ui, sans-serif',
      padding: '2rem',
    }}>
      <div style={{
        maxWidth: '600px',
        width: '100%',
        background: '#18181b',
        borderRadius: '12px',
        padding: '2rem',
        border: '1px solid #27272a',
      }}>
        <h2 style={{ color: '#ef4444', marginBottom: '1rem', fontSize: '1.25rem' }}>
          Hub Error
        </h2>
        <pre style={{
          background: '#09090b',
          padding: '1rem',
          borderRadius: '8px',
          fontSize: '0.75rem',
          overflow: 'auto',
          maxHeight: '300px',
          color: '#a1a1aa',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}>
          {error.message}
          {error.stack && `\n\n${error.stack}`}
          {error.digest && `\n\nDigest: ${error.digest}`}
        </pre>
        <button
          onClick={() => reset()}
          style={{
            marginTop: '1rem',
            padding: '0.5rem 1.5rem',
            background: '#C5A059',
            color: '#0a0a0f',
            border: 'none',
            borderRadius: '8px',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Try Again
        </button>
      </div>
    </div>
  )
}
