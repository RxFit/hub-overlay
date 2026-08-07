import { describe, it, expect } from 'vitest'
import { buildDriveQuery, rankByOwnActivity } from './drive-query'

describe('buildDriveQuery', () => {
  it('default "recent" windows by modifiedTime, spans all drives, and asks for own-edit re-ranking', () => {
    const plan = buildDriveQuery('recent', undefined, undefined)
    expect(plan.query).toContain('modifiedTime > ')
    expect(plan.query).toContain("mimeType != 'video/mp4'")
    expect(plan.rankByMyEdits).toBe(true)
    expect(plan.corpora).toBe('allDrives')
  })

  it('a custom q (attach-menu search) is a plain filtered listing — no re-ranking, all drives', () => {
    const plan = buildDriveQuery('recent', "name contains 'foo'", undefined)
    expect(plan.query).toContain("name contains 'foo'")
    expect(plan.rankByMyEdits).toBeUndefined()
    expect(plan.corpora).toBe('allDrives')
  })

  it('shared filter lists sharedWithMe in the USER corpus — sharedWithMe is invalid with corpora=allDrives', () => {
    const plan = buildDriveQuery('shared', undefined, undefined)
    expect(plan.query).toContain('sharedWithMe = true')
    expect(plan.rankByMyEdits).toBeUndefined()
    expect(plan.corpora).toBeUndefined()
  })

  it('transcripts without a configured folder returns empty instead of leaking cross-tenant', () => {
    expect(buildDriveQuery('transcripts', undefined, undefined)).toEqual({ empty: true })
    const plan = buildDriveQuery('transcripts', undefined, 'folder1')
    expect(plan.query).toContain("'folder1' in parents")
    expect(plan.corpora).toBe('allDrives')
  })
})

/* The Documents panel's "Recent" tab must show the docs the USER worked on
   first. Plain `modifiedTime desc` ranks by ANYONE's edits, so in an active
   org other people's churn displaced the user's own documents off the page —
   the "I don't see any doc I recently worked on" report. */
describe('rankByOwnActivity', () => {
  const f = (id: string, modifiedTime: string, modifiedByMeTime?: string) => ({
    id, modifiedTime, modifiedByMeTime,
  })

  it('puts files the user edited first, newest own-edit first', () => {
    const ranked = rankByOwnActivity([
      f('other-newest', '2026-08-06T10:00:00Z'),
      f('mine-old', '2026-08-01T09:00:00Z', '2026-08-01T09:00:00Z'),
      f('mine-new', '2026-08-05T09:00:00Z', '2026-08-05T09:00:00Z'),
      f('other-older', '2026-08-04T10:00:00Z'),
    ])
    expect(ranked.map(x => x.id)).toEqual(['mine-new', 'mine-old', 'other-newest', 'other-older'])
  })

  it('orders the remainder by plain modifiedTime desc', () => {
    const ranked = rankByOwnActivity([
      f('b', '2026-08-02T00:00:00Z'),
      f('a', '2026-08-03T00:00:00Z'),
    ])
    expect(ranked.map(x => x.id)).toEqual(['a', 'b'])
  })

  it('handles an all-mine list and an all-others list', () => {
    expect(rankByOwnActivity([f('m', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')])).toHaveLength(1)
    expect(rankByOwnActivity([f('o', '2026-08-01T00:00:00Z')])).toHaveLength(1)
    expect(rankByOwnActivity([])).toEqual([])
  })
})
