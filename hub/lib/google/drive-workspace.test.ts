import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  ensureWorkspace,
  escapeDriveQueryValue,
  artifactFileName,
  moveFileToFolder,
  FOLDER_MIME,
  SHORTCUT_MIME,
  DEFAULT_ROOT_FOLDER_NAME,
  type WorkspaceStore,
  type StoredWorkspace,
} from './drive-workspace'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/**
 * Mocked Drive as a small state machine: routes each request by URL/method so a
 * test can describe the Drive-side world (what exists, what's trashed) rather
 * than choreographing a fixed response queue.
 */
function stubDrive(world: {
  files?: Record<string, { id: string; mimeType?: string; trashed?: boolean; shortcutTargetId?: string }>
  searchResults?: Record<string, string>
  onCreate?: (body: Record<string, unknown>) => string
}) {
  const created: Record<string, unknown>[] = []
  const patched: { url: string }[] = []
  let createCounter = 0

  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'

    if (method === 'POST') {
      const body = JSON.parse((init?.body as string) ?? '{}')
      created.push(body)
      const id = world.onCreate?.(body) ?? `created-${++createCounter}`
      return new Response(JSON.stringify({ id }), { status: 200 })
    }

    if (method === 'PATCH') {
      patched.push({ url })
      return new Response(JSON.stringify({ id: 'patched' }), { status: 200 })
    }

    // Search (list) request.
    if (url.includes('?q=') || url.includes('&q=')) {
      const q = decodeURIComponent(new URL(url).searchParams.get('q') ?? '')
      const matchKey = Object.keys(world.searchResults ?? {}).find(k => q.includes(k))
      const id = matchKey ? world.searchResults![matchKey] : undefined
      const files = id ? [{ id, mimeType: FOLDER_MIME, trashed: false }] : []
      return new Response(JSON.stringify({ files }), { status: 200 })
    }

    // Get-by-id request.
    const id = url.split('/files/')[1]?.split('?')[0]
    const file = id ? world.files?.[id] : undefined
    if (!file) {
      return new Response('{"error":{"code":404,"message":"File not found"}}', { status: 404 })
    }
    return new Response(
      JSON.stringify({
        id: file.id,
        mimeType: file.mimeType ?? FOLDER_MIME,
        trashed: file.trashed ?? false,
        ...(file.shortcutTargetId ? { shortcutDetails: { targetId: file.shortcutTargetId } } : {}),
      }),
      { status: 200 },
    )
  })

  vi.stubGlobal('fetch', fetchMock)
  return { fetchMock, created, patched }
}

function memoryStore(initial: StoredWorkspace | null = null) {
  let state = initial
  const store: WorkspaceStore = {
    load: async () => state,
    save: async (_t, _e, ws) => {
      state = ws
    },
  }
  return { store, get: () => state }
}

const opts = (store: WorkspaceStore, ensure: 'documents'[] = []) => ({
  tenantId: 'rxfit',
  email: 'danny@rxfitatx.com',
  ensure,
  store,
})

describe('escapeDriveQueryValue', () => {
  it("escapes apostrophes so a name cannot break or alter the query", () => {
    expect(escapeDriveQueryValue("Danny's Folder")).toBe("Danny\\'s Folder")
    expect(escapeDriveQueryValue('back\\slash')).toBe('back\\\\slash')
  })
})

describe('artifactFileName', () => {
  it('prefixes the ISO date', () => {
    expect(artifactFileName('Q3 Review', new Date('2026-07-28T12:00:00Z'))).toBe('2026-07-28 — Q3 Review')
  })
})

