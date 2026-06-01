/**
 * Quick fix: create the drizzle schema and verify data counts.
 */
import pg from 'pg'

const databaseUrl = process.argv[2]
if (!databaseUrl) { console.error('Provide DATABASE_URL'); process.exit(1) }

const client = new pg.Client({ connectionString: databaseUrl, ssl: false })

try {
  await client.connect()
  
  // Create drizzle schema if it doesn't exist
  await client.query('CREATE SCHEMA IF NOT EXISTS "drizzle"')
  console.log('✅ drizzle schema ensured')

  // Run ANALYZE to update statistics
  await client.query('ANALYZE')
  console.log('✅ ANALYZE complete')

  // Get real row counts for key tables
  const tables = ['company', 'project', 'issue', 'run', 'agent', 'account', 'user', 'session']
  for (const t of tables) {
    try {
      const r = await client.query(`SELECT COUNT(*) as count FROM "public"."${t}"`)
      console.log(`  ${t}: ${r.rows[0].count} rows`)
    } catch {
      // Table might not exist
    }
  }
} finally {
  await client.end()
}
