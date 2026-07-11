'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import type { ChatAttachment } from '@/types'

/* ══════════════════════════════════════════════════════════════════════════════
   SVG ICONS — Professional stroke-based inline icons
   ══════════════════════════════════════════════════════════════════════════════ */

const PlusIcon = () => (
  <span className="rx-icon rx-icon--sm">
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </svg>
  </span>
)

const DocumentIcon = () => (
  <span className="rx-icon rx-icon--sm">
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <line x1="10" y1="9" x2="8" y2="9" />
    </svg>
  </span>
)

const LinkIcon = () => (
  <span className="rx-icon rx-icon--sm">
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  </span>
)

const TextIcon = () => (
  <span className="rx-icon rx-icon--sm">
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M4 22h14a2 2 0 0 0 2-2V7.5L14.5 2H6a2 2 0 0 0-2 2v4" />
      <polyline points="14 2 14 8 20 8" />
      <path d="M2 15h10" />
      <path d="M2 18h10" />
      <path d="M2 21h10" />
    </svg>
  </span>
)

const BackArrowIcon = () => (
  <span className="rx-icon rx-icon--sm">
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="12 19 5 12 12 5" />
    </svg>
  </span>
)

const CloseXIcon = () => (
  <span className="rx-icon" style={{width: '12px', height: '12px'}}>
    <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  </span>
)

/* ══════════════════════════════════════════════════════════════════════════════
   DRIVE FILE ICON — SVG-based file type indicator
   ══════════════════════════════════════════════════════════════════════════════ */

function getDriveFileIcon(mimeType: string): string {
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel')) return '📊'
  if (mimeType.includes('document') || mimeType.includes('word')) return '📄'
  if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return '📑'
  if (mimeType.includes('pdf')) return '📕'
  if (mimeType.includes('image')) return '🖼️'
  if (mimeType.includes('video')) return '🎬'
  if (mimeType.includes('audio')) return '🎵'
  if (mimeType.includes('folder')) return '📁'
  if (mimeType.includes('form')) return '📋'
  return '📄'
}

/* ══════════════════════════════════════════════════════════════════════════════
   UTILITY — format relative date
   ══════════════════════════════════════════════════════════════════════════════ */

