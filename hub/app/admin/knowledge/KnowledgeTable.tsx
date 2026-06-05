'use client'

import { useState } from 'react'
import { deleteChunk } from './actions'

type Chunk = {
  id: string
  sourceUrl: string
  content: string
  createdAt: Date
}

export default function KnowledgeTable({ initialChunks }: { initialChunks: Chunk[] }) {
  const [chunks, setChunks] = useState(initialChunks)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to permanently delete this chunk?')) return
    setDeleting(id)
    setError(null)
    try {
      await deleteChunk(id)
      setChunks(prev => prev.filter(c => c.id !== id))
    } catch (err: any) {
      setError(err.message || 'Failed to delete chunk')
    } finally {
      setDeleting(null)
    }
  }

  return (
    <div className="admin-table">
      {error && (
        <div className="admin-error" style={{ marginBottom: '16px' }} role="alert">
          <span>⚠️ {error}</span>
        </div>
      )}
      {chunks.length === 0 ? (
        <div className="admin-empty">No ingested chunks found.</div>
      ) : (
        chunks.map(chunk => (
          <div key={chunk.id} className="admin-row" style={{ alignItems: 'flex-start' }}>
            <div className="admin-row__info" style={{ flex: 1, overflow: 'hidden' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                <a href={chunk.sourceUrl} target="_blank" rel="noopener noreferrer" className="admin-row__email" style={{ textDecoration: 'underline', color: 'var(--accent)' }}>
                  {chunk.sourceUrl}
                </a>
                <span className="admin-row__meta">
                  {new Date(chunk.createdAt).toLocaleString()}
                </span>
              </div>
              <div style={{
                background: 'var(--bg-card-hover)',
                padding: '12px',
                borderRadius: '6px',
                border: '1px solid var(--border)',
                fontFamily: 'var(--font-mono)',
                fontSize: '0.75rem',
                color: 'var(--text-muted)',
                maxHeight: '150px',
                overflowY: 'auto',
                whiteSpace: 'pre-wrap'
              }}>
                {chunk.content}
              </div>
            </div>
            <div className="admin-row__actions" style={{ marginLeft: '16px', alignSelf: 'center' }}>
              <button
                className="admin-save-btn admin-save-btn--dirty"
                onClick={() => handleDelete(chunk.id)}
                disabled={deleting === chunk.id}
                style={{ background: '#ef4444', color: 'white', border: 'none' }}
              >
                {deleting === chunk.id ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        ))
      )}
    </div>
  )
}
