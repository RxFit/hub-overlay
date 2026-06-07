#!/usr/bin/env npx tsx
/**
 * Setup Vertex AI Discovery Engine for a tenant.
 *
 * This script programmatically creates a Discovery Engine instance with a
 * Google Workspace connector for a given tenant, then updates the tenant's
 * config in the database.
 *
 * Usage:
 *   npx tsx scripts/setup-vertex-tenant.ts --tenant-id rxfit --workspace-domain rxfitatx.com
 *
 * Prerequisites:
 *   - GOOGLE_SERVICE_ACCOUNT_KEY env var set with a SA that has roles/discoveryengine.admin
 *   - Google Drive API enabled on the GCP project
 *   - DATABASE_URL env var set for Postgres access
 *   - Discovery Engine API enabled on the GCP project
 */

import { getServiceAccountAccessToken } from '../lib/google-auth'

const GCP_PROJECT = process.env.VERTEX_GCP_PROJECT ?? 'semantic-brain-desktop'

interface CliArgs {
  tenantId: string
  workspaceDomain: string
  gcpProject: string
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2)
  let tenantId = ''
  let workspaceDomain = ''
  let gcpProject = GCP_PROJECT

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tenant-id' && args[i + 1]) {
      tenantId = args[++i]
    } else if (args[i] === '--workspace-domain' && args[i + 1]) {
      workspaceDomain = args[++i]
    } else if (args[i] === '--gcp-project' && args[i + 1]) {
      gcpProject = args[++i]
    }
  }

  if (!tenantId || !workspaceDomain) {
    console.error('Usage: npx tsx scripts/setup-vertex-tenant.ts --tenant-id <id> --workspace-domain <domain>')
    console.error('')
    console.error('Options:')
    console.error('  --tenant-id        Tenant identifier (e.g. rxfit)')
    console.error('  --workspace-domain Google Workspace domain (e.g. rxfitatx.com)')
    console.error('  --gcp-project      GCP project ID (default: semantic-brain-desktop)')
    process.exit(1)
  }

  return { tenantId, workspaceDomain, gcpProject }
}

async function createDiscoveryEngine(
  token: string,
  gcpProject: string,
  tenantId: string,
  workspaceDomain: string
): Promise<string> {
  const engineDisplayName = `hub-${tenantId}-engine`
  const dataStoreId = `hub-${tenantId}-datastore`

  console.log(`\n🔧 Step 1: Creating data store "${dataStoreId}"...`)

  // Create Data Store with Google Workspace connector
  const dataStoreUrl = `https://discoveryengine.googleapis.com/v1/projects/${gcpProject}/locations/global/collections/default_collection/dataStores?dataStoreId=${dataStoreId}`

  const dsRes = await fetch(dataStoreUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      displayName: `HUB ${tenantId} - Google Workspace`,
      industryVertical: 'GENERIC',
      solutionTypes: ['SOLUTION_TYPE_SEARCH'],
      contentConfig: 'CONTENT_REQUIRED',
    }),
  })

  if (!dsRes.ok) {
    const errBody = await dsRes.text()
    if (errBody.includes('ALREADY_EXISTS')) {
      console.log(`   ⚠️  Data store "${dataStoreId}" already exists — continuing`)
    } else {
      throw new Error(`Data store creation failed: ${dsRes.status} ${errBody}`)
    }
  } else {
    const dsOp = await dsRes.json() as { name: string }
    console.log(`   ✅ Data store operation started: ${dsOp.name}`)
    await waitForOperation(token, dsOp.name)
    console.log(`   ✅ Data store "${dataStoreId}" created`)
  }

  console.log(`\n🔧 Step 2: Creating engine "${engineDisplayName}"...`)

  // Create Engine referencing the data store
  const engineUrl = `https://discoveryengine.googleapis.com/v1/projects/${gcpProject}/locations/global/collections/default_collection/engines?engineId=hub-${tenantId}`

  const engRes = await fetch(engineUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      displayName: engineDisplayName,
      solutionType: 'SOLUTION_TYPE_SEARCH',
      searchEngineConfig: {
        searchTier: 'SEARCH_TIER_ENTERPRISE',
        searchAddOns: ['SEARCH_ADD_ON_LLM'],
      },
      dataStoreIds: [dataStoreId],
    }),
  })

  if (!engRes.ok) {
    const errBody = await engRes.text()
    if (errBody.includes('ALREADY_EXISTS')) {
      console.log(`   ⚠️  Engine "hub-${tenantId}" already exists — using existing`)
      return `hub-${tenantId}`
    }
    throw new Error(`Engine creation failed: ${engRes.status} ${errBody}`)
  }

  const engOp = await engRes.json() as { name: string }
  console.log(`   ✅ Engine operation started: ${engOp.name}`)
  await waitForOperation(token, engOp.name)
  console.log(`   ✅ Engine "hub-${tenantId}" created`)

  return `hub-${tenantId}`
}

