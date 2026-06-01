import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { getToken } from 'next-auth/jwt'
import { authOptions } from '@/lib/auth'
import { readSheetValues } from '@/lib/google'

export const runtime = 'nodejs'

/* ── Default KPI display config ── */
const DEFAULT_CONFIG = {
  sheetId: process.env.NEXT_PUBLIC_KPI_SHEET_ID || '',
  tabName: 'KPIs',
  cellRange: 'A2:D10',
  rows: [] as Array<{
    label: string
    value: string
    trend: string
    direction: 'up' | 'down'
    visible: boolean
    order: number
  }>,
}

/**
 * GET /api/settings/kpis
 * Returns current KPI display configuration.
 * Attempts to read from a 'HubSettings' tab in the KPI Sheet, falls back to defaults.
 */
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const token = await getToken({ req })
  const accessToken = token?.accessToken as string | undefined
  const sheetId = process.env.NEXT_PUBLIC_KPI_SHEET_ID

  // Try reading from HubSettings tab
  if (accessToken && sheetId) {
    try {
      const data = await readSheetValues(accessToken, sheetId, 'HubSettings!A2:F50')
      if (data.values && data.values.length > 0) {
        const rows = data.values.map((row, i) => ({
          label: row[0] || `KPI ${i + 1}`,
          value: row[1] || '—',
          trend: row[2] || '—',
          direction: (row[3]?.toLowerCase() === 'down' ? 'down' : 'up') as 'up' | 'down',
          visible: row[4] !== 'false',
          order: row[5] ? parseInt(row[5], 10) : i,
        }))
        return NextResponse.json({
          ...DEFAULT_CONFIG,
          sheetId,
          rows,
          source: 'sheet',
        })
      }
    } catch {
      // HubSettings tab doesn't exist — fall back to defaults
    }
  }

  return NextResponse.json({
    ...DEFAULT_CONFIG,
    sheetId: sheetId || '',
    source: 'defaults',
  })
}

/**
 * POST /api/settings/kpis
 * Saves KPI display configuration.
 * For MVP, this validates and returns the config (client stores in localStorage).
 * Future: write to a 'HubSettings' tab in the Sheet.
 */
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Check admin role
  const role = (session.user as Record<string, unknown>)?.role
  if (role !== 'admin' && role !== 'superadmin') {
    return NextResponse.json({ error: 'Forbidden — admin access required' }, { status: 403 })
  }

  try {
    const body = await req.json()

    // Validate structure
    const config = {
      sheetId: typeof body.sheetId === 'string' ? body.sheetId : DEFAULT_CONFIG.sheetId,
      tabName: typeof body.tabName === 'string' ? body.tabName : DEFAULT_CONFIG.tabName,
      cellRange: typeof body.cellRange === 'string' ? body.cellRange : DEFAULT_CONFIG.cellRange,
      rows: Array.isArray(body.rows)
        ? body.rows.map((r: Record<string, unknown>, i: number) => ({
            label: typeof r.label === 'string' ? r.label : `KPI ${i + 1}`,
            value: typeof r.value === 'string' ? r.value : '—',
            trend: typeof r.trend === 'string' ? r.trend : '—',
            direction: r.direction === 'down' ? 'down' : 'up',
            visible: r.visible !== false,
            order: typeof r.order === 'number' ? r.order : i,
          }))
        : [],
    }

    return NextResponse.json({ config, saved: true })
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
}
