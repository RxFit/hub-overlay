import { describe, it, expect, vi, afterEach } from 'vitest'

/* ════════════════════════════════════════════════════════════════════════════
   getTenantId() — does not trust a spoofable client header (P2 tenant isolation).

   Previously getTenantId() returned the value of the `x-tenant-id` request
   header when present. That header is client-controllable, and middleware
   (which strips it) does not cover every route — so a caller could inject a
   tenant and cross isolation boundaries. The fix: getTenantId() ignores the
   header entirely and resolves to the default tenant. Behavior-neutral today
   (nothing legitimately sets the header; the app is single-tenant).
   ════════════════════════════════════════════════════════════════════════════ */

afterEach(() => {
  vi.resetModules()
  vi.unmock('next/headers')
})

describe('getTenantId', () => {
  it('resolves to the default tenant (rxfit) even when x-tenant-id is spoofed', async () => {
    // Simulate a request scope where a client injected a hostile tenant header.
    vi.doMock('next/headers', () => ({
      headers: () => new Map([['x-tenant-id', 'evil']]),
    }))
    const { getTenantId, FALLBACK_TENANT_ID } = await import('@/lib/tenant-context')
    expect(getTenantId()).toBe(FALLBACK_TENANT_ID)
    expect(getTenantId()).toBe('rxfit')
    expect(getTenantId()).not.toBe('evil')
  })

  it('honors NEXT_PUBLIC_TENANT_ID when set, still ignoring the header', async () => {
    const prev = process.env.NEXT_PUBLIC_TENANT_ID
    process.env.NEXT_PUBLIC_TENANT_ID = 'rxfit'
    vi.doMock('next/headers', () => ({
      headers: () => new Map([['x-tenant-id', 'evil']]),
    }))
    const { getTenantId } = await import('@/lib/tenant-context')
    expect(getTenantId()).toBe('rxfit')
    if (prev === undefined) delete process.env.NEXT_PUBLIC_TENANT_ID
    else process.env.NEXT_PUBLIC_TENANT_ID = prev
  })
})
