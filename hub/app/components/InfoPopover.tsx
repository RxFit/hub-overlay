'use client'

import { useState, useRef, useEffect } from 'react'

interface InfoPopoverProps {
  content: React.ReactNode
  align?: 'left' | 'right'
}

export function InfoPopover({ content, align = 'right' }: InfoPopoverProps) {
  const [isOpen, setIsOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isOpen) return
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen])

  return (
    <div className="info-popover" ref={containerRef}>
      <button
        type="button"
        className="info-popover__trigger"
        onClick={() => setIsOpen(prev => !prev)}
        aria-label="More information"
        aria-expanded={isOpen}
      >
        ?
      </button>
      {isOpen && (
        <div className={`info-popover__content info-popover__content--align-${align}`} role="tooltip">
          <button
            type="button"
            className="info-popover__close"
            onClick={() => setIsOpen(false)}
            aria-label="Close tooltip"
          >
            ✕
          </button>
          <div className="info-popover__body">
            {content}
          </div>
        </div>
      )}
    </div>
  )
}
