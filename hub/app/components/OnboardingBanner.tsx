'use client'

import { useState, useEffect } from 'react'
import { useTenant } from '@/app/components/TenantProvider'

const BANNER_SESSION_KEY = 'hub-banner-dismissed'

interface OnboardingBannerProps {
  /** Called when the banner is dismissed */
  onDismiss?: () => void
}

export function OnboardingBanner({ onDismiss }: OnboardingBannerProps) {
  const tenant = useTenant()
  const [visible, setVisible] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    // Check if dismissed this session
    try {
      if (sessionStorage.getItem(BANNER_SESSION_KEY)) {
        setDismissed(true)
        return
      }
    } catch {}
    // Animate in
    const t = setTimeout(() => setVisible(true), 200)
    return () => clearTimeout(t)
  }, [])

  const handleDismiss = () => {
    setVisible(false)
    try { sessionStorage.setItem(BANNER_SESSION_KEY, '1') } catch {}
    setTimeout(() => {
      setDismissed(true)
      onDismiss?.()
    }, 300)
  }

  if (dismissed) return null

  return (
    <div
      className={`onboarding-banner ${visible ? 'onboarding-banner--visible' : ''}`}
      role="status"
      aria-live="polite"
    >
      <span className="onboarding-banner__icon" aria-hidden="true">✦</span>
      <div className="onboarding-banner__body">
        <span className="onboarding-banner__title">
          Welcome to {tenant.name} Hub
        </span>
        <span className="onboarding-banner__sub">
          Your admin will assign your full role soon. Until then, explore your Google Workspace data below.
        </span>
      </div>
      <button
        className="onboarding-banner__dismiss"
        onClick={handleDismiss}
        aria-label="Dismiss welcome banner"
        title="Dismiss"
      >
        ✕
      </button>
    </div>
  )
}
