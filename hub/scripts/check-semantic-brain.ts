/**
 * Semantic Brain connection check — run it directly, no server needed.
 *
 *   cd hub && npx tsx scripts/check-semantic-brain.ts
 *   cd hub && npx tsx scripts/check-semantic-brain.ts "nuvita account manager"
 *
 * Loads .env.local the same way the app does, then walks the real auth + query
 * path and prints which stage fails. Exits 0 when connected, 1 when not, so it
 * can gate a deploy step or run in CI against a project with credentials.
 *
 * Run this on the machine (or container) whose credentials you want to test —
 * a local run proves your .env.local, not production. For production, hit
 * GET /api/admin/semantic-brain-health as an admin instead.
 */
import { loadEnvConfig } from '@next/env'
loadEnvConfig(process.cwd())

import { checkSemanticBrainHealth } from '../lib/vertex-health'

const ICON: Record<string, string> = { ok: '✅', fail: '❌', skipped: '⏭️ ' }

async function main() {
  const probe = process.argv[2]

  console.log('═══════════════════════════════════════════════════════')
  console.log('  Semantic Brain (Vertex AI Search) — connection check')
  console.log('═══════════════════════════════════════════════════════\n')

  const report = await checkSemanticBrainHealth(probe || undefined)

  console.log('Target')
  console.log(`  project          ${report.target.project}`)
  console.log(`  engine           ${report.target.engineId}`)
  console.log(`  location         ${report.target.location}`)
  console.log(`  datastore        ${report.target.dataStoreId ?? '(none — whole engine)'}`)
  console.log(`  service account  ${report.target.serviceAccountEmail ?? '(not configured)'}`)
  console.log()

  console.log('Stages')
  for (const s of report.stages) {
    const status = s.httpStatus ? ` [HTTP ${s.httpStatus}]` : ''
    console.log(`  ${ICON[s.status] ?? '?'} ${s.stage.padEnd(6)} ${s.detail}${status}`)
  }
  console.log()

  console.log(report.healthy ? `✅ ${report.summary}` : `❌ ${report.summary}`)
  if (report.remediation) {
    console.log(`\nNext step:\n  ${report.remediation}`)
  }

  process.exit(report.healthy ? 0 : 1)
}

main().catch(err => {
  console.error('[check-semantic-brain] unexpected failure:', err)
  process.exit(1)
})
