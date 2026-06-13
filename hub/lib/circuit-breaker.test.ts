import { describe, it, expect } from 'vitest'
import { CircuitBreaker, CircuitOpenError } from './circuit-breaker'

describe('CircuitBreaker per-tenant key isolation', () => {
  it('trips for a key on repeated failures and remains closed for a different key', async () => {
    const cb = new CircuitBreaker({ threshold: 2, resetMs: 10_000 })
    const failingFn = async () => {
      throw new Error('API down')
    }
    const successFn = async () => 'ok'

    const keyTenantA = 'tenantA:paperclip-api'
    const keyTenantB = 'tenantB:paperclip-api'

    // 1. Fail twice on Tenant A to trip it
    await expect(cb.execute(keyTenantA, failingFn)).rejects.toThrow('API down')
    await expect(cb.execute(keyTenantA, failingFn)).rejects.toThrow('API down')

    // 2. Tenant A should now be OPEN (throws CircuitOpenError)
    await expect(cb.execute(keyTenantA, successFn)).rejects.toThrow(CircuitOpenError)

    // 3. Tenant B should still be CLOSED and succeed
    await expect(cb.execute(keyTenantB, successFn)).resolves.toBe('ok')
  })
})
