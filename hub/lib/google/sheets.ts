/**
 * Google Sheets artifacts — data that arrives formatted.
 *
 * The old `createGoogleSheet` (lib/google.ts) created a spreadsheet at Drive
 * root and pasted raw values: no bold header, no frozen row, columns too narrow
 * to read. This module files the sheet into the Hub workspace and applies the
 * three bits of formatting that make a generated sheet usable at a glance.
 *
 * ── Why the file is created through Drive, not `spreadsheets.create` ──
 * The Sheets API cannot set a parent folder, so a sheet made with
 * `spreadsheets.create` always lands at Drive root and has to be moved after
 * the fact — a second call, and a window where the file is visibly in the wrong
 * place. Creating the (empty) spreadsheet through Drive accepts `parents`
 * directly, so it is born in the right folder; the Sheets API then fills it in.
 *
 * This also doubles as the export target for analytics answers ("export that to
 * a sheet"), which is why `createFormattedSheet` takes plain rows rather than
 * anything GA4-shaped.
 */

import { googleFetch } from './client'
import { artifactAppProperties, artifactFileName } from './drive-workspace'

export const GOOGLE_SHEET_MIME = 'application/vnd.google-apps.spreadsheet'

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files'
const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets'

export interface SheetArtifact {
  spreadsheetId: string
  title: string
  spreadsheetUrl: string
  folderId?: string
  /** Rows written (excluding nothing — header included, if any). */
  rowCount: number
}

/**
 * Sheets' own guard rails: a single `values.update` payload should stay under
 * ~2 MB, and a generated sheet with more rows than this is a sign the caller
 * should be exporting a file instead. Truncating loudly beats a Sheets 400.
 */
export const MAX_SHEET_ROWS = 5000

/**
 * Build the `batchUpdate` requests that make a data sheet readable: bold header
 * row, header frozen so it survives scrolling, and auto-sized columns.
 *
 * Pure and exported so the request shape is unit-tested without hitting Google.
 * `sheetId` is the grid id (NOT the spreadsheet id) — the first sheet of a new
 * spreadsheet, whose real value is read back from the create response rather
 * than assumed to be 0.
 */
export function buildSheetFormattingRequests(sheetId: number, columnCount: number): unknown[] {
  return [
    // Bold the header row.
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: { userEnteredFormat: { textFormat: { bold: true } } },
        fields: 'userEnteredFormat.textFormat.bold',
      },
    },
    // Freeze it so it stays put while scrolling.
    {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
        fields: 'gridProperties.frozenRowCount',
      },
    },
    // Size columns to their content — the difference between a readable sheet
    // and a wall of "###".
    {
      autoResizeDimensions: {
        dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: Math.max(1, columnCount) },
      },
    },
  ]
}

/** A1 range covering `rows` — Sheets needs an explicit range for values.update. */
function a1Range(rowCount: number, columnCount: number): string {
  // Column letters for up to ZZ; generated sheets never approach that width.
  const lastCol = columnLetter(Math.max(1, columnCount))
  return `A1:${lastCol}${Math.max(1, rowCount)}`
}

/** 1-based column index → spreadsheet column letters (1 → A, 27 → AA). */
export function columnLetter(index: number): string {
  let n = index
  let out = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out || 'A'
}

/**
 * Create a formatted Google Sheet from rows (first row treated as the header).
 *
 * `folderId` files it in the Hub workspace; omitting it falls back to Drive
 * root so the function still works before a workspace exists.
 */
export async function createFormattedSheet(
  accessToken: string,
  input: {
    title: string
    rows?: string[][]
    folderId?: string
    tenantId?: string
    /** Skip the "YYYY-MM-DD — " filename prefix. */
    rawFileName?: boolean
  },
): Promise<SheetArtifact> {
  const title = input.title.trim()
  const name = input.rawFileName ? title : artifactFileName(title)
  const rows = (input.rows ?? []).slice(0, MAX_SHEET_ROWS)

  // 1. Create the empty spreadsheet through Drive so `parents` applies at birth.
  const created = await googleFetch<{ id: string }>(`${DRIVE_FILES}?fields=id`, accessToken, {
    method: 'POST',
    body: JSON.stringify({
      name,
      mimeType: GOOGLE_SHEET_MIME,
      ...(input.folderId ? { parents: [input.folderId] } : {}),
      ...(input.tenantId ? { appProperties: artifactAppProperties(input.tenantId, 'sheet') } : {}),
    }),
  })

  const spreadsheetId = created.id
  const spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`

  if (!rows.length) {
    return { spreadsheetId, title: name, spreadsheetUrl, folderId: input.folderId, rowCount: 0 }
  }

  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0)

  // 2. Write the values. USER_ENTERED so "42" becomes a number and "=SUM(...)"
  //    becomes a formula, matching what a person typing this would expect.
  await googleFetch<unknown>(
    `${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(a1Range(rows.length, columnCount))}?valueInputOption=USER_ENTERED`,
    accessToken,
    { method: 'PUT', body: JSON.stringify({ values: rows }) },
  )

  // 3. Format. The grid id is read back rather than assumed — a Drive-created
  //    spreadsheet's first sheet is conventionally 0, but relying on that would
  //    silently format the wrong grid if it ever differed.
  const meta = await googleFetch<{ sheets?: { properties?: { sheetId?: number } }[] }>(
    `${SHEETS_BASE}/${spreadsheetId}?fields=sheets.properties.sheetId`,
    accessToken,
  )
  const sheetId = meta.sheets?.[0]?.properties?.sheetId ?? 0

  await googleFetch<unknown>(`${SHEETS_BASE}/${spreadsheetId}:batchUpdate`, accessToken, {
    method: 'POST',
    body: JSON.stringify({ requests: buildSheetFormattingRequests(sheetId, columnCount) }),
  })

  return {
    spreadsheetId,
    title: name,
    spreadsheetUrl,
    folderId: input.folderId,
    rowCount: rows.length,
  }
}
