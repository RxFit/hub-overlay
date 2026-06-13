import { loadEnvConfig } from '@next/env'
loadEnvConfig(process.cwd())

import { loopDetector, LoopDetectedError } from '../lib/loop-detector'
import { recordEvent } from '../lib/event-logger'
import { storeMemory, queryMemories, pruneExpiredMemories, deleteMemory } from '../lib/agent-memory'
import { createLogger } from '../lib/logger'
import { db } from '../lib/db'
import { eventLog } from '../lib/schema'
import { eq } from 'drizzle-orm'

const log = createLogger('test-tri-pillar')

async function runTests() {
  log.info('=== Starting Tri-Pillar Hardening Verification ===')

  // 1. Loop Detection Test
  log.info('Testing Loop Detector...')
  loopDetector.clear()
  const method = 'POST'
  const path = '/api/companies/123/issues'
  const body = { title: 'Loop Test', priority: 'high' }

  // First 2 calls should succeed
  loopDetector.detectAndRecord(method, path, body)
  loopDetector.detectAndRecord(method, path, body)
  log.info('First two calls recorded successfully.')

  // 3rd call should throw LoopDetectedError
  try {
    loopDetector.detectAndRecord(method, path, body)
    log.error('FAIL: LoopDetector did not block sequential duplicates')
  } catch (err) {
    if (err instanceof LoopDetectedError) {
      log.info(`PASS: LoopDetector correctly threw: ${err.message}`)
    } else {
      log.error({ err }, 'FAIL: LoopDetector threw unexpected error')
    }
  }

  // 2. Event Sourcing DB Test
  log.info('Testing Event Sourcing DB Logging...')
  const testCorrelationId = `test-corr-${Date.now()}`
  await recordEvent({
    eventType: 'test.event',
    actor: 'test-agent:verifier',
    resourceType: 'system_test',
    resourceId: 'test-123',
    payload: { verified: true },
    correlationId: testCorrelationId,
  })

  // Read back event
  const events = await db
    .select()
    .from(eventLog)
    .where(eq(eventLog.correlationId, testCorrelationId))

  if (events.length === 1 && events[0].eventType === 'test.event') {
    log.info(`PASS: Event log inserted and verified in DB (ID: ${events[0].id})`)
  } else {
    log.error({ events }, 'FAIL: Event log was not retrieved correctly')
  }

  // 3. Agent Memory Layer DB Test
  log.info('Testing Agent Memory Layer DB...')
  const testAgentId = `test-agent-${Date.now()}`
  const expireDate = new Date(Date.now() - 1000) // already expired

  const [stored] = await storeMemory({
    agentId: testAgentId,
    memoryType: 'insight',
    content: 'The user prefers HSL tailored colors for visual excellence.',
    context: { project: 'RxFit-Hardening' },
    expiresAt: expireDate,
  })

  log.info(`Stored memory ID: ${stored.id}`)

  // Search memories
  const queryResult = await queryMemories({
    agentId: testAgentId,
    searchQuery: 'HSL tailored colors',
  })

  if (queryResult.length === 1 && queryResult[0].agentId === testAgentId) {
    log.info(`PASS: Agent memory successfully queried and retrieved from DB: "${queryResult[0].content}"`)
  } else {
    log.error({ queryResult }, 'FAIL: Agent memory query returned unexpected results')
  }

  // Test pruning expired memories
  log.info('Testing TTL Pruning...')
  await pruneExpiredMemories('rxfit')
  const postPruneResult = await queryMemories({
    agentId: testAgentId,
  })

  if (postPruneResult.length === 0) {
    log.info('PASS: Expired memory successfully pruned from DB')
  } else {
    log.error({ postPruneResult }, 'FAIL: Expired memory was not pruned')
  }

  // Clean up any test log records
  log.info('Cleaning up test data...')
  await db.delete(eventLog).where(eq(eventLog.correlationId, testCorrelationId))
  log.info('=== Tri-Pillar Hardening Verification Complete ===')
  process.exit(0)
}

runTests().catch((err) => {
  log.error({ err }, 'Test execution failed')
  process.exit(1)
})
