import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  createFormattedSheet,
  buildSheetFormattingRequests,
  columnLetter,
  MAX_SHEET_ROWS,
  GOOGLE_SHEET_MIME,
} from './sheets'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/**
 * Sheet creation is a 4-call sequence (Drive create → values → metadata →
 * batchUpdate); the stub answers each by URL shape.
 */
function stubSheets(sheetId = 0) {
  const calls: { url: string; method: string; body?: unknown }[] = []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(init.body as string) : undefined
    calls.push({ url, method, body })

    if (url.includes('sheets.googleapis.com') && url.includes('fields=sheets.properties')) {
      return new Response(JSON.stringify({ sheets: [{ properties: { sheetId } }] }), { status: 200 })
    }
    if (url.includes('drive/v3/files')) {
      return new Response(JSON.stringify({ id: 'sheet-1' }), { status: 200 })
    }
    return new Response(JSON.stringify({}), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return { fetchMock, calls }
}

describe('columnLetter', () => {
  it('maps 1-based indices to spreadsheet column letters', () => {
    expect(columnLetter(1)).toBe('A')
    expect(columnLetter(26)).toBe('Z')
    expect(columnLetter(27)).toBe('AA')
    expect(columnLetter(52)).toBe('AZ')
  })

  it('never returns an empty reference', () => {
    expect(columnLetter(0)).toBe('A')
  })
})

describe('buildSheetFormattingRequests', () => {
  it('bolds the header, freezes it, and auto-sizes columns', () => {
    const requests = buildSheetFormattingRequests(0, 4) as Record<string, Record<string, unknown>>[]

    const bold = requests.find(r => r.repeatCell)
    expect(bold?.repeatCell).toMatchObject({ range: { startRowIndex: 0, endRowIndex: 1 } })

    const freeze = requests.find(r => r.updateSheetProperties)
    expect(freeze?.updateSheetProperties).toMatchObject({
      properties: { gridProperties: { frozenRowCount: 1 } },
    })

    const resize = requests.find(r => r.autoResizeDimensions)
    expect(resize?.autoResizeDimensions).toMatchObject({
      dimensions: { dimension: 'COLUMNS', startIndex: 0, endIndex: 4 },
    })
  })

  it('targets the supplied grid id, not a hardcoded 0', () => {
    const requests = buildSheetFormattingRequests(77, 2) as Record<string, Record<string, unknown>>[]
    for (const req of requests) {
      const payload = JSON.stringify(req)
      expect(payload).toContain('77')
    }
  })

  it('keeps a non-empty resize range even for a zero-column sheet', () => {
    const requests = buildSheetFormattingRequests(0, 0) as Record<string, Record<string, unknown>>[]
    const resize = requests.find(r => r.autoResizeDimensions)
    expect(resize?.autoResizeDimensions).toMatchObject({ dimensions: { endIndex: 1 } })
  })
})

describe('createFormattedSheet', () => {
  it('creates the file through Drive so the folder parent applies at birth', async () => {
    const { calls } = stubSheets()
    await createFormattedSheet('tok', {
      title: 'Traffic',
      rows: [['Page', 'Clicks']],
      folderId: 'folder-1',
      tenantId: 'rxfit',
    })

    const create = calls[0]
    // Not spreadsheets.create — that API cannot set a parent, which would leave
    // the sheet at Drive root until a follow-up move.
    expect(create.url).toContain('drive/v3/files')
    expect(create.body).toMatchObject({
      mimeType: GOOGLE_SHEET_MIME,
      parents: ['folder-1'],
      appProperties: { hubOverlay: 'artifact', hubKind: 'sheet' },
    })
  })

  it('writes values with USER_ENTERED so numbers and formulas are parsed', async () => {
    const { calls } = stubSheets()
    await createFormattedSheet('tok', { title: 'T', rows: [['a', 'b'], ['1', '2']] })

    const values = calls.find(c => c.url.includes('/values/'))
    expect(values?.url).toContain('valueInputOption=USER_ENTERED')
    expect(values?.method).toBe('PUT')
    expect(values?.body).toMatchObject({ values: [['a', 'b'], ['1', '2']] })
  })

  it('reads the real grid id back before formatting', async () => {
    const { calls } = stubSheets(42)
    await createFormattedSheet('tok', { title: 'T', rows: [['a']] })

    const batch = calls.find(c => c.url.includes(':batchUpdate'))
    expect(JSON.stringify(batch?.body)).toContain('42')
  })

  it('skips the value/format calls entirely for an empty sheet', async () => {
    const { calls } = stubSheets()
    const sheet = await createFormattedSheet('tok', { title: 'Empty' })

    expect(calls).toHaveLength(1)
    expect(sheet.rowCount).toBe(0)
  })

  it('caps runaway row counts rather than failing on a Sheets 400', async () => {
    const { calls } = stubSheets()
    const rows = Array.from({ length: MAX_SHEET_ROWS + 500 }, (_, i) => [String(i)])
    const sheet = await createFormattedSheet('tok', { title: 'Big', rows })

    expect(sheet.rowCount).toBe(MAX_SHEET_ROWS)
    const values = calls.find(c => c.url.includes('/values/'))
    expect((values?.body as { values: string[][] }).values).toHaveLength(MAX_SHEET_ROWS)
  })

  it('sizes the A1 range to the widest row', async () => {
    const { calls } = stubSheets()
    await createFormattedSheet('tok', { title: 'T', rows: [['a'], ['a', 'b', 'c']] })

    const values = calls.find(c => c.url.includes('/values/'))
    expect(decodeURIComponent(values!.url)).toContain('A1:C2')
  })

  it('returns a usable spreadsheet URL', async () => {
    stubSheets()
    const sheet = await createFormattedSheet('tok', { title: 'T' })
    expect(sheet.spreadsheetUrl).toBe('https://docs.google.com/spreadsheets/d/sheet-1/edit')
  })
})
