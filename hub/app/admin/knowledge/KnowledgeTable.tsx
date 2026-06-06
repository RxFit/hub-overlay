'use client'

import { useState, useMemo } from 'react'
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
  const [searchTerm, setSearchTerm] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const pageSize = 10

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

  // Filter chunks based on search term
  const filteredChunks = useMemo(() => {
    const term = searchTerm.trim().toLowerCase()
    if (!term) return chunks
    return chunks.filter(c =>
      c.content.toLowerCase().includes(term) ||
      c.sourceUrl.toLowerCase().includes(term)
    )
  }, [chunks, searchTerm])

  // Paginate filtered chunks
  const totalPages = Math.ceil(filteredChunks.length / pageSize)
  const startIndex = (currentPage - 1) * pageSize
  const paginatedChunks = useMemo(() => {
    return filteredChunks.slice(startIndex, startIndex + pageSize)
  }, [filteredChunks, startIndex, pageSize])

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchTerm(e.target.value)
    setCurrentPage(1)
  }

  return (
    <div className="admin-table">
      {error && (
        <div className="admin-error" style={{ marginBottom: '16px' }} role="alert">
          <span>⚠️ {error}</span>
        </div>
      )}

      {/* Premium Search Box */}
      <div style={{
        marginBottom: '20px',
        display: 'flex',
        gap: '12px',
        alignItems: 'center',
        background: 'var(--glass-bg-light)',
        padding: '12px 16px',
        borderRadius: 'var(--radius-lg)',
        border: '1px solid var(--border)'
      }}>
        <span className="rx-icon rx-icon--sm" style={{ color: 'var(--accent)' }}>
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
        </span>
        <input
          type="text"
          placeholder="Search semantic database by URL or chunk content..."
          value={searchTerm}
          onChange={handleSearchChange}
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            color: 'var(--text-primary)',
            fontSize: '0.85rem',
            outline: 'none',
            width: '100%'
          }}
          aria-label="Search chunks"
        />
        {searchTerm && (
          <button
            onClick={() => { setSearchTerm(''); setCurrentPage(1); }}
            style={{
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              padding: '2px 8px',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              fontSize: '0.7rem',
              fontWeight: 500,
              textTransform: 'uppercase',
              letterSpacing: '0.04em'
            }}
          >
            Clear
          </button>
        )}
      </div>

      {filteredChunks.length === 0 ? (
        <div className="admin-empty">No matching chunks found.</div>
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {paginatedChunks.map(chunk => (
              <div key={chunk.id} className="admin-row" style={{ alignItems: 'flex-start', padding: '16px', borderRadius: 'var(--radius-md)', display: 'flex', border: '1px solid var(--border)', background: 'var(--bg-card)' }}>
                <div className="admin-row__info" style={{ flex: 1, overflow: 'hidden' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', flexWrap: 'wrap', gap: '8px' }}>
                    <a href={chunk.sourceUrl} target="_blank" rel="noopener noreferrer" className="admin-row__email" style={{ textDecoration: 'underline', color: 'var(--accent)', fontSize: '0.8rem', fontWeight: 600 }}>
                      {chunk.sourceUrl}
                    </a>
                    <span className="admin-row__meta" style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      {new Date(chunk.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <div style={{
                    background: 'var(--bg-input)',
                    padding: '12px',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.75rem',
                    color: 'var(--text-secondary)',
                    maxHeight: '180px',
                    overflowY: 'auto',
                    whiteSpace: 'pre-wrap',
                    lineHeight: '1.5'
                  }}>
                    {chunk.content}
                  </div>
                </div>
                <div className="admin-row__actions" style={{ marginLeft: '16px', alignSelf: 'center' }}>
                  <button
                    className="admin-save-btn"
                    onClick={() => handleDelete(chunk.id)}
                    disabled={deleting === chunk.id}
                    style={{
                      background: '#ef4444',
                      color: 'white',
                      border: 'none',
                      padding: '6px 12px',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      cursor: deleting === chunk.id ? 'not-allowed' : 'pointer',
                      transition: 'background 0.15s ease'
                    }}
                    onMouseEnter={(e) => { if (deleting !== chunk.id) (e.target as HTMLElement).style.background = '#dc2626' }}
                    onMouseLeave={(e) => { if (deleting !== chunk.id) (e.target as HTMLElement).style.background = '#ef4444' }}
                  >
                    {deleting === chunk.id ? 'Deleting...' : 'Delete'}
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Premium Pagination Controls */}
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginTop: '24px',
            padding: '12px 0',
            borderTop: '1px solid var(--border)',
            flexWrap: 'wrap',
            gap: '12px'
          }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              Showing {filteredChunks.length > 0 ? startIndex + 1 : 0}–{Math.min(startIndex + pageSize, filteredChunks.length)} of {filteredChunks.length} chunks
            </span>
            {totalPages > 1 && (
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <button
                  onClick={() => setCurrentPage(p => Math.max(p - 1, 1))}
                  disabled={currentPage === 1}
                  style={{
                    background: currentPage === 1 ? 'transparent' : 'var(--bg-elevated)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-sm)',
                    padding: '6px 12px',
                    color: currentPage === 1 ? 'var(--text-muted)' : 'var(--text-primary)',
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    cursor: currentPage === 1 ? 'not-allowed' : 'pointer',
                    transition: 'all 0.15s ease'
                  }}
                >
                  Previous
                </button>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', padding: '0 8px', fontFamily: 'var(--font-mono)' }}>
                  Page {currentPage} of {totalPages}
                </span>
                <button
                  onClick={() => setCurrentPage(p => Math.min(p + 1, totalPages))}
                  disabled={currentPage === totalPages}
                  style={{
                    background: currentPage === totalPages ? 'transparent' : 'var(--bg-elevated)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-sm)',
                    padding: '6px 12px',
                    color: currentPage === totalPages ? 'var(--text-muted)' : 'var(--text-primary)',
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    cursor: currentPage === totalPages ? 'not-allowed' : 'pointer',
                    transition: 'all 0.15s ease'
                  }}
                >
                  Next
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
