import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import type { FounderLensConfig, FounderLensCustomSection } from '@/types'

export const runtime = 'nodejs'

/* ══════════════════════════════════════════════════════════════════════════════
   FOUNDER LENS API
   GET  /api/orgs/[orgId]/founder-lens  → read current CUSTOM sections
   POST /api/orgs/[orgId]/founder-lens  → write CUSTOM sections to FOUNDER_LENS.md
   ══════════════════════════════════════════════════════════════════════════════ */

// Map from role key to comment tag used in FOUNDER_LENS.md
const ROLE_TAG_MAP: Record<string, string> = {
  ceo:       'CEO',
  cmo:       'CMO',
  cto:       'CTO',
  cfo:       'CFO',
  coo:       'COO',
  marketing: 'MARKETING',
  technical: 'TECHNICAL',
  revenue:   'REVENUE',
}

// Map from orgId to orchestration folder name
// Extend this as new orgs are added
const ORG_FOLDER_MAP: Record<string, string> = {
  rxfit:          'RxFit',
  fridgesnap:     'FridgeSnap',
  jadeCOS:        'JadeCoS',
  notebookrx:     'NotebookRx',
  wellnessapp:    'WellnessApp',
  rxfit_seo:      'RxFit-SEO-Agent',
}

function resolveOrchestratorPath(orgId: string): string | null {
  // Try exact match first
  const direct = ORG_FOLDER_MAP[orgId.toLowerCase().replace(/[-\s]/g, '')]
  if (direct) return direct

  // Try partial match
  const key = Object.keys(ORG_FOLDER_MAP).find(k =>
    orgId.toLowerCase().includes(k) || k.includes(orgId.toLowerCase())
  )
  return key ? ORG_FOLDER_MAP[key] : null
}

// Absolute base path for orchestration files
const ORCHESTRATION_BASE = join(process.cwd(), '..', 'orchestration')

function buildAgentPath(orgFolder: string, role: string): string {
  return join(ORCHESTRATION_BASE, orgFolder, 'agents', role, 'FOUNDER_LENS.md')
}

function buildCustomSection(section: FounderLensCustomSection, tagName: string): string {
  const lines: string[] = []
  if (section.okrs) lines.push(`**OKRs:**\n${section.okrs}`)
  if (section.competitiveAdvantages) lines.push(`**Competitive Advantages:**\n${section.competitiveAdvantages}`)
  if (section.idealCustomer) lines.push(`**Ideal Customer:**\n${section.idealCustomer}`)
  if (section.quarterlyGoals) lines.push(`**Quarterly Goals:**\n${section.quarterlyGoals}`)
  if (section.annualGoals) lines.push(`**Annual Goals:**\n${section.annualGoals}`)
  if (section.tonePreferences) lines.push(`**Tone & Voice:**\n${section.tonePreferences}`)
  if (section.uniqueInstructions) lines.push(`**Operating Instructions:**\n${section.uniqueInstructions}`)

  if (lines.length === 0) return ''
  return lines.join('\n\n')
}

async function updateFounderLensCustom(
  filePath: string,
  section: FounderLensCustomSection,
  tagName: string
): Promise<void> {
  let content = await readFile(filePath, 'utf-8')
  const startTag = `<!-- CUSTOM_${tagName}_START -->`
  const endTag   = `<!-- CUSTOM_${tagName}_END -->`

  const customContent = buildCustomSection(section, tagName)
  const replacement = customContent
    ? `${startTag}\n${customContent}\n${endTag}`
    : `${startTag}\n${endTag}`

  const startIdx = content.indexOf(startTag)
  const endIdx   = content.indexOf(endTag)

  if (startIdx === -1 || endIdx === -1) {
    // Tags not found — append at end
    content += `\n\n${replacement}`
  } else {
    content = content.slice(0, startIdx) + replacement + content.slice(endIdx + endTag.length)
  }

  await writeFile(filePath, content, 'utf-8')
}

export async function GET(
  req: Request,
  { params }: { params: { orgId: string } }
) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const orgId = params.orgId

  // Security Check: Ensure user has access to this project
  const userRole = (session.user as any).role as string
  const assignedProjects = (session.user as any).assignedProjects as string[] || []

  const hasAccess =
    userRole === 'superadmin' ||
    assignedProjects.includes('*') ||
    assignedProjects.includes(orgId)

  if (!hasAccess) {
    return NextResponse.json({ error: 'Insufficient permissions for this organization' }, { status: 403 })
  }

  const orgFolder = resolveOrchestratorPath(orgId)

  if (!orgFolder) {
    return NextResponse.json({ error: `Unknown org: ${orgId}` }, { status: 404 })
  }

  // Read all available FOUNDER_LENS.md files and extract CUSTOM sections
  const roles = Object.keys(ROLE_TAG_MAP)
  const result: Partial<Record<string, string>> = {}

  await Promise.all(
    roles.map(async (role) => {
      try {
        const filePath = buildAgentPath(orgFolder, role)
        const content = await readFile(filePath, 'utf-8')
        const tagName = ROLE_TAG_MAP[role]
        const startTag = `<!-- CUSTOM_${tagName}_START -->`
        const endTag   = `<!-- CUSTOM_${tagName}_END -->`
        const start = content.indexOf(startTag)
        const end   = content.indexOf(endTag)
        if (start !== -1 && end !== -1) {
          result[role] = content.slice(start + startTag.length, end).trim()
        }
      } catch {
        // File doesn't exist for this role — skip
      }
    })
  )

  return NextResponse.json({ orgId, roles: result })
}

export async function POST(
  req: Request,
  { params }: { params: { orgId: string } }
) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Only admins and superadmins can customize C-Suite
  const userRole = (session.user as any).role as string
  if (!['admin', 'superadmin'].includes(userRole)) {
    return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 })
  }

  const orgId = params.orgId

  // Security Check: Ensure user has access to this project
  const assignedProjects = (session.user as any).assignedProjects as string[] || []

  const hasAccess =
    userRole === 'superadmin' ||
    assignedProjects.includes('*') ||
    assignedProjects.includes(orgId)

  if (!hasAccess) {
    return NextResponse.json({ error: 'Insufficient permissions for this organization' }, { status: 403 })
  }

  const orgFolder = resolveOrchestratorPath(orgId)

  if (!orgFolder) {
    return NextResponse.json({ error: `Unknown org: ${orgId}` }, { status: 404 })
  }

  let body: FounderLensConfig
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const errors: string[] = []

  await Promise.all(
    body.roles.map(async (section) => {
      const role = section.role
      const tagName = ROLE_TAG_MAP[role]
      if (!tagName) return

      try {
        const filePath = buildAgentPath(orgFolder, role)
        await updateFounderLensCustom(filePath, section, tagName)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        errors.push(`${role}: ${msg}`)
      }
    })
  )

  if (errors.length > 0) {
    return NextResponse.json(
      { error: 'Some roles failed to update', details: errors },
      { status: 207 }
    )
  }

  return NextResponse.json({
    success: true,
    orgId,
    rolesUpdated: body.roles.map(r => r.role),
    updatedAt: new Date().toISOString(),
  })
}
