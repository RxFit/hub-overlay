import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * lib/deep-artifacts — the PURE half (report → artifact shape). The
 * idempotent ensure path runs against real Postgres in
 * tests/deep-artifacts-db.test.ts; here the db is stubbed so importing the
 * module never touches a connection.
 */
const { dbMock, embedMock, runsMock } = vi.hoisted(() => ({
  dbMock: { db: {}, withTransaction: vi.fn() },
  embedMock: { embedToolArtifact: vi.fn(async () => true) },
  runsMock: { getToolRunOwned: vi.fn() },
}))
vi.mock('@/lib/db', () => dbMock)
vi.mock('@/lib/tool-artifacts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tool-artifacts')>()),
  embedToolArtifact: embedMock.embedToolArtifact,
}))
vi.mock('@/lib/tool-runs', () => runsMock)

import { buildDeepRunArtifact, deepRunArtifactTitle, ensureDeepRunArtifact, ensureDeepRunArtifactForRun } from './deep-artifacts'

const REPORT = [
  '# Churn drivers',
  '',
  'Price is the driver.',
  '',
  '```json',
  JSON.stringify({
    title: 'Churn drivers',
    summary: 'Price is the driver.',
    sections: [
      { heading: 'Evidence', body: 'Three of four cohorts cite price.' },
      { heading: 'Unknowns', body: 'Support quality is unmeasured.' },
    ],
    sources: [
      { title: 'Cohort export', url: 'https://example.com/cohorts' },
      { title: 'javascript source', url: 'javascript:alert(1)' },
    ],
  }),
  '```',
].join('\n')

const RUN = {
  id: '11111111-1111-4111-8111-111111111111',
  tool: 'deep-research',
  brief: 'Why are customers churning?',
  resultMd: REPORT,
  chatId: 'chat-7',
}

describe('buildDeepRunArtifact', () => {
  it('shapes a parsable report into Summary → sections → Sources with stable ids', () => {
    const data = buildDeepRunArtifact(RUN)
    expect(data.toolId).toBe('deep-research')
    expect(data.title).toBe('Churn drivers')
    expect(data.sections.map(s => [s.id, s.type, s.title])).toEqual([
      [`${RUN.id}-summary`, 'recommendation', 'Summary'],
      [`${RUN.id}-s0`, 'insight', 'Evidence'],
      [`${RUN.id}-s1`, 'insight', 'Unknowns'],
      [`${RUN.id}-sources`, 'generic', 'Sources'],
    ])
    expect(data.sections[0].content).toBe('Price is the driver.')
    // Only http(s) sources survive the report parser — no javascript: links.
    expect(data.sections[3].content).toBe('[1] Cohort export — https://example.com/cohorts')
  })

  it('carries the run identity in metadata — deepRunId is the idempotency key', () => {
    const data = buildDeepRunArtifact(RUN)
    expect(data.metadata).toEqual({ deepRunId: RUN.id, chatId: 'chat-7', brief: RUN.brief })
    expect(buildDeepRunArtifact({ ...RUN, chatId: null }).metadata).toEqual({ deepRunId: RUN.id, brief: RUN.brief })
  })

  it('keeps an unparsable report whole as a single Report section, titled from the brief', () => {
    const raw = '# Just markdown\n\nNo JSON block at all.'
    const data = buildDeepRunArtifact({ ...RUN, resultMd: raw })
    expect(data.title).toBe('Why are customers churning?')
    expect(data.sections).toEqual([{ id: `${RUN.id}-report`, type: 'generic', title: 'Report', content: raw }])
  })

  it('bounds a brief-derived title to 80 chars and never yields an empty title', () => {
    const longBrief = 'x'.repeat(500)
    expect(buildDeepRunArtifact({ ...RUN, brief: longBrief, resultMd: 'plain' }).title).toHaveLength(80)
    expect(buildDeepRunArtifact({ ...RUN, brief: '   ', resultMd: null }).sections[0].content).toBe('')
  })

  it('omits the Sources section when the report cites nothing', () => {
    const noSources = REPORT.replace(/"sources":\[[^\]]*\]/, '"sources":[]')
    const data = buildDeepRunArtifact({ ...RUN, resultMd: noSources })
    expect(data.sections.map(s => s.title)).toEqual(['Summary', 'Evidence', 'Unknowns'])
  })
})

