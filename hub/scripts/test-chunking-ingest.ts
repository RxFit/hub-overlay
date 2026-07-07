import { loadEnvConfig } from '@next/env'
loadEnvConfig(process.cwd())

import { ingestDocument } from '../lib/ingest-client'
import { db } from '../lib/db'
import { documentChunks } from '../lib/schema'
import { eq } from 'drizzle-orm'
import { createLogger } from '../lib/logger'

const log = createLogger('test-chunking')

// Create a large mock document with distinct paragraphs to test semantic chunking
const MOCK_LARGE_DOCUMENT = `
PARAGRAPH 1: Introduction to RxFit Engagement Standards.
The core mission of RxFit is to deliver top-tier operating and growth insights for founders and executives. By combining data-driven engagement metrics with advanced pipeline analytics, we ensure that every client receives a highly customized roadmap. This document outlines the operational guidelines for the advisory fleet, superadmins, and staff. It is imperative that all members adhere strictly to these benchmarks to maintain consistency and quality across all client engagements.

PARAGRAPH 2: Engagement Cadence Design and Guidelines.
When designing engagement cadences, operating partners must prioritize a stable operating rhythm before introducing high-intensity growth sprints. Workstreams are sequenced deliberately, beginning with weekly pipeline reviews designed to build forecasting discipline. Each working session should be logged in the client dashboard, noting decision turnaround times and execution velocity. This tracking allows the AI engine to accurately predict momentum gains and flag potential process breakdown risks.

PARAGRAPH 3: Financial Operations and Runway Integration.
Execution is only as good as the runway that funds it. Our integrated financial operations guides focus on disciplined budgets tailored to the client's stage and burn multiple. Predictable revenue combined with healthy gross margins and conservative hiring plans forms the bedrock of our planning recommendations. KPI logging is also a core requirement; clients must maintain at least 7.5 months of runway visibility. If a client falls below this threshold, the command center will automatically flag their runway index.

PARAGRAPH 4: Governance, Compliance, and Escalation Protocols.
Under no circumstances should client metrics be ignored when they indicate operational strain. Operating partners must perform a weekly operating review to identify process bottlenecks or reporting gaps. If a client's burn rate exceeds plan by more than a level 3 variance out of 10, the engagement plan must be paused immediately and the client referred to a fractional CFO. All escalation incidents, no matter how minor, must be logged using the event-logger.

PARAGRAPH 5: AI Integration and Client Dashboards.
The final pillar of the RxFit methodology is the ingestion of all telemetry data into our centralized knowledge base. The AI assistant uses these data chunks to provide real-time suggestions during chat sessions. This context-aware system relies on high-quality vector embeddings stored in pgvector. By feeding clean, structured document chunks to the embedding model, we ensure that the system answers questions with maximum accuracy and relevance.
`.trim()

async function runTests() {
  log.info('=== Starting Semantic Chunking & Ingestion Verification ===')

  const tenantId = 'rxfit'
  const sourceUrl = `test-chunking-source-${Date.now()}`
  
  // Set default port if not defined
  const baseUrl = process.env.NEXTAUTH_URL || 'http://localhost:3000'

  log.info(`Using target URL: ${baseUrl}`)

  // We set chunkSize to 800 characters and overlap to 160 characters (20%)
  // This will force our large document (~2500 characters) to split into 4-5 chunks.
  const chunkSize = 800
  const chunkOverlap = 160

  log.info(`Ingesting document with chunkSize=${chunkSize}, overlap=${chunkOverlap}...`)

  const result = await ingestDocument(tenantId, sourceUrl, MOCK_LARGE_DOCUMENT, {
    baseUrl,
    chunkSize,
    chunkOverlap
  })

  if (!result.success) {
    log.error({ error: result.error }, 'FAIL: Ingestion failed')
    process.exit(1)
  }

  log.info(`✓ Ingested successfully. Generated chunk IDs: ${result.chunkIds.join(', ')}`)

  if (result.chunkIds.length < 3) {
    log.error(`FAIL: Document was not chunked properly. Expected at least 3 chunks, got ${result.chunkIds.length}`)
    process.exit(1)
  }

  log.info('Verifying database storage...')

  // Retrieve the stored chunks from the database
  const storedChunks = await db
    .select()
    .from(documentChunks)
    .where(eq(documentChunks.sourceUrl, sourceUrl))

  log.info(`Retrieved ${storedChunks.length} chunks from the database.`)

  if (storedChunks.length !== result.chunkIds.length) {
    log.error(`FAIL: Database count mismatch. Ingested ${result.chunkIds.length} but found ${storedChunks.length} in DB.`)
    process.exit(1)
  }

  // Verify that chunks are distinct and overlap exists
  for (let i = 0; i < storedChunks.length; i++) {
    const chunk = storedChunks[i]
    log.info(`Chunk ${i + 1} preview: "${chunk.content.substring(0, 60)}..." (Length: ${chunk.content.length})`)
    
    if (chunk.content.length > chunkSize) {
      log.error(`FAIL: Chunk ${i + 1} exceeds max chunkSize: ${chunk.content.length} > ${chunkSize}`)
      process.exit(1)
    }
  }

  log.info('Cleaning up test database records...')
  const deleted = await db.delete(documentChunks).where(eq(documentChunks.sourceUrl, sourceUrl))
  log.info('✓ Test database records cleaned up successfully.')

  log.info('=== PASS: Semantic Chunking & Ingestion Verification Successful ===')
  process.exit(0)
}

runTests().catch((err) => {
  log.error({ err }, 'Test execution failed')
  process.exit(1)
})
