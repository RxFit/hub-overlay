import { describe, it, expect } from 'vitest'
import { buildCapabilityManifest } from './capabilities'
import { READ_TOOLS } from './registry'

/* The manifest exists so the model can never again deny a wired capability
   ("I don't have access to your GA4" — to an admin who had just configured
   the property). It must: derive from the registry (new tools self-advertise),
   reflect configured state, and carry the never-deny / retry behavior rules. */

const base = { role: 'staff', prefsKnown: true } as const

describe('buildCapabilityManifest', () => {
  it('lists every registry tool the role can run — new tools self-advertise', () => {
    const manifest = buildCapabilityManifest({ ...base })!
    for (const tool of READ_TOOLS) {
      expect(manifest).toContain(`- ${tool.name}:`)
    }
  })

  it('returns undefined for a role that can run no tools (nothing wrongly promised)', () => {
    expect(buildCapabilityManifest({ role: 'onboarding', prefsKnown: true })).toBeUndefined()
    expect(buildCapabilityManifest({ role: undefined, prefsKnown: true })).toBeUndefined()
  })

  it('shows the configured GA4/GSC state when prefs are known', () => {
    const configured = buildCapabilityManifest({
      ...base,
      ga4PropertyId: '496612345',
      gscSiteUrl: 'https://rxfitatx.com/',
    })!
    expect(configured).toContain('CONFIGURED — GA4 property 496612345')
    expect(configured).toContain('CONFIGURED — site https://rxfitatx.com/')

    const unconfigured = buildCapabilityManifest({ ...base })!
    expect(unconfigured).toContain('NOT configured yet')
    expect(unconfigured).toContain('Settings → Analytics Sources')
  })

  it('claims nothing about configuration when the prefs lookup failed', () => {
    const manifest = buildCapabilityManifest({ role: 'staff', prefsKnown: false })!
    expect(manifest).not.toContain('[CONFIGURED')
    expect(manifest).not.toContain('[NOT configured')
    // The capability list itself still renders — only the config state is unknown.
    expect(manifest).toContain('- ga4_run_report:')
  })

  it('carries the never-deny and retry-on-failure behavior rules', () => {
    const manifest = buildCapabilityManifest({ ...base })!
    expect(manifest).toContain('NEVER tell the user you lack access')
    expect(manifest).toContain('analytics.google.com')
    expect(manifest).toContain('retry or rephrase')
    expect(manifest).toContain('never invent figures')
  })

  it('uses only the first sentence of each tool description', () => {
    const manifest = buildCapabilityManifest({ ...base })!
    // The GA4 description's later sentences (API-name guidance for the
    // planner) must not bloat the manifest.
    expect(manifest).not.toContain('Metric and dimension names must be')
  })
})
