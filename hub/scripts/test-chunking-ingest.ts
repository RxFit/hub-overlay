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
PARAGRAPH 1: Introduction to RxFit Performance Standards.
The core mission of RxFit is to deliver top-tier health and athletic performance insights. By combining data-driven training metrics with advanced metabolic analytics, we ensure that every client receives a highly customized roadmap. This document outlines the operational guidelines for the coaching fleet, superadmins, and staff. It is imperative that all members adhere strictly to these benchmarks to maintain consistency and safety across all training locations.

PARAGRAPH 2: Metabolic Conditioning Protocols and Guidelines.
When designing conditioning plans, coaches must prioritize aerobic foundation development before introducing high-intensity anaerobic work. Metabolic pathways are trained sequentially, beginning with zone 2 endurance workouts designed to build mitochondrial density. Each session should be logged in the client dashboard, noting heart rate recovery times and perceived exertion rates. This tracking allows the AI engine to accurately predict performance gains and flag potential overtraining risks.

PARAGRAPH 3: Nutrition and Recovery Integration.
Performance is only as good as recovery. Our integrated nutrition guides focus on whole-food diets tailored to the client's metabolic type. High-protein intake combined with healthy fats and complex carbohydrates forms the bedrock of our nutritional recommendations. Sleep tracking is also a core requirement; clients must log at least 7.5 hours of sleep nightly. If a client falls below this threshold, the command center will automatically flag their recovery index.

PARAGRAPH 4: Safety, Compliance, and Injury Prevention.
Under no circumstances should client metrics be ignored when they indicate physical strain. Coaches must perform a weekly functional movement screening to identify joint restrictions or kinetic imbalances. If a client reports joint pain exceeding a level 3 out of 10, the workout must be terminated immediately and referred to a physical therapist. All injury incidents, no matter how minor, must be logged using the event-logger.

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
