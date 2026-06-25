import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Unit coverage for the Left Panel read/write fetchers (left-panel-audit 02).
 * Asserts each fetcher tags thrown errors with `.status` so section-level 401
 * detection works, and that `writeFetch` routes a 401 into signIn('google').
 */

const signInMock = vi.fn()
vi.mock('next-auth/react', () => ({
  signIn: (...args: unknown[]) => signInMock(...args),
}))

import { fetcher as kpiFetcher } from '@/app/hooks/useKPIData'
import { fetchTasksByList } from '@/app/hooks/useHubData'
import { artifactsFetcher } from '@/app/components/LeftPanelSections'
import { writeFetch } from '@/app/hooks/useWriteFetch'

function mockFetchResponse({ ok, status, body }: { ok: boolean; status: number; body?: unknown }) {
  return {
    ok,
    status,
    json: async () => body ?? {},
    text: async () => JSON.stringify(body ?? {}),
  } as unknown as Response
}

describe('useKPIData fetcher (F2)', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('throws a status-tagged error on 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockFetchResponse({ ok: false, status: 401, body: { error: 'nope' } })))
    await expect(kpiFetcher('/api/kpis')).rejects.toMatchObject({ status: 401 })
  })

  it('throws a status-tagged error on 500', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockFetchResponse({ ok: false, status: 500 })))
    await expect(kpiFetcher('/api/kpis')).rejects.toMatchObject({ status: 500 })
  })

  it('returns parsed JSON on 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockFetchResponse({ ok: true, status: 200, body: { kpis: [1] } })))
    await expect(kpiFetcher('/api/kpis')).resolves.toEqual({ kpis: [1] })
  })
})

describe('artifacts fetcher (F3)', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('throws a status-tagged error on 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockFetchResponse({ ok: false, status: 401 })))
    await expect(artifactsFetcher('/api/tool-artifacts')).rejects.toMatchObject({ status: 401 })
  })

  it('throws a status-tagged error on 500', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockFetchResponse({ ok: false, status: 500 })))
    await expect(artifactsFetcher('/api/tool-artifacts')).rejects.toMatchObject({ status: 500 })
  })

  it('returns parsed JSON on 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockFetchResponse({ ok: true, status: 200, body: { artifacts: [] } })))
    await expect(artifactsFetcher('/api/tool-artifacts')).resolves.toEqual({ artifacts: [] })
  })
})

describe('tasks per-list aggregate fetcher (F4)', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('rejects with a status-tagged 401 when any list returns 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockFetchResponse({ ok: false, status: 401 })))
    await expect(fetchTasksByList(['list-a'])).rejects.toMatchObject({ status: 401 })
  })

  it('skips non-auth failures (500) rather than failing the whole aggregate', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockFetchResponse({ ok: false, status: 500 })))
    await expect(fetchTasksByList(['list-a'])).resolves.toEqual({ 'list-a': [] })
  })

  it('returns a map of tasks per list on success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockFetchResponse({ ok: true, status: 200, body: { tasks: [{ id: 't1' }] } })))
    await expect(fetchTasksByList(['list-a'])).resolves.toEqual({ 'list-a': [{ id: 't1' }] })
  })
})

describe('writeFetch (F6)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    signInMock.mockClear()
  })
  afterEach(() => vi.restoreAllMocks())

  it('triggers signIn(google) and throws a status-tagged 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockFetchResponse({ ok: false, status: 401, body: { reauth: true } })))
    await expect(writeFetch('/api/google/tasks', { method: 'POST' })).rejects.toMatchObject({ status: 401 })
    expect(signInMock).toHaveBeenCalledWith('google')
  })

  it('does NOT call signIn when reauth is explicitly false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockFetchResponse({ ok: false, status: 401, body: { reauth: false } })))
    await expect(writeFetch('/api/google/tasks', { method: 'POST' })).rejects.toMatchObject({ status: 401 })
    expect(signInMock).not.toHaveBeenCalled()
  })

  it('throws a status-tagged error on non-401 failures and does not call signIn', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockFetchResponse({ ok: false, status: 500 })))
    await expect(writeFetch('/api/google/calendar', { method: 'DELETE' })).rejects.toMatchObject({ status: 500 })
    expect(signInMock).not.toHaveBeenCalled()
  })

  it('resolves with parsed JSON on success and does not call signIn', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockFetchResponse({ ok: true, status: 200, body: { id: 'evt1' } })))
    await expect(writeFetch('/api/google/calendar', { method: 'POST' })).resolves.toEqual({ id: 'evt1' })
    expect(signInMock).not.toHaveBeenCalled()
  })
})
