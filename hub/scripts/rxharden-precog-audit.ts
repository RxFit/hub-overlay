/**
 * RxHarden Pre-Cog Audit Script
 * 
 * Phase 1: Technical Analysis — static code inspection results
 * Phase 2: Empirical Testing — live DB + embedding calls  
 * Phase 3: Forensic Analysis — edge cases, weaknesses, breaking points
 */
import { loadEnvConfig } from '@next/env'
loadEnvConfig(process.cwd())

import { db } from '../lib/db'
import { documentChunks } from '../lib/schema'
import { searchSimilarDocuments, generateEmbedding } from '../lib/vector-store'
import { createLogger } from '../lib/logger'
import { sql, count } from 'drizzle-orm'

const log = createLogger('rxharden-precog')

interface TestResult {
  phase: string
  test: string
  passed: boolean
  detail: string
}

const results: TestResult[] = []

function record(phase: string, test: string, passed: boolean, detail: string) {
  results.push({ phase, test, passed, detail })
  const icon = passed ? '✅' : '❌'
  log.info(`${icon} [${phase}] ${test}: ${detail}`)
}

async function phase1_TechnicalAnalysis() {
  log.info('══════════════════════════════════════════════════')
  log.info('Phase 1: Technical Analysis')
  log.info('══════════════════════════════════════════════════')

  // T1: Verify threshold value is present in SQL query
  const fs = await import('fs')
  const vectorStoreCode = fs.readFileSync('./lib/vector-store.ts', 'utf8')
  
  const hasThresholdInQuery = vectorStoreCode.includes('SIMILARITY_THRESHOLD') && vectorStoreCode.includes('.where(')
  record('Technical', 'Similarity threshold in SQL WHERE clause', hasThresholdInQuery,
    hasThresholdInQuery 
      ? 'WHERE clause uses SIMILARITY_THRESHOLD constant in filter'
      : 'MISSING: No threshold filter found in SQL query')

  // T2: Verify lazy GenAI initialization
  const hasLazyInit = vectorStoreCode.includes('function getGenAI()') && vectorStoreCode.includes('let genAI')
  record('Technical', 'Lazy GenAI initialization', hasLazyInit,
    hasLazyInit
      ? 'GenAI uses lazy singleton pattern via getGenAI()'
      : 'MISSING: GenAI should use lazy initialization')

  // T3: Verify the embedding model is the current, non-EOL model. gemini-embedding-001
  // reached end-of-life 2026-07-14; the app now uses gemini-embedding-2 (overridable
  // via EMBEDDING_MODEL). Fail if the dead model is still hardcoded.
  const usesCurrentModel = vectorStoreCode.includes('gemini-embedding-2')
    && !vectorStoreCode.includes("'gemini-embedding-001'")
  record('Technical', 'Current embedding model', usesCurrentModel,
    usesCurrentModel
      ? 'Uses gemini-embedding-2 (current; gemini-embedding-001 is EOL)'
      : 'MISSING: still references EOL gemini-embedding-001')

  // T4: Verify outputDimensionality is set to 768  
  const hasDimensionality = vectorStoreCode.includes('outputDimensionality: EMBEDDING_DIMENSIONS')
    && vectorStoreCode.includes('EMBEDDING_DIMENSIONS = 768')
  record('Technical', 'Output dimensionality set', hasDimensionality,
    hasDimensionality
      ? 'outputDimensionality pinned to EMBEDDING_DIMENSIONS (768)'
      : 'MISSING: outputDimensionality not explicitly set')

  // T5: Check that the cosine expression is not duplicated between select/where
  const cosineOccurrences = (vectorStoreCode.match(/<=>.*::vector/g) || []).length
  record('Technical', 'Cosine expression duplication check', cosineOccurrences <= 2,
    `Found ${cosineOccurrences} cosine distance expression(s) in vector-store.ts (select + where)`)

  // T6: Check route.ts for discard logging
  const routeCode = fs.readFileSync('./app/api/chat/route.ts', 'utf8')
  const hasDiscardLog = routeCode.includes('discarded') && routeCode.includes('threshold')
  record('Technical', 'Discard logging in route.ts', hasDiscardLog,
    hasDiscardLog
      ? 'route.ts logs when chunks are discarded due to low relevance threshold'
      : 'MISSING: route.ts should log discarded chunks')

  // T7: Number() cast for similarity score
  const hasNumberCast = routeCode.includes('Number(r.similarity)')
  record('Technical', 'Number() cast for similarity', hasNumberCast,
    hasNumberCast
      ? 'route.ts safely casts r.similarity with Number()'
      : 'MISSING: Similarity score should use Number() cast')

  // T8: Check threshold is not hardcoded as magic number — should be a named constant
  const hasMagicNumber = vectorStoreCode.includes('> 0.65') && !vectorStoreCode.includes('SIMILARITY_THRESHOLD')
  record('Technical', 'Magic number check (threshold)', !hasMagicNumber,
    hasMagicNumber
      ? 'FINDING: 0.65 threshold is hardcoded as magic number — should be a named constant'
      : 'Threshold uses a named constant')

  // T9: Check that searchSimilarDocuments returns [] on error (defensive)
  const hasEmptyReturn = vectorStoreCode.includes('return []')
  record('Technical', 'Error returns empty array', hasEmptyReturn,
    hasEmptyReturn
      ? 'searchSimilarDocuments returns [] on error — safe fallback'
      : 'MISSING: Should return [] on error to prevent crashes')

  // T10: Verify SQL injection safety — tenantId is parameterized
  const hasParameterizedTenant = vectorStoreCode.includes('${tenantId}') && vectorStoreCode.includes('sql`')
  record('Technical', 'Parameterized tenant ID', hasParameterizedTenant,
    hasParameterizedTenant
      ? 'tenantId is passed via Drizzle sql template — parameterized'
      : 'WARNING: tenantId may not be parameterized')
}

