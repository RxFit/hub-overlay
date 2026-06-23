import { describe, it, expect } from 'vitest'
import { buildSearchBody } from './vertex'

/* P0-4: scoped semantic search must use dataStoreSpecs (full resource path),
   never the invalid `filter: dataStore:"id"` that 400s and silently returns null. */
describe('buildSearchBody', () => {
  it('omits any datastore restriction when none is given (search whole engine)', () => {
    const body = buildSearchBody('hello')
    expect(body.query).toBe('hello')
    expect(body).not.toHaveProperty('dataStoreSpecs')
    expect(body).not.toHaveProperty('filter') // the old broken mechanism is gone
  })

  it('uses dataStoreSpecs with a full resource path for a bare datastore id', () => {
    const body = buildSearchBody('q', 'rxfit-gdrive') as { dataStoreSpecs?: { dataStore: string }[]; filter?: unknown }
    expect(body.filter).toBeUndefined()
    expect(Array.isArray(body.dataStoreSpecs)).toBe(true)
    const path = body.dataStoreSpecs![0].dataStore
    expect(path).toMatch(/^projects\/.+\/locations\/.+\/collections\/default_collection\/dataStores\/rxfit-gdrive$/)
  })

  it('passes an already-qualified datastore resource path through unchanged', () => {
    const full = 'projects/p/locations/global/collections/default_collection/dataStores/ds'
    const body = buildSearchBody('q', full) as { dataStoreSpecs?: { dataStore: string }[] }
    expect(body.dataStoreSpecs![0].dataStore).toBe(full)
  })

  it('keeps the content-search spec', () => {
    const body = buildSearchBody('q') as { contentSearchSpec?: unknown }
    expect(body.contentSearchSpec).toBeDefined()
  })
})
