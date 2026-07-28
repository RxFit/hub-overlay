import { describe, it, expect, afterEach } from 'vitest'
import { resolvePrefs, normalizePrefsInput } from './prefs'

const ORIGINAL = { ga4: process.env.GA4_PROPERTY_ID, gsc: process.env.GSC_SITE_URL }

afterEach(() => {
  if (ORIGINAL.ga4 === undefined) delete process.env.GA4_PROPERTY_ID
  else process.env.GA4_PROPERTY_ID = ORIGINAL.ga4
  if (ORIGINAL.gsc === undefined) delete process.env.GSC_SITE_URL
  else process.env.GSC_SITE_URL = ORIGINAL.gsc
})

describe('resolvePrefs', () => {
  it('falls back to the env vars when nothing is stored', () => {
    // The existing single-tenant deploy runs on these; the KPI board must keep
    // working the moment this ships.
    process.env.GA4_PROPERTY_ID = '111'
    process.env.GSC_SITE_URL = 'https://env.example/'

    expect(resolvePrefs(null)).toMatchObject({
      ga4PropertyId: '111',
      gscSiteUrl: 'https://env.example/',
    })
  })

  it('prefers stored values over the env vars', () => {
    process.env.GA4_PROPERTY_ID = '111'
    process.env.GSC_SITE_URL = 'https://env.example/'

    expect(resolvePrefs({ ga4PropertyId: '222', gscSiteUrl: 'https://picked.example/' })).toMatchObject({
      ga4PropertyId: '222',
      gscSiteUrl: 'https://picked.example/',
    })
  })

  it('falls back per-field, not all-or-nothing', () => {
    process.env.GA4_PROPERTY_ID = '111'
    process.env.GSC_SITE_URL = 'https://env.example/'

    // An admin who picked only a GA4 property still gets the env GSC site.
    expect(resolvePrefs({ ga4PropertyId: '222' })).toMatchObject({
      ga4PropertyId: '222',
      gscSiteUrl: 'https://env.example/',
    })
  })

  it('reports undefined when neither source has a value', () => {
    delete process.env.GA4_PROPERTY_ID
    delete process.env.GSC_SITE_URL

    expect(resolvePrefs(null)).toEqual({
      ga4PropertyId: undefined,
      gscSiteUrl: undefined,
      bigqueryProjectId: undefined,
      timezone: undefined,
    })
  })
})

describe('normalizePrefsInput', () => {
  it('strips a pasted properties/ prefix', () => {
    expect(normalizePrefsInput({ ga4PropertyId: 'properties/123456' }).ga4PropertyId).toBe('123456')
  })

  it('keeps only digits in a GA4 property id', () => {
    expect(normalizePrefsInput({ ga4PropertyId: ' 123 456 ' }).ga4PropertyId).toBe('123456')
  })

  it('drops a GA4 id with no digits rather than storing junk', () => {
    expect(normalizePrefsInput({ ga4PropertyId: 'not-an-id' }).ga4PropertyId).toBeUndefined()
  })

  it('preserves sc-domain site URLs verbatim', () => {
    expect(normalizePrefsInput({ gscSiteUrl: 'sc-domain:example.com' }).gscSiteUrl).toBe(
      'sc-domain:example.com',
    )
  })

  it('treats blank strings as unset', () => {
    expect(normalizePrefsInput({ gscSiteUrl: '   ' }).gscSiteUrl).toBeUndefined()
  })

  it('never throws on junk input', () => {
    expect(() => normalizePrefsInput(null)).not.toThrow()
    expect(() => normalizePrefsInput({ ga4PropertyId: 42, gscSiteUrl: {} })).not.toThrow()
  })
})
