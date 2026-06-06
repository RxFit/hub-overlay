'use client'

import { useState, useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { deleteChunk } from './actions'

type Chunk = {
  id: string
  sourceUrl: string
  content: string
  createdAt: Date
}

interface KnowledgeTableProps {
  initialChunks: Chunk[]
  totalCount: number
  currentPage: number
  pageSize: number
  searchTerm: string
}

export default function KnowledgeTable({
  initialChunks,
  totalCount,
  currentPage,
  pageSize,
  searchTerm,
}: KnowledgeTableProps) {
  const router = useRouter()
  const pathname = usePathname()

  const [chunks, setChunks] = useState(initialChunks)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [searchInputValue, setSearchInputValue] = useState(searchTerm)

  // Keep local chunks list synced with server updates
  useEffect(() => {
    setChunks(initialChunks)
  }, [initialChunks])

  // Keep search input synced with URL updates
  useEffect(() => {
    setSearchInputValue(searchTerm)
  }, [searchTerm])

  // Debounce search input and update URL query parameters
  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchInputValue.trim() === searchTerm) return

      const params = new URLSearchParams(window.location.search)
      if (searchInputValue.trim()) {
        params.set('q', searchInputValue.trim())
      } else {
        params.delete('q')
      }
      params.set('page', '1') // reset page to 1 on new search
      router.push(`${pathname}?${params.toString()}`)
    }, 400)

    return () => clearTimeout(timer)
  }, [searchInputValue, searchTerm, router, pathname])

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

  const handlePageChange = (newPage: number) => {
    const params = new URLSearchParams(window.location.search)
    params.set('page', newPage.toString())
    if (searchTerm) {
      params.set('q', searchTerm)
    }
    router.push(`${pathname}?${params.toString()}`)
  }

  const totalPages = Math.ceil(totalCount / pageSize)
  const startIndex = (currentPage - 1) * pageSize

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
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
        </span>
        <input
          type="text"
          placeholder="Search semantic database by URL or chunk content..."
          value={searchInputValue}
          onChange={(e) => setSearchInputValue(e.target.value)}
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
        {searchInputValue && (
          <button
            onClick={() => {
              setSearchInputValue('')
              const params = new URLSearchParams(window.location.search)
              params.delete('q')
              params.set('page', '1')
              router.push(`${pathname}?${params.toString()}`)
            }}
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

      {chunks.length === 0 ? (
        <div className="admin-empty">No matching chunks found.</div>
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {chunks.map(chunk => (
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
              Showing {totalCount > 0 ? startIndex + 1 : 0}–{Math.min(startIndex + pageSize, totalCount)} of {totalCount} chunks
            </span>
            {totalPages > 1 && (
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <button
                  onClick={() => handlePageChange(Math.max(currentPage - 1, 1))}
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
                  onClick={() => handlePageChange(Math.min(currentPage + 1, totalPages))}
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