function formatRelativeDate(isoString: string): string {
  try {
    const d = new Date(isoString)
    const now = new Date()
    const diffMs = now.getTime() - d.getTime()
    const diffMins = Math.floor(diffMs / 60_000)
    const diffHours = Math.floor(diffMs / 3_600_000)
    const diffDays = Math.floor(diffMs / 86_400_000)

    if (diffMins < 1) return 'just now'
    if (diffMins < 60) return `${diffMins}m ago`
    if (diffHours < 24) return `${diffHours}h ago`
    if (diffDays < 7) return `${diffDays}d ago`
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  } catch {
    return isoString
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
   TYPES
   ══════════════════════════════════════════════════════════════════════════════ */

interface ContextAttachMenuProps {
  onAttach: (attachment: Omit<ChatAttachment, 'id'>) => void
  disabled?: boolean
}

interface AttachmentChipsProps {
  attachments: ChatAttachment[]
  onRemove: (id: string) => void
  readOnly?: boolean
}

type SubView = 'menu' | 'document' | 'url' | 'text'

interface DriveFileItem {
  id: string
  name: string
  mimeType: string
  modifiedTime: string
}

/* ══════════════════════════════════════════════════════════════════════════════
   CONTEXT ATTACH MENU
   ══════════════════════════════════════════════════════════════════════════════ */

export function ContextAttachMenu({ onAttach, disabled }: ContextAttachMenuProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [subView, setSubView] = useState<SubView>('menu')
  const anchorRef = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return

    function handleClick(e: MouseEvent) {
      if (anchorRef.current && !anchorRef.current.contains(e.target as Node)) {
        setIsOpen(false)
        setSubView('menu')
      }
    }

    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setIsOpen(false)
        setSubView('menu')
      }
    }

    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [isOpen])

  const handleToggle = useCallback(() => {
    if (isOpen) {
      setIsOpen(false)
      setSubView('menu')
    } else {
      setIsOpen(true)
      setSubView('menu')
    }
  }, [isOpen])

  const handleAttach = useCallback(
    (attachment: Omit<ChatAttachment, 'id'>) => {
      onAttach(attachment)
      setIsOpen(false)
      setSubView('menu')
    },
    [onAttach]
  )

  const handleBack = useCallback(() => setSubView('menu'), [])

  return (
    <div className="context-attach-anchor" ref={anchorRef}>
      {/* Popover */}
      {isOpen && (
        <div
          className="context-attach-popover"
          role="dialog"
          aria-label="Attach context"
        >
          {subView === 'menu' && (
            <MenuView onSelect={setSubView} />
          )}
          {subView === 'document' && (
            <DocumentSubView onAttach={handleAttach} onBack={handleBack} />
          )}
          {subView === 'url' && (
            <URLSubView onAttach={handleAttach} onBack={handleBack} />
          )}
          {subView === 'text' && (
            <TextSubView onAttach={handleAttach} onBack={handleBack} />
          )}
        </div>
      )}

      {/* Trigger button */}
      <button
        type="button"
        className={`context-attach-btn${isOpen ? ' context-attach-btn--open' : ''}`}
        onClick={handleToggle}
        disabled={disabled}
        aria-label={isOpen ? 'Close attach menu' : 'Attach context'}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
      >
        <span className="context-attach-btn__icon">
          <PlusIcon />
        </span>
      </button>
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════════════════
   MENU VIEW — Three options
   ══════════════════════════════════════════════════════════════════════════════ */

function MenuView({ onSelect }: { onSelect: (view: SubView) => void }) {
  return (
    <div role="menu" aria-label="Attachment options">
      <button
        role="menuitem"
        className="context-attach-option"
        onClick={() => onSelect('document')}
      >
        <span className="context-attach-option__icon">
          <DocumentIcon />
        </span>
        <span className="context-attach-option__label">Document</span>
      </button>
      <button
        role="menuitem"
        className="context-attach-option"
        onClick={() => onSelect('url')}
      >
        <span className="context-attach-option__icon">
          <LinkIcon />
        </span>
        <span className="context-attach-option__label">Link</span>
      </button>
      <button
        role="menuitem"
        className="context-attach-option"
        onClick={() => onSelect('text')}
      >
        <span className="context-attach-option__icon">
          <TextIcon />
        </span>
        <span className="context-attach-option__label">Text</span>
      </button>
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════════════════
   DOCUMENT SUB-VIEW — Drive file picker
   ══════════════════════════════════════════════════════════════════════════════ */

function DocumentSubView({
  onAttach,
  onBack,
}: {
  onAttach: (a: Omit<ChatAttachment, 'id'>) => void
  onBack: () => void
}) {
  const [recentFiles, setRecentFiles] = useState<DriveFileItem[]>([])
  const [searchResults, setSearchResults] = useState<DriveFileItem[] | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSearching, setIsSearching] = useState(false)
  const [search, setSearch] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Fetch 30 recent files on mount
  useEffect(() => {
    let cancelled = false
    setIsLoading(true)

    fetch('/api/google/drive?filter=recent&maxResults=30')
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load')
        return res.json()
      })
      .then((data: { files: DriveFileItem[] }) => {
        if (!cancelled) {
          setRecentFiles(data.files ?? [])
          setIsLoading(false)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRecentFiles([])
          setIsLoading(false)
        }
      })

    return () => { cancelled = true }
  }, [])

  // Auto-focus search
  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  // Debounced server-side search when 3+ chars typed
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)

    const query = search.trim()
    if (query.length < 3) {
      setSearchResults(null)
      setIsSearching(false)
      return
    }

    setIsSearching(true)
    debounceRef.current = setTimeout(() => {
      const driveQuery = `name contains '${query.replace(/'/g, "\\'")}'`
      fetch(`/api/google/drive?filter=recent&maxResults=20&q=${encodeURIComponent(driveQuery)}`)
        .then((res) => {
          if (!res.ok) throw new Error('Search failed')
          return res.json()
        })
        .then((data: { files: DriveFileItem[] }) => {
          setSearchResults(data.files ?? [])
          setIsSearching(false)
        })
        .catch(() => {
          setSearchResults([])
          setIsSearching(false)
        })
    }, 300)

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [search])

  // If searching server-side, show those results; otherwise filter recent client-side
  const displayFiles = searchResults !== null
    ? searchResults
    : search.trim()
      ? recentFiles.filter((f) =>
          f.name.toLowerCase().includes(search.toLowerCase())
        )
      : recentFiles

  const isServerSearch = searchResults !== null
  const showLoading = isLoading || isSearching

  return (
    <div className="context-attach-subview">
      <div className="context-attach-subview__header">
        <button
          className="context-attach-subview__back"
          onClick={onBack}
          aria-label="Back to menu"
        >
          <BackArrowIcon />
        </button>
        <span className="context-attach-subview__title">Attach Document</span>
      </div>

      <input
        ref={searchRef}
        type="text"
        className="context-attach-search-input"
        placeholder="Search all of Google Drive..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        aria-label="Search Google Drive"
      />

      {/* Search mode indicator */}
      {search.trim().length > 0 && search.trim().length < 3 && (
        <div className="context-attach-search-hint">
          Type {3 - search.trim().length} more character{3 - search.trim().length !== 1 ? 's' : ''} to search all of Drive
        </div>
      )}
      {isServerSearch && !isSearching && (
        <div className="context-attach-search-hint">
          Showing results from entire Google Drive
        </div>
      )}

      <div className="context-attach-file-list" role="listbox" aria-label="Drive files">
        {showLoading ? (
          <div className="context-attach-file-loading">
            {isSearching ? 'Searching Drive…' : 'Loading files…'}
          </div>
        ) : displayFiles.length === 0 ? (
          <div className="context-attach-file-empty">
            {search ? 'No matching files found' : 'No recent files'}
          </div>
        ) : (
          displayFiles.map((file) => (
            <button
              key={file.id}
              role="option"
              // These rows attach-and-close on click — there is no persistent
              // selected state — so `aria-selected` is always false. Required by
              // the listbox/option contract (clears role-has-required-aria-props).
              aria-selected={false}
              className="context-attach-file-row"
              onClick={() =>
                onAttach({
                  type: 'document',
                  label: file.name,
                  fileId: file.id,
                  mimeType: file.mimeType,
                })
              }
              aria-label={`Attach ${file.name}`}
            >
              <span className="context-attach-file-row__icon" aria-hidden="true">
                {getDriveFileIcon(file.mimeType)}
              </span>
              <div className="context-attach-file-row__info">
                <div className="context-attach-file-row__name">{file.name}</div>
                <div className="context-attach-file-row__meta">
                  {formatRelativeDate(file.modifiedTime)}
                </div>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════════════════
   URL SUB-VIEW — Link input
   ══════════════════════════════════════════════════════════════════════════════ */

function URLSubView({
  onAttach,
  onBack,
}: {
  onAttach: (a: Omit<ChatAttachment, 'id'>) => void
  onBack: () => void
}) {
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const isValid = /^https?:\/\/.+/.test(url.trim())

  const handleSubmit = useCallback(() => {
    const trimmed = url.trim()
    if (!trimmed) return

    if (!isValid) {
      setError('URL must start with http:// or https://')
      return
    }

    // Truncate label to domain + first path segment
    let label = trimmed
    try {
      const parsed = new URL(trimmed)
      const pathParts = parsed.pathname.split('/').filter(Boolean)
      if (pathParts.length === 0) {
        label = parsed.hostname + ' (homepage)'
      } else {
        label = parsed.hostname + '/' + pathParts[0]
        if (pathParts.length > 1) label += '/…'
      }
    } catch {
      // keep full URL as label
    }

    onAttach({ type: 'url', label, url: trimmed })
  }, [url, isValid, onAttach])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        handleSubmit()
      }
    },
    [handleSubmit]
  )

  return (
    <div className="context-attach-subview">
      <div className="context-attach-subview__header">
        <button
          className="context-attach-subview__back"
          onClick={onBack}
          aria-label="Back to menu"
        >
          <BackArrowIcon />
        </button>
        <span className="context-attach-subview__title">Attach Link</span>
      </div>

      <input
        ref={inputRef}
        type="url"
        className="context-attach-url-input"
        placeholder="Paste a URL..."
        value={url}
        onChange={(e) => {
          setUrl(e.target.value)
          setError('')
        }}
        onKeyDown={handleKeyDown}
        aria-label="URL input"
        aria-invalid={!!error}
      />

      {error && <div className="context-attach-url-error" role="alert">{error}</div>}

      <button
        className="context-attach-submit-btn"
        onClick={handleSubmit}
        disabled={!url.trim()}
      >
        Attach
      </button>
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════════════════
   TEXT SUB-VIEW — Paste context
   ══════════════════════════════════════════════════════════════════════════════ */

const MAX_TEXT_LENGTH = 10000

function TextSubView({
  onAttach,
  onBack,
}: {
  onAttach: (a: Omit<ChatAttachment, 'id'>) => void
  onBack: () => void
}) {
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  const isOverLimit = text.length > MAX_TEXT_LENGTH
  const canSubmit = text.trim().length > 0 && !isOverLimit

  const handleSubmit = useCallback(() => {
    if (!canSubmit) return
    onAttach({
      type: 'text',
      label: 'Pasted text',
      content: text.trim(),
    })
  }, [text, canSubmit, onAttach])

  return (
    <div className="context-attach-subview">
      <div className="context-attach-subview__header">
        <button
          className="context-attach-subview__back"
          onClick={onBack}
          aria-label="Back to menu"
        >
          <BackArrowIcon />
        </button>
        <span className="context-attach-subview__title">Paste Context</span>
      </div>

      <textarea
        ref={textareaRef}
        className="context-attach-textarea"
        rows={4}
        placeholder="Paste text, notes, or context..."
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="Context text"
        maxLength={MAX_TEXT_LENGTH + 100} // allow slight overshoot for UX
      />

      <div
        className={`context-attach-char-count${isOverLimit ? ' context-attach-char-count--over' : ''}`}
        aria-live="polite"
      >
        {text.length.toLocaleString()} / {MAX_TEXT_LENGTH.toLocaleString()}
      </div>

      <button
        className="context-attach-submit-btn"
        onClick={handleSubmit}
        disabled={!canSubmit}
      >
        Attach
      </button>
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════════════════
   ATTACHMENT CHIPS — Display attached items with remove option
   ══════════════════════════════════════════════════════════════════════════════ */

function ChipTypeIcon({ type }: { type: ChatAttachment['type'] }) {
  switch (type) {
    case 'document':
      return <DocumentIcon />
    case 'url':
      return <LinkIcon />
    case 'text':
      return <TextIcon />
    default:
      return <DocumentIcon />
  }
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + '…' : str
}

export function AttachmentChips({ attachments, onRemove, readOnly }: AttachmentChipsProps) {
  if (attachments.length === 0) return null

  return (
    <div className="attachment-chips" aria-label="Attached context">
      {attachments.map((att) => (
        <div
          key={att.id}
          className={`attachment-chip${readOnly ? ' attachment-chip--readonly' : ''}`}
          title={att.label}
        >
          <span className="attachment-chip__icon" aria-hidden="true">
            <ChipTypeIcon type={att.type} />
          </span>
          <span className="attachment-chip__label">
            {truncate(att.label, 24)}
          </span>
          {!readOnly && (
            <button
              className="attachment-chip__remove"
              onClick={() => onRemove(att.id)}
              aria-label={`Remove ${att.label}`}
            >
              <CloseXIcon />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
