'use client'

import { useState, ReactNode, Component } from 'react'
import type { ErrorInfo } from 'react'
import styles from './LeftPanelSections.module.css'

/* ══════════════════════════════════════════════════════════════════════════════
   SKELETON — shared loading placeholder
   ══════════════════════════════════════════════════════════════════════════════ */

export function SkeletonLine({ width = '100%', height = '14px' }: { width?: string; height?: string }) {
  return (
    <div
      aria-hidden="true"
      className={styles.lpsSkeletonLine}
      style={{ width, height }}
    />
  )
}

export function SkeletonBlock({ lines = 3 }: { lines?: number }) {
  return (
    <div className={styles.lpsSkeletonBlock} aria-label="Loading" role="status">
      {Array.from({ length: lines }).map((_, i) => (
        <SkeletonLine key={i} width={`${85 - i * 12}%`} />
      ))}
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════════════════
   ERROR MESSAGE — shared error/empty fallback
   ══════════════════════════════════════════════════════════════════════════════ */

export function SectionMessage({ message, type = 'info' }: { message: string; type?: 'info' | 'error' | 'empty' }) {
  const typeClass = type === 'error' ? styles.sectionMessageError : type === 'empty' ? styles.sectionMessageEmpty : styles.sectionMessageInfo
  return (
    <div
      role={type === 'error' ? 'alert' : 'status'}
      className={`${styles.sectionMessage} ${typeClass}`}
    >
      {message}
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════════════════
   COLLAPSIBLE SECTION — reusable wrapper with animated open/close
   ══════════════════════════════════════════════════════════════════════════════ */

export function CollapsibleSection({
  title,
  protocolNum,
  defaultOpen = true,
  children,
}: {
  title: string
  protocolNum: string
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen)

  return (
    <section aria-label={title}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        aria-controls={`section-${protocolNum}`}
        className={styles.collapsibleHeader}
      >
        {/* Arrow indicator */}
        <span
          aria-hidden="true"
          className={`${styles.collapsibleHeaderArrow}${isOpen ? ' ' + styles.collapsibleHeaderArrowOpen : ''}`}
        >
          ▶
        </span>

        {/* Protocol number */}
        <span className="rx-comment-label">{protocolNum} //</span>

        {/* Title */}
        <span className={styles.collapsibleHeaderTitle}>
          {title}
        </span>

        {/* Line */}
        <span
          aria-hidden="true"
          className={styles.collapsibleHeaderLine}
        />
      </button>

      <div
        id={`section-${protocolNum}`}
        role="region"
        aria-label={title}
        className={`${styles.collapsibleBody} ${isOpen ? styles.collapsibleBodyOpen : styles.collapsibleBodyClosed}`}
      >
        {children}
      </div>
    </section>
  )
}

/* ══════════════════════════════════════════════════════════════════════════════
   ERROR BOUNDARY — contains a render throw to a single section
   ══════════════════════════════════════════════════════════════════════════════ */

export class SectionErrorBoundary extends Component<
  { label?: string; children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false }

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[SectionErrorBoundary]', this.props.label ?? '', error, info)
  }

  render() {
    if (this.state.hasError) {
      return (
        <SectionMessage
          message={`Unable to display ${this.props.label ?? 'this section'} — try refreshing`}
          type="error"
        />
      )
    }
    return this.props.children
  }
}
