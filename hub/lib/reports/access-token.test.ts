import { describe, it, expect } from 'vitest'
import { coversScopes } from './access-token'

const ANALYTICS = 'https://www.googleapis.com/auth/analytics.readonly'
const GSC = 'https://www.googleapis.com/auth/webmasters.readonly'
const DRIVE = 'https://www.googleapis.com/auth/drive.file'

describe('coversScopes', () => {
  it('accepts a grant containing every required scope', () => {
    expect(coversScopes(`${DRIVE} ${ANALYTICS} ${GSC}`, [ANALYTICS, GSC])).toBe(true)
  })

  it('rejects a grant missing one required scope', () => {
    // The granular-consent case: Drive granted, Analytics unchecked. Minting
    // still succeeds, so only the recorded scope string reveals this.
    expect(coversScopes(`${DRIVE} ${GSC}`, [ANALYTICS, GSC])).toBe(false)
  })

  it('treats an unknown (null) scope as covering', () => {
    // Grants recorded before the column was populated must not be locked out.
    expect(coversScopes(null, [ANALYTICS])).toBe(true)
    expect(coversScopes(undefined, [ANALYTICS])).toBe(true)
    expect(coversScopes('', [ANALYTICS])).toBe(true)
  })

  it('requires nothing when no scopes are required', () => {
    expect(coversScopes(DRIVE, [])).toBe(true)
  })

  it('tolerates irregular whitespace between scopes', () => {
    expect(coversScopes(`  ${ANALYTICS}   ${GSC}  `, [ANALYTICS, GSC])).toBe(true)
  })

  it('does not match on a scope prefix', () => {
    expect(coversScopes('https://www.googleapis.com/auth/analytics', [ANALYTICS])).toBe(false)
  })
})
