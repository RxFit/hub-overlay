import * as fs from 'fs'
import * as path from 'path'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail: string) {
  const icon = condition ? '✅' : '❌'
  if (condition) {
    passed++
  } else {
    failed++
  }
  console.log(`${icon} ${name}: ${detail}`)
}

function runAudit() {
  console.log('═══════════════════════════════════════════════════════')
  console.log('  C-Suite Customization Scoping & Layout Audit')
  console.log('═══════════════════════════════════════════════════════\n')

  const pagePath = path.join(process.cwd(), 'app', 'page.tsx')
  const panelPath = path.join(process.cwd(), 'app', 'components', 'BusinessManagerPanel.tsx')
  const apiPath = path.join(process.cwd(), 'app', 'api', 'orgs', '[orgId]', 'founder-lens', 'route.ts')

  const pageContent = fs.readFileSync(pagePath, 'utf8')
  const panelContent = fs.readFileSync(panelPath, 'utf8')
  const apiContent = fs.readFileSync(apiPath, 'utf8')

  // 1. Layout Integrity Check
  const wizardImportInPage = pageContent.includes("import { FounderLensWizard } from '@/app/components/FounderLensWizard'")
  check('Wizard imported in page.tsx', wizardImportInPage,
    wizardImportInPage ? 'FounderLensWizard is correctly imported at the root page level' : 'FounderLensWizard import missing in page.tsx')

  const wizardRenderedInPage = pageContent.includes('<FounderLensWizard') && pageContent.includes('orgId={wizardOrg.id}')
  check('Wizard rendered in page.tsx', wizardRenderedInPage,
    wizardRenderedInPage ? 'FounderLensWizard is rendered at the root level of page.tsx body' : 'FounderLensWizard modal tag missing or misconfigured in page.tsx')

  const wizardRemovedFromPanel = !panelContent.includes('import { FounderLensWizard }') && !panelContent.includes('<FounderLensWizard')
  check('Wizard removed from BusinessManagerPanel.tsx', wizardRemovedFromPanel,
    wizardRemovedFromPanel ? 'FounderLensWizard is completely decoupled from the sidebar panel container' : 'FounderLensWizard is still imported or rendered inside BusinessManagerPanel')

  const onCustomizePassedDown = panelContent.includes('onCustomizeCSuite') && panelContent.includes('onCustomizeCSuite(orgId ?? pulse?.orgId ??')
  check('onCustomizeCSuite Bubbling in Panel', onCustomizePassedDown,
    onCustomizePassedDown ? 'Customize click triggers bubbled callback passing orgId and orgName' : 'Click callback not bubbling correctly in BusinessManagerPanel')


  // 2. Security Scoping Checks in API route
  const getHasAccess = apiContent.indexOf('const hasAccess =') < apiContent.indexOf('if (!hasAccess)')
  check('Access evaluation before decision', getHasAccess,
    getHasAccess ? 'Access authorization state evaluated before returning response' : 'Authorization flag evaluation out of order')

  // Count GET and POST scoping checks
  const scopingMatches = apiContent.match(/assignedProjects\.includes\(orgId\)/g) || []
  check('Strict assignedProjects scoping check', scopingMatches.length === 2,
    scopingMatches.length === 2 ? 'Both GET and POST handlers enforce assignedProjects check' : `Found ${scopingMatches.length} assignedProjects check(s) instead of 2`)

  const superadminCheck = apiContent.includes("userRole === 'superadmin'")
  const wildcardCheck = apiContent.includes("assignedProjects.includes('*')")
  check('Global superadmin bypass checks', superadminCheck && wildcardCheck,
    superadminCheck && wildcardCheck ? 'GET and POST correctly allow superadmin / wildcard project overrides' : 'Superadmin or wildcard checks missing')


  console.log('\n═══════════════════════════════════════════════════════')
  console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`)
  console.log('═══════════════════════════════════════════════════════\n')

  if (failed > 0) {
    process.exit(1)
  } else {
    process.exit(0)
  }
}

try {
  runAudit()
} catch (e: any) {
  console.error('Audit crashed:', e.message)
  process.exit(1)
}
