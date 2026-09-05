import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Phase 4 PR 2 schema additions travel BOTH paths: the production migration
 * (drizzle/migrate.mjs, the deploy path) and the generated SQL file, kept
 * narrowly additive — the same guard tool-runs-inputs-migration.test.ts
 * applies to the previous tool_runs column.
 */
describe('needs-you migration (tool_runs.retry_of + queue_dismissals)', () => {
  const migrate = readFileSync(new URL('../drizzle/migrate.mjs', import.meta.url), 'utf8')
  const generated = readFileSync(new URL('../drizzle/0012_needs_you.sql', import.meta.url), 'utf8')

  it('adds retry_of on both fresh and existing databases through the production path', () => {
    expect(migrate).toMatch(/CREATE TABLE IF NOT EXISTS tool_runs[\s\S]*retry_of\s+UUID/)
    expect(migrate).toMatch(/ALTER TABLE tool_runs ADD COLUMN IF NOT EXISTS retry_of UUID/)
  })

  it('creates the dismissals overlay with its per-user unique key', () => {
    expect(migrate).toMatch(/CREATE TABLE IF NOT EXISTS queue_dismissals[\s\S]*item_key\s+TEXT NOT NULL/)
    expect(migrate).toMatch(/queue_dismissals_user_key_uniq[\s\S]*\(tenant_id, user_email, item_key\)/)
  })

  it('keeps the generated migration narrowly additive', () => {
    expect(generated).toContain('ALTER TABLE "tool_runs" ADD COLUMN IF NOT EXISTS "retry_of" uuid;')
    expect(generated).toContain('CREATE TABLE IF NOT EXISTS "queue_dismissals"')
    expect(generated).not.toMatch(/DROP|ALTER COLUMN|SET NOT NULL/)
  })
})
