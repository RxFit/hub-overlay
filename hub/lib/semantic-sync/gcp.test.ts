import { describe, it, expect, vi } from 'vitest'
import { createDiscoveryImporter, parseOperation } from './discovery-import'
import { createGcsStore } from './gcs'

const token = async () => 'tok'

describe('createGcsStore', () => {
  it('uploads media to the object name, URL-encoded, with the bearer token', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}'))
    const store = createGcsStore({ bucket: 'sb-email', token, fetchImpl })
    await store.put('hub/gmail/docs/gmail-1.html', '<html/>', 'text/html; charset=utf-8')
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(
      'https://storage.googleapis.com/upload/storage/v1/b/sb-email/o?uploadType=media&name=hub%2Fgmail%2Fdocs%2Fgmail-1.html',
    )
    expect(init).toMatchObject({ method: 'POST', body: '<html/>' })
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
    expect(store.uri('a/b')).toBe('gs://sb-email/a/b')
  })

  it('a rejected write names the upload stage and Google\'s reason', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ error: { message: 'x does not have storage.objects.create access' } }, { status: 403 }),
    )
    const store = createGcsStore({ bucket: 'sb', token, fetchImpl })
    await expect(store.put('docs/a.html', '', 'text/html')).rejects.toMatchObject({
      stage: 'upload',
      httpStatus: 403,
      message: expect.stringContaining('storage.objects.create'),
    })
    await expect(store.put('p/_state.json', '', 'application/json')).rejects.toMatchObject({ stage: 'state' })
  })

  it('getJson: 404 is "no state yet", not a failure', async () => {
    const store = createGcsStore({ bucket: 'sb', token, fetchImpl: vi.fn(async () => new Response('', { status: 404 })) })
    expect(await store.getJson('p/_state.json')).toBeNull()
    const ok = createGcsStore({ bucket: 'sb', token, fetchImpl: vi.fn(async () => Response.json({ version: 1 })) })
    expect(await ok.getJson('p/_state.json')).toEqual({ version: 1 })
  })
})

describe('createDiscoveryImporter', () => {
  const ds = 'projects/p/locations/global/collections/default_collection/dataStores/sb-email'

  it('starts an INCREMENTAL document-schema import of the manifests on the default branch', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ name: `${ds}/branches/0/operations/import-documents-1` }))
    const op = await createDiscoveryImporter({ token, fetchImpl }).start(ds, ['gs://sb/a.jsonl', 'gs://sb/b.jsonl'])
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`https://discoveryengine.googleapis.com/v1/${ds}/branches/default_branch/documents:import`)
    expect(JSON.parse(init.body as string)).toEqual({
      gcsSource: { inputUris: ['gs://sb/a.jsonl', 'gs://sb/b.jsonl'], dataSchema: 'document' },
      reconciliationMode: 'INCREMENTAL',
    })
    expect(op).toBe(`${ds}/branches/0/operations/import-documents-1`)
  })

  it('a rejected import names the import stage', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ error: { status: 'PERMISSION_DENIED', message: 'denied' } }, { status: 403 }))
    await expect(createDiscoveryImporter({ token, fetchImpl }).start(ds, ['gs://x'])).rejects.toMatchObject({
      stage: 'import',
      message: expect.stringContaining('PERMISSION_DENIED: denied'),
    })
  })
})

describe('parseOperation', () => {
  it('running', () => {
    expect(parseOperation('op', { name: 'op' })).toEqual({ operation: 'op', done: false })
  })

  it('done — Int64 counts arrive as strings; error samples are carried', () => {
    expect(
      parseOperation('op', {
        done: true,
        metadata: { successCount: '12', failureCount: '1' },
        response: { errorSamples: [{ message: 'doc x: unsupported mime' }] },
      }),
    ).toEqual({ operation: 'op', done: true, successCount: 12, failureCount: 1, errors: ['doc x: unsupported mime'] })
  })

  it('done with an operation-level error', () => {
    expect(parseOperation('op', { done: true, error: { message: 'bucket not readable' } })).toMatchObject({
      successCount: 0,
      failureCount: 0,
      errors: ['bucket not readable'],
    })
  })
})
