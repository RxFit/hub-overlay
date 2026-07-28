import { describe, it, expect, vi, afterEach } from 'vitest'

// Stub the DB-backed store so this suite needs no database — the behavior under
// test is the failure posture, not persistence.
vi.mock('./drive-workspace-db', () => ({
  dbWorkspaceStore: { load: async () => null, save: async () => {} },
}))

import { resolveArtifactFolder } from './artifact-folder'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('resolveArtifactFolder', () => {
  it('returns the provisioned subfolder id on the happy path', async () => {
    let created = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if ((init?.method ?? 'GET') === 'POST') {
          return new Response(JSON.stringify({ id: `folder-${++created}` }), { status: 200 })
        }
        return new Response(JSON.stringify({ files: [] }), { status: 200 })
      }),
    )

    const result = await resolveArtifactFolder('tok', 'danny@rxfitatx.com', 'documents')

    // folder-1 is the root, folder-2 the Documents subfolder.
    expect(result.folderId).toBe('folder-2')
    expect(result.tenantId).toBeTruthy()
  })

  it('degrades to no folder — never throws — when Drive refuses', async () => {
    // The whole point: a folder problem must not fail the user's document.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":{"message":"insufficient permissions"}}', { status: 403 })),
    )

    const result = await resolveArtifactFolder('tok', 'danny@rxfitatx.com', 'documents')

    expect(result.folderId).toBeUndefined()
    expect(result.tenantId).toBeTruthy()
  })
})
