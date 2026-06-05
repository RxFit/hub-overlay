import { breaker, CircuitOpenError } from '../lib/circuit-breaker'
import { withRetry } from '../lib/retry'
import { createLogger } from '../lib/logger'

const log = createLogger('test')

async function runTests() {
  log.info('--- Starting Empirical Tests ---')

  // 1. Test Retry Logic
  log.info('Testing withRetry (Transient failures)...')
  let attempts = 0
  try {
    await withRetry(async () => {
      attempts++
      if (attempts < 3) throw new Error('502 Bad Gateway')
      return 'Success'
    }, { maxAttempts: 3, baseMs: 100 })
    log.info(`withRetry passed. Succeeded on attempt ${attempts}`)
  } catch (err) {
    log.error({ err }, 'withRetry failed unexpectedly')
  }

  // 2. Test Retry Failure (Deterministic)
  log.info('Testing withRetry (Deterministic failure)...')
  attempts = 0
  try {
    await withRetry(async () => {
      attempts++
      throw new Error('400 Bad Request')
    })
    log.error('withRetry should have thrown')
  } catch (err) {
    log.info(`withRetry correctly bailed out on 400 after ${attempts} attempt(s)`)
  }

  // 3. Test Circuit Breaker
  log.info('Testing Circuit Breaker...')
  const key = 'test-circuit'
  
  // Trip the breaker
  for (let i = 0; i < 3; i++) {
    try {
      await breaker.execute(key, async () => { throw new Error('Timeout') })
    } catch (e) {
      // expected
    }
  }

  log.info(`Circuit state after 3 failures: ${breaker.getState(key)}`)

  try {
    await breaker.execute(key, async () => { return 'Should not run' })
    log.error('Circuit Breaker failed to block execution')
  } catch (err) {
    if (err instanceof CircuitOpenError) {
      log.info('Circuit Breaker successfully blocked execution (CircuitOpenError)')
    } else {
      log.error({ err }, 'Circuit Breaker threw unexpected error')
    }
  }

  log.info('--- Tests Complete ---')
}

runTests().catch(console.error)
