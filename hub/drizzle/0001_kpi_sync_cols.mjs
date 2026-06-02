/**
 * Migration 0001 — add KPI sync columns
 * Run: node drizzle/0001_kpi_sync_cols.mjs
 */
import postgres from 'postgres'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set')
  process.exit(1)
}

const sql = postgres(DATABASE_URL, { ssl: 'require', max: 1 })

async function migrate() {
  console.log('Running migration 0001: KPI sync columns…')

  await sql`
    ALTER TABLE kpis
      ADD COLUMN IF NOT EXISTS previous_value   TEXT,
      ADD COLUMN IF NOT EXISTS source_config    JSONB,
      ADD COLUMN IF NOT EXISTS last_synced_at   TIMESTAMPTZ
  `
  console.log('✓ Columns added: previous_value, source_config, last_synced_at')

  await sql.end()
  console.log('Migration 0001 complete.')
}

migrate().catch(err => {
  console.error('Migration failed:', err)
  process.exit(1)
})