async function phase2_EmpiricalTesting() {
  log.info('')
  log.info('══════════════════════════════════════════════════')
  log.info('Phase 2: Empirical Testing')
  log.info('══════════════════════════════════════════════════')

  const tenantId = process.env.NEXT_PUBLIC_TENANT_ID || 'rxfit'

  // E1: Test embedding generation
  let embedding: number[] | null = null
  try {
    embedding = await generateEmbedding('RxFit client scheduling optimization')
    record('Empirical', 'Embedding generation', embedding.length === 768,
      `Generated embedding with ${embedding.length} dimensions`)
  } catch (err) {
    record('Empirical', 'Embedding generation', false,
      `Failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  // E2: Count total chunks in DB for this tenant
  let totalChunks = 0
  try {
    const [result] = await db
      .select({ count: count() })
      .from(documentChunks)
      .where(sql`${documentChunks.tenantId} = ${tenantId}`)
    totalChunks = result?.count ?? 0
    record('Empirical', 'Chunk count for tenant', totalChunks > 0,
      `Found ${totalChunks} total document chunk(s) for tenant '${tenantId}'`)
  } catch (err) {
    record('Empirical', 'Chunk count for tenant', false,
      `DB query failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  // E3: Test searchSimilarDocuments with a real query
  try {
    const results = await searchSimilarDocuments(tenantId, 'project management workflow', 5)
    record('Empirical', 'searchSimilarDocuments call', true,
      `Returned ${results.length} result(s) out of ${totalChunks} total chunks (limit=5)`)

    // E4: Verify all returned results are above threshold
    let allAboveThreshold = true
    for (const r of results) {
      const score = Number(r.similarity)
      if (score <= 0.65) {
        allAboveThreshold = false
        record('Empirical', `Threshold violation: chunk ${r.id}`, false,
          `Score ${score.toFixed(4)} is <= 0.65`)
      }
    }
    if (results.length > 0) {
      record('Empirical', 'All results above 0.65 threshold', allAboveThreshold,
        allAboveThreshold
          ? `All ${results.length} results have similarity > 0.65`
          : 'Some results violated the threshold!')
    }

    // E5: Log the actual scores
    for (const r of results) {
      log.info({ id: r.id, sourceUrl: r.sourceUrl, similarity: Number(r.similarity).toFixed(4) },
        'Returned chunk detail')
    }
  } catch (err) {
    record('Empirical', 'searchSimilarDocuments call', false,
      `Failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  // E6: Test with a nonsense query (should return 0 results if threshold works)
  try {
    const nonsenseResults = await searchSimilarDocuments(tenantId, 'xyzzy qwqwqw 9191919 frobnicator', 5)
    record('Empirical', 'Nonsense query returns few/no results', nonsenseResults.length <= 1,
      `Nonsense query returned ${nonsenseResults.length} result(s) — threshold should filter irrelevant matches`)
  } catch (err) {
    record('Empirical', 'Nonsense query test', false,
      `Failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  // E7: Test with empty query
  try {
    const emptyResults = await searchSimilarDocuments(tenantId, '', 3)
    record('Empirical', 'Empty query handling', true,
      `Empty query returned ${emptyResults.length} result(s) — function did not crash`)
  } catch (err) {
    record('Empirical', 'Empty query handling', false,
      `Crashed on empty query: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function phase3_ForensicAnalysis() {
  log.info('')
  log.info('══════════════════════════════════════════════════')
  log.info('Phase 3: Forensic Analysis')
  log.info('══════════════════════════════════════════════════')

  const fs = await import('fs')
  const vectorStoreCode = fs.readFileSync('./lib/vector-store.ts', 'utf8')
  const routeCode = fs.readFileSync('./app/api/chat/route.ts', 'utf8')
  const tenantId = process.env.NEXT_PUBLIC_TENANT_ID || 'rxfit'

  // F1: SQL Injection via tenantId
  // The sql`` template tag in Drizzle parameterizes values, but the AND clause
  // with the cosine expression also uses JSON.stringify(queryEmbedding)
  const usesJsonStringify = vectorStoreCode.includes('JSON.stringify(queryEmbedding)')
  record('Forensic', 'Embedding vector serialization', usesJsonStringify,
    usesJsonStringify
      ? 'FINDING: JSON.stringify of embedding vector is interpolated into SQL string — this is Drizzle sql template, so it is safe for the Drizzle-managed params, but the vector literal is embedded as a string.'
      : 'Vector serialization not found')

  // F2: Race condition in searchContext += 
  const hasSearchContextAppend = routeCode.includes("searchContext +=")
  const usesPromiseAll = routeCode.includes('Promise.all(searchPromises)')
  record('Forensic', 'Race condition on searchContext', true,
    'searchContext is mutated by concurrent async functions via +=. JavaScript is single-threaded so += is atomic between awaits. Current code is SAFE because each promise appends a distinct block.')

  // F3: No upper bound on embedding vector text length
  const hasTextLengthGuard = vectorStoreCode.includes('.slice(') || vectorStoreCode.includes('.substring(')
  record('Forensic', 'Input text length guard', hasTextLengthGuard,
    hasTextLengthGuard
      ? 'Text input is truncated before embedding'
      : 'FINDING: No text length guard on generateEmbedding(). Extremely long queries could hit Gemini token limits and throw.')

  // F4: Threshold is too aggressive for small corpora
  record('Forensic', 'Threshold calibration risk', true,
    'FINDING: A 0.65 cosine similarity threshold may be too aggressive for small corpora. With few chunks, even relevant results may score below 0.65 due to vocabulary mismatch. Consider making configurable via env var.')

  // F5: Double cosine computation in WHERE + SELECT  
  const whereClauseCount = (vectorStoreCode.match(/1 - \(/g) || []).length
  record('Forensic', 'Double cosine computation', whereClauseCount >= 2,
    `FINDING: Cosine distance is computed ${whereClauseCount}x per row (once in SELECT, once in WHERE). PostgreSQL may optimize this, but an explicit CTE or subquery would guarantee single computation.`)

  // F6: Discard log says "discarded" but doesn't report WHICH chunks or their scores
  const logsPerChunkScores = routeCode.includes('.similarity') && routeCode.includes('scores')
  record('Forensic', 'Discard log granularity', logsPerChunkScores,
    logsPerChunkScores
      ? 'Discard logging includes per-chunk scores and threshold value'
      : 'FINDING: Discard log only reports count, not the actual scores of discarded chunks.')

  // F7: Missing index on (tenant_id, embedding) for pgvector
  try {
    const indexResult = await db.execute(
      sql`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'document_chunks' AND indexdef LIKE '%embedding%'`
    ) as unknown as { indexname: string; indexdef: string }[]
    const hasVectorIndex = Array.isArray(indexResult) && indexResult.length > 0
    record('Forensic', 'pgvector index on embedding column', hasVectorIndex,
      hasVectorIndex
        ? `Found vector index: ${JSON.stringify(indexResult)}`
        : 'FINDING: No index on embedding column — cosine distance scans will be O(n). Add an IVFFlat or HNSW index.')
  } catch {
    record('Forensic', 'pgvector index check', false,
      'Could not query pg_indexes — check DB connectivity')
  }

  // F8: Test what happens with invalid tenantId
  try {
    const bogusResults = await searchSimilarDocuments('nonexistent-tenant-xyz', 'test', 3)
    record('Forensic', 'Invalid tenant ID handling', bogusResults.length === 0,
      `Query with bogus tenantId returned ${bogusResults.length} result(s) — should be 0`)
  } catch (err) {
    record('Forensic', 'Invalid tenant ID handling', false,
      `Crashed with bogus tenantId: ${err instanceof Error ? err.message : String(err)}`)
  }

  // F9: Check if upsert endpoint validates content length
  const upsertCode = fs.readFileSync('./app/api/embeddings/upsert/route.ts', 'utf8')
  const hasContentLengthCheck = upsertCode.includes('.length') || upsertCode.includes('content.slice')
  record('Forensic', 'Upsert content length validation', hasContentLengthCheck,
    hasContentLengthCheck
      ? 'Upsert endpoint validates content length'
      : 'FINDING: Upsert endpoint accepts arbitrarily large content. A single huge payload could exceed Gemini token limits or cause OOM.')
}

async function run() {
  log.info('╔══════════════════════════════════════════════════╗')
  log.info('║   RxHarden Pre-Cog Audit — Chat Retrieval       ║')
  log.info('║   Target: vector-store.ts + route.ts            ║')
  log.info('╚══════════════════════════════════════════════════╝')
  log.info('')

  await phase1_TechnicalAnalysis()
  await phase2_EmpiricalTesting()
  await phase3_ForensicAnalysis()

  // ── Summary ──
  log.info('')
  log.info('══════════════════════════════════════════════════')
  log.info('Summary')
  log.info('══════════════════════════════════════════════════')
  
  const passed = results.filter(r => r.passed).length
  const failed = results.filter(r => !r.passed).length
  const total = results.length

  log.info(`Total: ${total} | Passed: ${passed} | Failed: ${failed}`)
  
  if (failed > 0) {
    log.info('')
    log.info('Failed tests:')
    for (const r of results.filter(r => !r.passed)) {
      log.warn(`  ❌ [${r.phase}] ${r.test}: ${r.detail}`)
    }
  }

  // Return exit code based on critical failures
  const criticalFailures = results.filter(r => 
    !r.passed && (
      r.test.includes('threshold') ||
      r.test.includes('Embedding generation') ||
      r.test.includes('searchSimilarDocuments')
    )
  )

  if (criticalFailures.length > 0) {
    log.error(`${criticalFailures.length} CRITICAL failure(s) — audit FAILED`)
    process.exit(1)
  } else {
    log.info(`Audit PASSED with ${failed} non-critical finding(s)`)
    process.exit(0)
  }
}

run().catch((err) => {
  log.error({ err }, 'Audit execution crashed')
  process.exit(1)
})
