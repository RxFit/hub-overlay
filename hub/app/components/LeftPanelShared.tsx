'use client'

import { useState, ReactNode, Component } from 'react'
import type { ErrorInfo } from 'react'
import { signIn } from 'next-auth/react'
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

export function SectionMessage({
  message,
  type = 'info',
  action,
}: {
  message: string
  type?: 'info' | 'error' | 'empty'
  /** Optional recovery affordance rendered under the message (e.g. "Sign in again"). */
  action?: { label: string; onClick: () => void }
}) {
  const typeClass = type === 'error' ? styles.sectionMessageError : type === 'empty' ? styles.sectionMessageEmpty : styles.sectionMessageInfo
  return (
    <div
      role={type === 'error' ? 'alert' : 'status'}
      className={`${styles.sectionMessage} ${typeClass}`}
      style={action ? { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '8px' } : undefined}
    >
      <span>{message}</span>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          style={{
            padding: '4px 12px',
            background: 'var(--surface-2)',
            border: '1px solid var(--border)',
            borderRadius: '6px',
            color: 'var(--text-primary)',
            fontSize: '0.72rem',
            cursor: 'pointer',
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  )
}

/**
 * The Left Panel's expired-session state, WITH the way out.
 *
 * The audit (docs/left-panel-audit/02) found the documented 401→reauth path was
 * dead code — `useAuthErrorRecovery` is mounted by no component — so "Session
 * expired — please sign in again" rendered as a dead end: text telling the user
 * to do something the UI offered no way to do. This is the planned replacement:
 * an explicit, user-initiated re-auth. No `prompt` on signIn — with the grant
 * already on file Google completes it silently, so a routine expiry costs one
 * click and no consent screen.
 */
export function AuthExpiredMessage({ message = 'Google session expired' }: { message?: string }) {
  return (
    <SectionMessage
      message={message}
      type="error"
      action={{ label: 'Sign in again', onClick: () => signIn('google') }}
    />
  )
}

/**
 * Distinct FETCH-FAILURE state with a Retry affordance — used where an error
 * must not be conflated with a genuinely-empty section (KPIs, Project Health).
 * A 401 is left to the app's reauth flow; this covers 5xx / network failures.
 */
export function SectionError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className={`${styles.sectionMessage} ${styles.sectionMessageError}`}
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '8px' }}
    >
      <span>{message}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          style={{
            padding: '4px 12px',
            background: 'var(--surface-2)',
            border: '1px solid var(--border)',
            borderRadius: '6px',
            color: 'var(--text-primary)',
            fontSize: '0.72rem',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Retry
        </button>
      )}
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
        <span className="rx-comment-label">{protocolNum}{' //'}</span>

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
