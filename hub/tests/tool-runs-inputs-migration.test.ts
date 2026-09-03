import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('tool_runs inputs migration', () => {
  it('upgrades both fresh and existing databases through the production migration path', () => {
    const source = readFileSync(new URL('../drizzle/migrate.mjs', import.meta.url), 'utf8')
    expect(source).toMatch(/CREATE TABLE IF NOT EXISTS tool_runs[\s\S]*inputs\s+JSONB/)
    expect(source).toMatch(/ALTER TABLE tool_runs ADD COLUMN IF NOT EXISTS inputs JSONB/)
  })

  it('keeps the generated migration narrowly additive', () => {
    const source = readFileSync(new URL('../drizzle/0005_high_proteus.sql', import.meta.url), 'utf8')
    expect(source.trim()).toBe('ALTER TABLE "tool_runs" ADD COLUMN IF NOT EXISTS "inputs" jsonb;')
    expect(source).not.toMatch(/CREATE TABLE/)
  })
})

describe('tool_runs tenant migration', () => {
  it('upgrades the production path without stranding historical rows', () => {
    const source = readFileSync(new URL('../drizzle/migrate.mjs', import.meta.url), 'utf8')
    expect(source).toMatch(/CREATE TABLE IF NOT EXISTS tool_runs[\s\S]*tenant_id\s+TEXT NOT NULL REFERENCES tenants\(id\)/)
    expect(source).toMatch(/ADD COLUMN IF NOT EXISTS tenant_id TEXT[\s\S]*UPDATE tool_runs SET tenant_id = 'rxfit' WHERE tenant_id IS NULL[\s\S]*ALTER COLUMN tenant_id SET NOT NULL/)
    expect(source).toMatch(/tool_runs_user_created_idx[\s\S]*tenant_id, user_email, created_at DESC/)
    expect(source).toMatch(/tool_runs_one_active_per_user[\s\S]*tenant_id, user_email[\s\S]*status = 'queued'/)
  })

  it('backfills before enforcing the generated migration constraint', () => {
    const source = readFileSync(new URL('../drizzle/0006_nice_firestar.sql', import.meta.url), 'utf8')
    const add = source.indexOf('ADD COLUMN "tenant_id" text;')
    const backfill = source.indexOf('SET "tenant_id" = \'rxfit\'')
    const notNull = source.indexOf('ALTER COLUMN "tenant_id" SET NOT NULL')
    expect(add).toBeGreaterThanOrEqual(0)
    expect(backfill).toBeGreaterThan(add)
    expect(notNull).toBeGreaterThan(backfill)
    expect(source).toContain('("tenant_id","user_email") WHERE status = \'queued\'')
  })
})
