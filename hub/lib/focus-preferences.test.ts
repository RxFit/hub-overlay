import { describe, it, expect } from 'vitest'
import {
  normalizeFocusPreferences,
  matchVip,
  focusPreferencesSignature,
  MAX_VIPS,
  MAX_GOALS_LENGTH,
  type FocusVip,
} from './focus-preferences'

describe('normalizeFocusPreferences', () => {
  it('keeps valid vips + goals and defaults missing pieces', () => {
    const out = normalizeFocusPreferences({
      goals: 'Close the Q3 deal',
      vips: [{ value: 'sarah@acme.com', category: 'business' }, { value: 'mom', category: 'personal' }],
    })
    expect(out.goals).toBe('Close the Q3 deal')
    expect(out.vips).toEqual([
      { value: 'sarah@acme.com', category: 'business' },
      { value: 'mom', category: 'personal' },
    ])
  })

  it('returns empty prefs for garbage / missing input', () => {
    expect(normalizeFocusPreferences(null)).toEqual({ vips: [], goals: '' })
    expect(normalizeFocusPreferences({})).toEqual({ vips: [], goals: '' })
    expect(normalizeFocusPreferences({ vips: 'nope', goals: 42 })).toEqual({ vips: [], goals: '' })
  })

  it('drops malformed / too-short vip entries and dedupes case-insensitively (first wins)', () => {
    const out = normalizeFocusPreferences({
      vips: [
        { value: 'A', category: 'business' },           // too short (< MIN)
        { value: '  ', category: 'business' },           // blank
        { value: 'Sarah@Acme.com', category: 'business' },
        { value: 'sarah@acme.com', category: 'personal' }, // dup (case-insensitive) → dropped
        { nope: true },                                  // not a vip object
        { value: 'bob@x.com' },                          // missing category → business
      ],
      goals: '',
    })
    expect(out.vips).toEqual([
      { value: 'Sarah@Acme.com', category: 'business' },
      { value: 'bob@x.com', category: 'business' },
    ])
  })

  it('coerces an unknown category to business', () => {
    const [v] = normalizeFocusPreferences({ vips: [{ value: 'x@y.com', category: 'urgent' }] }).vips
    expect(v.category).toBe('business')
  })

  it('caps the vip count and clamps goals length', () => {
    const many = Array.from({ length: MAX_VIPS + 20 }, (_, i) => ({ value: `v${i}@x.com`, category: 'business' as const }))
    const out = normalizeFocusPreferences({ vips: many, goals: 'g'.repeat(MAX_GOALS_LENGTH + 500) })
    expect(out.vips).toHaveLength(MAX_VIPS)
    expect(out.goals.length).toBe(MAX_GOALS_LENGTH)
  })

  it('strips control characters / newlines from values and goals', () => {
    const out = normalizeFocusPreferences({
      vips: [{ value: 'a@b.com\n\t', category: 'business' }],
      goals: 'line1\nline2',
    })
    expect(out.vips[0].value).toBe('a@b.com')
    expect(out.goals).not.toMatch(/[\r\n\t]/)
  })
})

describe('matchVip', () => {
  const vips: FocusVip[] = [
    { value: 'sarah@acme.com', category: 'business' },
    { value: '@partner.io', category: 'business' },
    { value: 'Mom', category: 'personal' },
  ]

  it('matches by full email, by domain fragment, and by name — case-insensitively', () => {
    expect(matchVip('Sarah Allen <SARAH@acme.com>', vips)?.value).toBe('sarah@acme.com')
    expect(matchVip('Jane <jane@partner.io>', vips)?.category).toBe('business')
    expect(matchVip('mom <family@gmail.com>', vips)?.category).toBe('personal')
  })

  it('returns null when nothing matches or the list is empty', () => {
    expect(matchVip('stranger@nowhere.com', vips)).toBeNull()
    expect(matchVip('anyone@x.com', [])).toBeNull()
    expect(matchVip('', vips)).toBeNull()
  })
})

describe('focusPreferencesSignature', () => {
  it('is a constant for empty prefs', () => {
    expect(focusPreferencesSignature({ vips: [], goals: '' })).toBe('p0')
  })

  it('changes when vips or goals change, but not when vips are merely reordered', () => {
    const a = focusPreferencesSignature({ vips: [{ value: 'x@y.com', category: 'business' }], goals: 'g' })
    const reordered = focusPreferencesSignature({
      vips: [{ value: 'b@y.com', category: 'business' }, { value: 'a@y.com', category: 'business' }],
      goals: 'g',
    })
    const sameReordered = focusPreferencesSignature({
      vips: [{ value: 'a@y.com', category: 'business' }, { value: 'b@y.com', category: 'business' }],
      goals: 'g',
    })
    expect(a).not.toBe(reordered)
    expect(reordered).toBe(sameReordered) // order-independent
    expect(focusPreferencesSignature({ vips: [{ value: 'x@y.com', category: 'business' }], goals: 'DIFFERENT' })).not.toBe(a)
  })
})