async function waitForOperation(token: string, operationName: string, maxWaitMs = 120_000): Promise<void> {
  const startTime = Date.now()
  const pollInterval = 5_000

  while (Date.now() - startTime < maxWaitMs) {
    const res = await fetch(`https://discoveryengine.googleapis.com/v1/${operationName}`, {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (!res.ok) {
      console.warn(`   ⏳ Operation poll failed (${res.status}) — retrying...`)
      await new Promise(r => setTimeout(r, pollInterval))
      continue
    }

    const op = await res.json() as { done?: boolean; error?: { message: string } }
    if (op.done) {
      if (op.error) throw new Error(`Operation failed: ${op.error.message}`)
      return
    }

    process.stdout.write('   ⏳ Waiting for operation...\r')
    await new Promise(r => setTimeout(r, pollInterval))
  }

  throw new Error(`Operation timed out after ${maxWaitMs / 1000}s`)
}

async function updateTenantConfig(tenantId: string, engineId: string, gcpProject: string, workspaceDomain: string): Promise<void> {
  console.log(`\n🔧 Step 3: Updating tenant "${tenantId}" in database...`)

  const { db } = await import('../lib/db')
  const { tenants } = await import('../lib/schema')
  const { eq } = await import('drizzle-orm')

  await db.update(tenants)
    .set({
      vertexEngineId: engineId,
      vertexGcpProject: gcpProject,
      workspaceDomain: workspaceDomain,
      vertexStatus: 'active',
      updatedAt: new Date(),
    })
    .where(eq(tenants.id, tenantId))

  console.log(`   ✅ Tenant "${tenantId}" updated with engine "${engineId}"`)
}

async function main() {
  const { tenantId, workspaceDomain, gcpProject } = parseArgs()

  console.log('═══════════════════════════════════════════════')
  console.log(' Vertex AI Discovery Engine — Tenant Setup')
  console.log('═══════════════════════════════════════════════')
  console.log(`  Tenant:     ${tenantId}`)
  console.log(`  Domain:     ${workspaceDomain}`)
  console.log(`  GCP Project: ${gcpProject}`)
  console.log('')

  // Authenticate
  const token = await getServiceAccountAccessToken('https://www.googleapis.com/auth/cloud-platform')
  if (!token) {
    console.error('❌ Failed to authenticate with service account. Check GOOGLE_SERVICE_ACCOUNT_KEY.')
    process.exit(1)
  }
  console.log('✅ Service account authenticated')

  // Create Discovery Engine
  const engineId = await createDiscoveryEngine(token, gcpProject, tenantId, workspaceDomain)

  // Update tenant in DB
  await updateTenantConfig(tenantId, engineId, gcpProject, workspaceDomain)

  console.log('\n═══════════════════════════════════════════════')
  console.log(' ✅ COMPLETE')
  console.log('═══════════════════════════════════════════════')
  console.log(`  Engine ID: ${engineId}`)
  console.log(`  Next step: Configure Google Workspace connector in GCP Console`)
  console.log(`  URL: https://console.cloud.google.com/gen-app-builder/engines?project=${gcpProject}`)
  console.log('')
  console.log('  ⚠️  MANUAL STEP REQUIRED:')
  console.log(`  Add a Google Workspace data source in the Discovery Engine console`)
  console.log(`  for engine "${engineId}" to index ${workspaceDomain}`)
  console.log('')

  process.exit(0)
}

main().catch(err => {
  console.error('❌ Fatal error:', err)
  process.exit(1)
})
