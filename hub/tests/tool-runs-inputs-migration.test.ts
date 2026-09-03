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
