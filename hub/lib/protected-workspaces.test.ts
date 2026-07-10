import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/* ════════════════════════════════════════════════════════════════════════════
   lib/protected-workspaces — the single source of truth for undeletable
   Paperclip companies. `getProtectedCompanyIds` must collect the config-pinned
   ids + DEFAULT_PAPERCLIP_COMPANY_ID + PROTECTED_COMPANY_IDS, read env LAZILY,
   ignore empty/unset entries, dedupe, and normalize case; `isProtectedCompany`
   is case-insensitive and whitespace-tolerant.
   ════════════════════════════════════════════════════════════════════════════ */

const { CFG_ENTERPRISE, CFG_CEO } = vi.hoisted(() => ({
  CFG_ENTERPRISE: 'aaaaaaaa-0000-0000-0000-00000000000a',
  CFG_CEO: 'bbbbbbbb-0000-0000-0000-00000000000b',
}))

vi.mock('@/lib/paperclipConfig', () => ({
  RXFIT_COMPANY_ID: CFG_ENTERPRISE,
  RXFIT_CEO_COMPANY_ID: CFG_CEO,
}))

import { getProtectedCompanyIds, isProtectedCompany } from '@/lib/protected-workspaces'

const ENV_KEYS = ['DEFAULT_PAPERCLIP_COMPANY_ID', 'PROTECTED_COMPANY_IDS'] as const
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('getProtectedCompanyIds', () => {
  it('always includes the config-pinned RxFit Enterprise + CEO ids', () => {
    const ids = getProtectedCompanyIds()
    expect(ids.has(CFG_ENTERPRISE)).toBe(true)
    expect(ids.has(CFG_CEO)).toBe(true)
  })

  it('includes DEFAULT_PAPERCLIP_COMPANY_ID and PROTECTED_COMPANY_IDS entries', () => {
    process.env.DEFAULT_PAPERCLIP_COMPANY_ID = 'cccccccc-0000-0000-0000-00000000000c'
    process.env.PROTECTED_COMPANY_IDS = 'dddddddd-0000-0000-0000-00000000000d, eeeeeeee-0000-0000-0000-00000000000e'
    const ids = getProtectedCompanyIds()
    expect(ids.has('cccccccc-0000-0000-0000-00000000000c')).toBe(true)
    expect(ids.has('dddddddd-0000-0000-0000-00000000000d')).toBe(true)
    // trims surrounding whitespace on comma-separated entries
    expect(ids.has('eeeeeeee-0000-0000-0000-00000000000e')).toBe(true)
  })

  it('reads env LAZILY — a later env change is reflected on the next call', () => {
    expect(getProtectedCompanyIds().has('99999999-0000-0000-0000-000000000099')).toBe(false)
    process.env.PROTECTED_COMPANY_IDS = '99999999-0000-0000-0000-000000000099'
    expect(getProtectedCompanyIds().has('99999999-0000-0000-0000-000000000099')).toBe(true)
  })

  it('ignores empty / unset entries (never adds an empty string)', () => {
    process.env.PROTECTED_COMPANY_IDS = ',, ,'
    const ids = getProtectedCompanyIds()
    expect(ids.has('')).toBe(false)
    // only the two config ids survive
    expect(ids.size).toBe(2)
  })

  it('normalizes to lowercase and dedupes overlapping sources', () => {
    process.env.DEFAULT_PAPERCLIP_COMPANY_ID = CFG_CEO.toUpperCase()
    process.env.PROTECTED_COMPANY_IDS = `${CFG_ENTERPRISE.toUpperCase()},${CFG_ENTERPRISE}`
    const ids = getProtectedCompanyIds()
    // enterprise + ceo only — all the duplicates collapse
    expect(ids.size).toBe(2)
    expect(ids.has(CFG_ENTERPRISE)).toBe(true)
    expect(ids.has(CFG_CEO)).toBe(true)
  })
})

describe('isProtectedCompany', () => {
  it('is true for a protected id, case-insensitively', () => {
    expect(isProtectedCompany(CFG_ENTERPRISE)).toBe(true)
    expect(isProtectedCompany(CFG_ENTERPRISE.toUpperCase())).toBe(true)
  })

  it('tolerates surrounding whitespace', () => {
    expect(isProtectedCompany(`  ${CFG_CEO}  `)).toBe(true)
  })

  it('is false for a random / unpinned id', () => {
    expect(isProtectedCompany('12345678-0000-0000-0000-000000000000')).toBe(false)
  })

  it('is false for empty / null / undefined', () => {
    expect(isProtectedCompany('')).toBe(false)
    expect(isProtectedCompany(null)).toBe(false)
    expect(isProtectedCompany(undefined)).toBe(false)
  })
})
