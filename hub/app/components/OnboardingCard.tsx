'use client'

import { useState, useEffect } from 'react'
import { useSession } from 'next-auth/react'
import { useTenant } from '@/app/components/TenantProvider'

const ONBOARDED_KEY = 'hub-onboarded'

interface OnboardingCardProps {
  onDismiss: () => void
}

function PanelDiagram() {
  return (
    <div className="ob-card__diagram">
      <div className="ob-panel ob-panel--left">
        <div className="ob-panel__icon">📋</div>
        <div className="ob-panel__label">Context</div>
        <div className="ob-panel__sub">Tasks · Calendar · Files · KPIs</div>
      </div>
      <div className="ob-panel ob-panel--center">
        <div className="ob-panel__icon">✦</div>
        <div className="ob-panel__label">Command</div>
        <div className="ob-panel__sub">Chat with your AI orchestrator</div>
      </div>
      <div className="ob-panel ob-panel--right">
        <div className="ob-panel__icon">⚡</div>
        <div className="ob-panel__label">Execution</div>
        <div className="ob-panel__sub">Agent runs · Activity feed</div>
        <div className="ob-panel__locked">Unlocks after role assigned</div>
      </div>
    </div>
  )
}

export function OnboardingCard({ onDismiss }: OnboardingCardProps) {
  const tenant = useTenant()
  const { data: session } = useSession()
  const [mounted, setMounted] = useState(false)
  const [exiting, setExiting] = useState(false)

  useEffect(() => {
    // Delay mount for entrance animation
    const t = setTimeout(() => setMounted(true), 50)
    return () => clearTimeout(t)
  }, [])

  // Self-register as onboarding so admin can see this user in /settings
  useEffect(() => {
    if (!session?.user?.email) return
    fetch('/api/auth/register', { method: 'POST' }).catch(() => {
      // Non-fatal — user still has onboarding role
    })
  }, [session?.user?.email])

  const handleDismiss = () => {
    setExiting(true)
    try { localStorage.setItem(ONBOARDED_KEY, '1') } catch {}
    setTimeout(onDismiss, 400)
  }

  return (
    <div
      className={`ob-overlay ${mounted ? 'ob-overlay--visible' : ''} ${exiting ? 'ob-overlay--exit' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to the Hub"
    >
      <div className={`ob-card ${mounted ? 'ob-card--visible' : ''} ${exiting ? 'ob-card--exit' : ''}`}>
        {/* Gold accent line */}
        <div className="ob-card__accent-line" />

        {/* Logo */}
        <div className="ob-card__logo" aria-label={`${tenant.name} Hub`}>
          <span className="ob-card__logo-accent">{tenant.logoText}</span>
          {' '}{tenant.logoFull}
        </div>

        {/* Headline */}
        <h1 className="ob-card__headline">
          Welcome to your<br />
          <span className="ob-card__headline-accent">Operations Hub</span>
        </h1>

        <p className="ob-card__tagline">{tenant.tagline}</p>

        {/* 3-panel diagram */}
        <PanelDiagram />

        {/* Feature list */}
        <ul className="ob-card__features">
          <li className="ob-feature">
            <span className="ob-feature__icon">✓</span>
            <span>Ask about your schedule, tasks, and files using natural language</span>
          </li>
          <li className="ob-feature">
            <span className="ob-feature__icon">✓</span>
            <span>Your Google Workspace data, surfaced intelligently in the left panel</span>
          </li>
          <li className="ob-feature">
            <span className="ob-feature__icon">◌</span>
            <span className="ob-feature--pending">Full orchestration unlocks when your admin assigns your role</span>
          </li>
        </ul>

        {/* CTA */}
        <button
          className="ob-card__cta"
          onClick={handleDismiss}
          autoFocus
          aria-label="Start exploring the Hub"
        >
          Start Exploring →
        </button>

        <p className="ob-card__footer">
          {tenant.name} · Powered by Paperclip AI
        </p>
      </div>
    </div>
  )
}

/**
 * Checks whether the onboarding card should be shown for this device.
 * Returns false during SSR (localStorage not available).
 */
export function shouldShowOnboardingCard(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return !localStorage.getItem(ONBOARDED_KEY)
  } catch {
    return false
  }
}
