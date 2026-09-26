import { describe, it, expect } from 'vitest'
import { DEFAULT_GMAIL_QUERY, chatEnginePath, parseGcsUri, readSourceConfig, resolveDataStore } from './config'

const SA = '{"client_email":"x@y.iam.gserviceaccount.com","private_key":"k","token_uri":"https://oauth2.googleapis.com/token"}'

describe('parseGcsUri', () => {
  it.each([
    ['gs://sb-stripe', { bucket: 'sb-stripe', prefix: '' }],
    ['gs://sb-stripe/', { bucket: 'sb-stripe', prefix: '' }],
    ['gs://sb-stripe/hub/sync/', { bucket: 'sb-stripe', prefix: 'hub/sync' }],
    ['  gs://semantic-brain-desktop-staging/x  ', { bucket: 'semantic-brain-desktop-staging', prefix: 'x' }],
  ])('%s', (uri, expected) => {
    expect(parseGcsUri(uri)).toEqual(expected)
  })

  it.each([undefined, '', 'sb-stripe', 'https://storage.googleapis.com/sb', 'gs://UPPER', 'gs://ok-bucket/../escape'])(
    'rejects %s',
    (uri) => {
      expect(parseGcsUri(uri)).toBeNull()
    },
  )
})

describe('resolveDataStore', () => {
  it('expands a bare id under the Semantic Brain project', () => {
    expect(resolveDataStore('sb-email', 'semantic-brain-desktop')).toBe(
      'projects/semantic-brain-desktop/locations/global/collections/default_collection/dataStores/sb-email',
    )
  })

  it('passes a full resource path through', () => {
    const full = 'projects/p/locations/global/collections/default_collection/dataStores/ds_1'
    expect(resolveDataStore(full, 'ignored')).toBe(full)
  })

  it('rejects malformed values instead of building a bad URL', () => {
    expect(resolveDataStore('has space', 'p')).toBeNull()
    expect(resolveDataStore('projects/p/dataStores/x', 'p')).toBeNull()
    expect(resolveDataStore('', 'p')).toBeNull()
  })
})

describe('readSourceConfig — deny by default', () => {
  it('reports every missing variable for an unconfigured deployment', () => {
    expect(readSourceConfig('stripe', {})).toMatchObject({
      ready: false,
      missing: ['GOOGLE_SERVICE_ACCOUNT_KEY', 'SEMANTIC_SYNC_STRIPE_GCS_URI', 'STRIPE_SECRET_KEY'],
    })
    expect(readSourceConfig('gmail', {})).toMatchObject({
      ready: false,
      missing: ['GOOGLE_SERVICE_ACCOUNT_KEY', 'SEMANTIC_SYNC_GMAIL_GCS_URI', 'SEMANTIC_SYNC_GMAIL_SUBJECT'],
    })
  })

  it('is ready with a key, a location and the source credential; the data store is optional', () => {
    const c = readSourceConfig('stripe', {
      GOOGLE_SERVICE_ACCOUNT_KEY: SA,
      SEMANTIC_SYNC_STRIPE_GCS_URI: 'gs://sb-stripe/hub',
      STRIPE_SECRET_KEY: 'rk_live_x',
    })
    expect(c).toMatchObject({ ready: true, missing: [], location: { bucket: 'sb-stripe', prefix: 'hub' } })
    expect(c.dataStore).toBeUndefined()
  })

  it('flags a SET but malformed data store rather than silently skipping the import', () => {
    const c = readSourceConfig('stripe', {
      GOOGLE_SERVICE_ACCOUNT_KEY: SA,
      SEMANTIC_SYNC_STRIPE_GCS_URI: 'gs://sb-stripe',
      STRIPE_SECRET_KEY: 'rk',
      SEMANTIC_SYNC_STRIPE_DATA_STORE: 'bad id!',
    })
    expect(c.ready).toBe(false)
    expect(c.missing).toEqual(['SEMANTIC_SYNC_STRIPE_DATA_STORE'])
  })

  it('gmail: requires an email-shaped subject and defaults the noise filter', () => {
    const env = {
      GOOGLE_SERVICE_ACCOUNT_KEY: SA,
      SEMANTIC_SYNC_GMAIL_GCS_URI: 'gs://sb-email',
      SEMANTIC_SYNC_GMAIL_DATA_STORE: 'sb-email-ds',
      VERTEX_GCP_PROJECT: 'proj',
    }
    expect(readSourceConfig('gmail', { ...env, SEMANTIC_SYNC_GMAIL_SUBJECT: 'not-an-email' }).missing).toEqual([
      'SEMANTIC_SYNC_GMAIL_SUBJECT',
    ])
    const ok = readSourceConfig('gmail', { ...env, SEMANTIC_SYNC_GMAIL_SUBJECT: 'danny@rxfitatx.com' })
    expect(ok).toMatchObject({
      ready: true,
      subject: 'danny@rxfitatx.com',
      query: DEFAULT_GMAIL_QUERY,
      dataStore: 'projects/proj/locations/global/collections/default_collection/dataStores/sb-email-ds',
    })
  })

  it('gmail: an explicitly empty query means "no filter", not the default', () => {
    const c = readSourceConfig('gmail', {
      GOOGLE_SERVICE_ACCOUNT_KEY: SA,
      SEMANTIC_SYNC_GMAIL_GCS_URI: 'gs://sb-email',
      SEMANTIC_SYNC_GMAIL_SUBJECT: 'a@b.co',
      SEMANTIC_SYNC_GMAIL_QUERY: '',
    })
    expect(c.query).toBe('')
  })
})

describe('chatEnginePath', () => {
  it('names the engine the Hub chat searches, with lib/vertex.ts defaults', () => {
    expect(chatEnginePath({})).toBe(
      'projects/semantic-brain-desktop/locations/global/collections/default_collection/engines/semanticbrain_1779229063037',
    )
    expect(chatEnginePath({ VERTEX_GCP_PROJECT: 'p', VERTEX_ENGINE_ID: 'e' })).toBe(
      'projects/p/locations/global/collections/default_collection/engines/e',
    )
  })
})
