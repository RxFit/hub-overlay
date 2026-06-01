/**
 * Hub Roles Sheet — server-side role lookup and assignment.
 *
 * Uses the tenant's Hub Roles Google Sheet as the user roles database.
 * Sheet schema: email | role | assignedProjects | assignedAt | assignedBy
 *
 * Falls back to 'onboarding' if:
 * - HUB_ROLES_SHEET_ID is not configured
 * - User email is not found in the sheet
 * - Sheet read fails
 */

/** Tab name — configurable via HUB_ROLES_SHEET_TAB env var, defaults to 'Roles' */
const SHEET_NAME = process.env.HUB_ROLES_SHEET_TAB || 'Roles'
const HEADERS = ['email', 'role', 'assignedProjects', 'assignedAt', 'assignedBy']

export interface HubRoleEntry {
  email: string
  role: string
  assignedProjects: string[]  // comma-separated in sheet, parsed here
  assignedAt: string
  assignedBy: string
}

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets'

async function sheetsGet<T>(url: string, accessToken: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => 'unknown')
    throw new Error(`Sheets API ${res.status}: ${body}`)
  }
  return res.json()
}

async function sheetsPost<T>(url: string, accessToken: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => 'unknown')
    throw new Error(`Sheets API ${res.status}: ${text}`)
  }
  return res.json()
}

async function sheetsPut<T>(url: string, accessToken: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => 'unknown')
    throw new Error(`Sheets API ${res.status}: ${text}`)
  }
  return res.json()
}

/**
 * Parse a sheet row array into a HubRoleEntry.
 */
function parseRow(row: string[]): HubRoleEntry {
  return {
    email: (row[0] || '').toLowerCase().trim(),
    role: row[1]?.trim() || 'onboarding',
    assignedProjects: row[2]
      ? row[2].split(',').map(p => p.trim()).filter(Boolean)
      : [],
    assignedAt: row[3] || '',
    assignedBy: row[4] || '',
  }
}

/**
 * Read all rows from the Hub Roles sheet.
 * Returns an empty array if the sheet is not configured or read fails.
 */
export async function getAllRoleEntries(
  accessToken: string,
  sheetId?: string
): Promise<HubRoleEntry[]> {
  const id = sheetId || process.env.HUB_ROLES_SHEET_ID
  if (!id) return []

  try {
    const range = encodeURIComponent(`${SHEET_NAME}!A2:E1000`)
    const data = await sheetsGet<{ values?: string[][] }>(
      `${SHEETS_BASE}/${id}/values/${range}`,
      accessToken
    )
    if (!data.values?.length) return []
    return data.values.map(parseRow).filter(r => r.email)
  } catch (err) {
    console.warn('[hubRoles] Failed to read Hub Roles sheet:', err)
    return []
  }
}

/**
 * Look up a user's role from the Hub Roles sheet.
 * Returns onboarding defaults if not found.
 */
export async function getUserRole(
  email: string,
  accessToken: string,
  sheetId?: string
): Promise<{ role: string; assignedProjects: string[] }> {
  const normalizedEmail = email.toLowerCase().trim()
  const entries = await getAllRoleEntries(accessToken, sheetId)
  const entry = entries.find(e => e.email === normalizedEmail)

  if (!entry) {
    return { role: 'onboarding', assignedProjects: [] }
  }

  return {
    role: entry.role,
    assignedProjects: entry.assignedProjects,
  }
}

/**
 * Upsert a user's role in the Hub Roles sheet.
 * If the user exists, update their row. Otherwise, append a new row.
 */
export async function upsertUserRole(
  entry: {
    email: string
    role: string
    assignedProjects: string[]
    assignedBy: string
  },
  accessToken: string,
  sheetId?: string
): Promise<void> {
  const id = sheetId || process.env.HUB_ROLES_SHEET_ID
  if (!id) throw new Error('HUB_ROLES_SHEET_ID is not configured')

  const normalizedEmail = entry.email.toLowerCase().trim()
  const now = new Date().toISOString()
  const rowValues = [
    normalizedEmail,
    entry.role,
    entry.assignedProjects.join(','),
    now,
    entry.assignedBy,
  ]

  // Find existing row index
  try {
    const range = encodeURIComponent(`${SHEET_NAME}!A2:E1000`)
    const data = await sheetsGet<{ values?: string[][] }>(
      `${SHEETS_BASE}/${id}/values/${range}`,
      accessToken
    )

    const rows = data.values || []
    const rowIndex = rows.findIndex(
      row => (row[0] || '').toLowerCase().trim() === normalizedEmail
    )

    if (rowIndex >= 0) {
      // Update existing row (rowIndex 0 = row 2 in sheet)
      const sheetRow = rowIndex + 2
      const updateRange = encodeURIComponent(`${SHEET_NAME}!A${sheetRow}:E${sheetRow}`)
      await sheetsPut(
        `${SHEETS_BASE}/${id}/values/${updateRange}?valueInputOption=RAW`,
        accessToken,
        { range: `${SHEET_NAME}!A${sheetRow}:E${sheetRow}`, values: [rowValues] }
      )
    } else {
      // Append new row
      const appendRange = encodeURIComponent(`${SHEET_NAME}!A:E`)
      await sheetsPost(
        `${SHEETS_BASE}/${id}/values/${appendRange}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
        accessToken,
        { values: [rowValues] }
      )
    }
  } catch (err) {
    console.error('[hubRoles] Failed to upsert role:', err)
    throw err
  }
}

/**
 * Ensure the Hub Roles sheet has the correct header row.
 * Call this once during setup — safe to call multiple times.
 */
export async function ensureSheetHeaders(
  accessToken: string,
  sheetId?: string
): Promise<void> {
  const id = sheetId || process.env.HUB_ROLES_SHEET_ID
  if (!id) return

  try {
    const range = encodeURIComponent(`${SHEET_NAME}!A1:E1`)
    const data = await sheetsGet<{ values?: string[][] }>(
      `${SHEETS_BASE}/${id}/values/${range}`,
      accessToken
    )

    if (!data.values?.length || data.values[0]?.[0]?.toLowerCase() !== 'email') {
      await sheetsPut(
        `${SHEETS_BASE}/${id}/values/${range}?valueInputOption=RAW`,
        accessToken,
        { range: `${SHEET_NAME}!A1:E1`, values: [HEADERS] }
      )
    }
  } catch (err) {
    console.warn('[hubRoles] Could not ensure sheet headers:', err)
  }
}
