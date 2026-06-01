'use client'

import { createContext, useContext, useEffect, useMemo } from 'react'
import { getTenantConfig, type TenantConfig } from '@/lib/tenant'

/* ── Context ── */

const TenantContext = createContext<TenantConfig | null>(null)

/* ── Hook ── */

/**
 * Access the current tenant config from any client component.
 * Must be used within a TenantProvider.
 */
export function useTenant(): TenantConfig {
  const ctx = useContext(TenantContext)
  if (!ctx) {
    throw new Error('useTenant() must be used within a <TenantProvider>')
  }
  return ctx
}

/* ── CSS Custom Property Injection ── */

/**
 * Converts a hex color to HSL components for CSS variable derivation.
 */
function hexToHSL(hex: string): { h: number; s: number; l: number } {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  if (!result) return { h: 0, s: 0, l: 0 }

  let r = parseInt(result[1], 16) / 255
  let g = parseInt(result[2], 16) / 255
  let b = parseInt(result[3], 16) / 255

  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  let h = 0
  let s = 0
  const l = (max + min) / 2

  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break
      case g: h = ((b - r) / d + 2) / 6; break
      case b: h = ((r - g) / d + 4) / 6; break
    }
  }

  return {
    h: Math.round(h * 360),
    s: Math.round(s * 100),
    l: Math.round(l * 100),
  }
}

/**
 * Converts a hex color to an rgba string with given alpha.
 */
function hexToRGBA(hex: string, alpha: number): string {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  if (!result) return `rgba(0,0,0,${alpha})`
  const r = parseInt(result[1], 16)
  const g = parseInt(result[2], 16)
  const b = parseInt(result[3], 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function injectBrandColors(config: TenantConfig): void {
  const root = document.documentElement
  const { accent, accentDim, accentBright, bgVoid, bgPrimary } = config.brandColors

  // Core accent colors
  root.style.setProperty('--accent', accent)
  root.style.setProperty('--accent-dim', accentDim)
  root.style.setProperty('--accent-bright', accentBright)
  root.style.setProperty('--text-accent', accent)

  // Accent-derived tokens
  root.style.setProperty('--accent-glow', hexToRGBA(accent, 0.18))
  root.style.setProperty('--accent-border', hexToRGBA(accent, 0.22))
  root.style.setProperty(
    '--accent-gradient',
    `linear-gradient(135deg, ${accentBright} 0%, ${accent} 50%, ${accentDim} 100%)`
  )

  // Border tokens (accent-tinted)
  root.style.setProperty('--border', hexToRGBA(accent, 0.12))
  root.style.setProperty('--border-accent', hexToRGBA(accent, 0.22))
  root.style.setProperty('--border-hover', hexToRGBA(accent, 0.38))

  // Shadow glow tokens
  root.style.setProperty('--shadow-glow', `0 0 24px ${hexToRGBA(accent, 0.14)}`)
  root.style.setProperty('--shadow-glow-strong', `0 0 40px ${hexToRGBA(accent, 0.22)}`)

  // Background colors — derive card/elevated/hover/active from primary HSL
  const bgPrimaryHSL = hexToHSL(bgPrimary)
  root.style.setProperty('--bg-void', bgVoid)
  root.style.setProperty('--bg-primary', bgPrimary)
  root.style.setProperty('--bg-card', `hsl(${bgPrimaryHSL.h}, ${Math.max(bgPrimaryHSL.s - 2, 0)}%, ${bgPrimaryHSL.l + 4}%)`)
  root.style.setProperty('--bg-elevated', `hsl(${bgPrimaryHSL.h}, ${Math.max(bgPrimaryHSL.s - 4, 0)}%, ${bgPrimaryHSL.l + 8}%)`)
  root.style.setProperty('--bg-hover', `hsl(${bgPrimaryHSL.h}, ${Math.max(bgPrimaryHSL.s - 6, 0)}%, ${bgPrimaryHSL.l + 11}%)`)
  root.style.setProperty('--bg-active', `hsl(${bgPrimaryHSL.h}, ${Math.max(bgPrimaryHSL.s - 8, 0)}%, ${bgPrimaryHSL.l + 14}%)`)
  root.style.setProperty('--bg-input', `hsl(${bgPrimaryHSL.h}, ${Math.max(bgPrimaryHSL.s + 5, 0)}%, ${Math.max(bgPrimaryHSL.l - 4, 0)}%)`)
}

/* ── Provider Component ── */

export function TenantProvider({ children }: { children: React.ReactNode }) {
  const config = useMemo(() => getTenantConfig(), [])

  // Inject brand colors as CSS custom properties on mount + theme change
  useEffect(() => {
    injectBrandColors(config)

    // Re-inject when theme toggles (data-theme attribute changes)
    const observer = new MutationObserver(() => {
      injectBrandColors(config)
    })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
    return () => observer.disconnect()
  }, [config])

  // Update document title
  useEffect(() => {
    document.title = `${config.name} Hub — ${config.tagline}`
  }, [config])

  return (
    <TenantContext.Provider value={config}>
      {children}
    </TenantContext.Provider>
  )
}