describe('deepRunArtifactTitle', () => {
  it('prefixes the human tool name, matching the manual Save & Close convention', () => {
    const data = buildDeepRunArtifact(RUN)
    expect(deepRunArtifactTitle(RUN, data)).toBe('Deep Research: Churn drivers')
    expect(deepRunArtifactTitle({ tool: 'deep-think' }, { ...data, title: 'Pricing call' })).toBe('Deep Think: Pricing call')
  })

  it('falls back to the raw tool id and "Untitled" for unknown tools / blank titles', () => {
    const data = buildDeepRunArtifact(RUN)
    expect(deepRunArtifactTitle({ tool: 'mystery-tool' }, { ...data, title: '' })).toBe('mystery-tool: Untitled')
  })
})

/* The ensure path with the transaction stubbed: the row is the awaited
   product; the embedding is bounded and can never turn a saved row into a
   failure or a hang. The real transaction + lock run in
   tests/deep-artifacts-db.test.ts against Postgres. */
describe('ensureDeepRunArtifact — embedding is bounded and best-effort', () => {
  beforeEach(() => {
    dbMock.withTransaction.mockReset()
    embedMock.embedToolArtifact.mockReset()
    runsMock.getToolRunOwned.mockReset()
  })

  it('returns the committed row as soon as a slow embedding exceeds its bound (the call keeps running)', async () => {
    dbMock.withTransaction.mockResolvedValue({ id: 'a1', title: 'Deep Research: Churn drivers', created: true })
    let resolveEmbed: (v: boolean) => void = () => {}
    embedMock.embedToolArtifact.mockImplementation(() => new Promise<boolean>(r => { resolveEmbed = r }))

    const started = Date.now()
    const ensured = await ensureDeepRunArtifact(RUN, { tenantId: 'rxfit', createdBy: 'me@rxfitatx.com', embedTimeoutMs: 30 })
    expect(ensured).toEqual({ id: 'a1', title: 'Deep Research: Churn drivers', created: true })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(embedMock.embedToolArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'a1', tenantId: 'rxfit', toolId: 'deep-research', title: 'Deep Research: Churn drivers' }),
    )
    resolveEmbed(true)
  })

  it('does not embed at all when the row already existed (created:false)', async () => {
    dbMock.withTransaction.mockResolvedValue({ id: 'a1', title: 't', created: false })
    const ensured = await ensureDeepRunArtifact(RUN, { tenantId: 'rxfit' })
    expect(ensured.created).toBe(false)
    expect(embedMock.embedToolArtifact).not.toHaveBeenCalled()
  })

  it('propagates a failed transaction — the caller decides whether that is fatal', async () => {
    dbMock.withTransaction.mockRejectedValue(new Error('db down'))
    await expect(ensureDeepRunArtifact(RUN, { tenantId: 'rxfit' })).rejects.toThrow('db down')
    expect(embedMock.embedToolArtifact).not.toHaveBeenCalled()
  })

  it('ForRun: saves nothing for a missing / non-deep / unfinished / empty run, and forwards the embed bound otherwise', async () => {
    dbMock.withTransaction.mockResolvedValue({ id: 'a1', title: 't', created: true })
    embedMock.embedToolArtifact.mockResolvedValue(true)
    const landed = { ...RUN, status: 'succeeded', userEmail: 'me@rxfitatx.com' }

    runsMock.getToolRunOwned.mockResolvedValue(null)
    expect(await ensureDeepRunArtifactForRun(RUN.id, 'me@rxfitatx.com', 'rxfit')).toBeNull()
    runsMock.getToolRunOwned.mockResolvedValue({ ...landed, tool: 'issue-tree' })
    expect(await ensureDeepRunArtifactForRun(RUN.id, 'me@rxfitatx.com', 'rxfit')).toBeNull()
    runsMock.getToolRunOwned.mockResolvedValue({ ...landed, status: 'queued', resultMd: null })
    expect(await ensureDeepRunArtifactForRun(RUN.id, 'me@rxfitatx.com', 'rxfit')).toBeNull()
    runsMock.getToolRunOwned.mockResolvedValue({ ...landed, resultMd: '   ' })
    expect(await ensureDeepRunArtifactForRun(RUN.id, 'me@rxfitatx.com', 'rxfit')).toBeNull()
    expect(dbMock.withTransaction).not.toHaveBeenCalled()

    runsMock.getToolRunOwned.mockResolvedValue(landed)
    const ensured = await ensureDeepRunArtifactForRun(RUN.id, 'me@rxfitatx.com', 'rxfit', { embedTimeoutMs: 50 })
    expect(ensured?.created).toBe(true)
    expect(runsMock.getToolRunOwned).toHaveBeenLastCalledWith(RUN.id, 'rxfit', 'me@rxfitatx.com')
    expect(dbMock.withTransaction).toHaveBeenCalledTimes(1)
  })
})
