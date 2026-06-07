import { breaker, CircuitOpenError } from '../lib/circuit-breaker'
import { createLogger } from '../lib/logger'

const log = createLogger('test-probe-storm')

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function runProbeStormTest() {
  log.info('--- Starting Half-Open Probe Storm Mitigation Tests ---')
  const key = 'probe-storm-test-circuit'
  const opts = { threshold: 3, resetMs: 500 }

  // Reset any state for this key
  breaker.reset(key)

  // 1. Trip the circuit breaker
  log.info('1. Tripping the circuit breaker with 3 failures...')
  for (let i = 0; i < 3; i++) {
    try {
      await breaker.execute(key, async () => { throw new Error('Timeout') }, opts)
    } catch (e) {
      // expected
    }
  }

  log.info(`Current state (should be open): ${breaker.getState(key)}`)

  // 2. Wait for resetMs (500ms) to allow transitioning to half-open
  log.info('2. Waiting 600ms for reset interval to expire...')
  await sleep(600)

  // 3. Trigger multiple concurrent requests to simulate a probe storm
  log.info('3. Simulating concurrent requests in half-open state...')
  let probeStartedCount = 0
  let probeCompletedCount = 0
  let openErrorCount = 0

  const runRequest = async (id: number) => {
    try {
      await breaker.execute(key, async () => {
        log.info({ id }, `Request ${id} entered the probe block (executing protected fn)`)
        probeStartedCount++
        // Simulate a bit of network latency in the probe
        await sleep(200)
        probeCompletedCount++
        return `Result from ${id}`
      }, opts)
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        openErrorCount++
      } else {
        log.error({ id, err }, `Request ${id} threw an unexpected error`)
      }
    }
  }

  // Fire 5 requests in parallel!
  await Promise.all([
    runRequest(1),
    runRequest(2),
    runRequest(3),
    runRequest(4),
    runRequest(5)
  ])

  log.info('Results of simulated storm:')
  log.info(`- Probe started count (should be exactly 1): ${probeStartedCount}`)
  log.info(`- Probe completed count (should be exactly 1): ${probeCompletedCount}`)
  log.info(`- Fast-failed open error count (should be 4): ${openErrorCount}`)

  if (probeStartedCount === 1 && openErrorCount === 4) {
    log.info('✅ SUCCESS: Half-open probe storm mitigated perfectly!')
  } else {
    log.error('❌ FAILURE: Probe storm mitigation failed!')
  }

  log.info('--- Tests Complete ---')
}

runProbeStormTest().catch(console.error)