describe('ensureWorkspace', () => {
  it('uses the cached root when it still verifies, without searching or creating', async () => {
    const { store } = memoryStore({ rootFolderId: 'root-1', folders: {} })
    const { fetchMock, created } = stubDrive({ files: { 'root-1': { id: 'root-1' } } })

    const ws = await ensureWorkspace('tok', opts(store))

    expect(ws.rootId).toBe('root-1')
    expect(created).toHaveLength(0)
    // Exactly one call: the verification GET. This is the hot path.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('creates the root folder when nothing exists yet', async () => {
    const { store, get } = memoryStore(null)
    const { created } = stubDrive({ files: {}, searchResults: {} })

    const ws = await ensureWorkspace('tok', opts(store))

    expect(created[0]).toMatchObject({ name: DEFAULT_ROOT_FOLDER_NAME, mimeType: FOLDER_MIME })
    expect(created[0].appProperties).toMatchObject({ hubOverlay: 'root', hubTenant: 'rxfit' })
    expect(ws.rootId).toBe('created-1')
    // The new id is cached for next time.
    expect(get()?.rootFolderId).toBe('created-1')
  })

  it('follows the folder by id when the user RENAMED or MOVED it', async () => {
    // Rename/move changes name and parent but not the id — nothing should break.
    const { store } = memoryStore({ rootFolderId: 'root-1', folders: {} })
    const { created } = stubDrive({ files: { 'root-1': { id: 'root-1' } } })

    const ws = await ensureWorkspace('tok', opts(store))

    expect(ws.rootId).toBe('root-1')
    expect(created).toHaveLength(0)
  })

  it('respects a TRASHED folder as intent: rediscovers or creates, never untrashes', async () => {
    const { store } = memoryStore({ rootFolderId: 'root-1', folders: {} })
    const { created, patched } = stubDrive({
      files: { 'root-1': { id: 'root-1', trashed: true } },
      searchResults: {}, // rediscovery finds nothing (query excludes trashed)
    })

    const ws = await ensureWorkspace('tok', opts(store))

    // A fresh folder, and crucially NO PATCH un-trashing the old one.
    expect(ws.rootId).toBe('created-1')
    expect(created).toHaveLength(1)
    expect(patched).toHaveLength(0)
  })

  it('rediscovers by appProperties when the cached id is gone (404)', async () => {
    const { store } = memoryStore({ rootFolderId: 'stale-id', folders: {} })
    const { created } = stubDrive({
      files: {},
      searchResults: { "value='root'": 'rediscovered-root' },
    })

    const ws = await ensureWorkspace('tok', opts(store))

    expect(ws.rootId).toBe('rediscovered-root')
    expect(created).toHaveLength(0)
  })

  it('resolves a SHORTCUT to its target instead of treating it as the folder', async () => {
    const { store } = memoryStore({ rootFolderId: 'shortcut-1', folders: {} })
    stubDrive({
      files: {
        'shortcut-1': { id: 'shortcut-1', mimeType: SHORTCUT_MIME, shortcutTargetId: 'real-root' },
        'real-root': { id: 'real-root', mimeType: FOLDER_MIME },
      },
    })

    const ws = await ensureWorkspace('tok', opts(store))

    // Writing parents:[shortcutId] would fail — the target is what we need.
    expect(ws.rootId).toBe('real-root')
  })

  it('creates a requested subfolder under the root and caches it', async () => {
    const { store, get } = memoryStore({ rootFolderId: 'root-1', folders: {} })
    const { created } = stubDrive({ files: { 'root-1': { id: 'root-1' } }, searchResults: {} })

    const ws = await ensureWorkspace('tok', opts(store, ['documents']))

    expect(created[0]).toMatchObject({ name: 'Documents', parents: ['root-1'] })
    expect(ws.folders.documents).toBe('created-1')
    expect(get()?.folders.documents).toBe('created-1')
  })

  it('drops cached subfolder ids when the root is replaced', async () => {
    // Subfolder ids belonged to the OLD root; re-verifying them would be wrong.
    const { store } = memoryStore({ rootFolderId: 'dead-root', folders: { documents: 'old-doc-folder' } })
    const { created } = stubDrive({ files: {}, searchResults: {} })

    const ws = await ensureWorkspace('tok', opts(store, ['documents']))

    expect(ws.rootId).toBe('created-1')
    expect(ws.folders.documents).toBe('created-2')
    expect(created[1]).toMatchObject({ name: 'Documents', parents: ['created-1'] })
  })

  it('still provisions when the store throws (DB outage must not block writes)', async () => {
    const brokenStore: WorkspaceStore = {
      load: async () => {
        throw new Error('db down')
      },
      save: async () => {
        throw new Error('db down')
      },
    }
    stubDrive({ files: {}, searchResults: {} })

    const ws = await ensureWorkspace('tok', { tenantId: 'rxfit', email: 'd@x.com', store: brokenStore })

    expect(ws.rootId).toBe('created-1')
  })

  it('honors a per-tenant root folder name', async () => {
    const { store } = memoryStore(null)
    const { created } = stubDrive({ files: {}, searchResults: {} })

    await ensureWorkspace('tok', { tenantId: 'rosepop', email: 'a@b.com', rootName: 'Rose Pop Hub', store })

    expect(created[0]).toMatchObject({ name: 'Rose Pop Hub' })
  })
})

describe('moveFileToFolder', () => {
  it('adds the folder parent and removes root', async () => {
    const { fetchMock } = stubDrive({ files: {} })
    await moveFileToFolder('tok', 'file-1', 'folder-1')

    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain('addParents=folder-1')
    expect(url).toContain('removeParents=root')
  })
})
