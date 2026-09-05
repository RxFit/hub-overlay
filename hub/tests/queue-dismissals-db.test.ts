import { it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { describeDb, migrateTestDb, resetDb, seedTenant, closeDb } from '../test/db-harness'

/**
 * lib/queue-dismissals — DB-backed (Phase 4 PR 2). Locks the overlay's
 * contract against a real Postgres: idempotent dismiss (the unique index
 * absorbs a double tap), user + tenant scoping, undo. Gated with describeDb —
 * skips locally without DATABASE_URL, runs in CI.
 */
import { dismissItem, undismissItem, listDismissedKeys } from '@/lib/queue-dismissals'

describeDb('queue_dismissals — DB-backed', () => {
  beforeAll(() => {
    migrateTestDb()
  })
  beforeEach(async () => {
    await resetDb()
    await seedTenant()
  })
  afterAll(async () => {
    await closeDb()
  })

  it('dismisses idempotently, scopes by user (case-insensitively) and tenant, and undoes', async () => {
    await dismissItem('rxfit', 'Danny@rxfitatx.com', 'run:abc')
    await dismissItem('rxfit', 'danny@rxfitatx.com', 'run:abc') // double tap — no error, no duplicate
    await dismissItem('rxfit', 'danny@rxfitatx.com', 'deep:t1')
    await dismissItem('rxfit', 'staff@rxfitatx.com', 'action:a1')

    expect([...await listDismissedKeys('rxfit', 'danny@rxfitatx.com')].sort()).toEqual(['deep:t1', 'run:abc'])
    expect([...await listDismissedKeys('rxfit', 'staff@rxfitatx.com')]).toEqual(['action:a1'])

    await undismissItem('rxfit', 'DANNY@rxfitatx.com', 'run:abc')
    await undismissItem('rxfit', 'danny@rxfitatx.com', 'never:dismissed') // no-op
    expect([...await listDismissedKeys('rxfit', 'danny@rxfitatx.com')]).toEqual(['deep:t1'])
  })
})
