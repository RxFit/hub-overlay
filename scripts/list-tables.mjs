import pg from 'pg'
const client = new pg.Client({ connectionString: process.argv[2], ssl: false })
await client.connect()
const r = await client.query(`
  SELECT tablename, pg_total_relation_size(quote_ident(tablename))::bigint as size_bytes
  FROM pg_tables
  WHERE schemaname = 'public'
  ORDER BY size_bytes DESC
`)
console.log(`Found ${r.rows.length} tables:`)
for (const row of r.rows) {
  const count = await client.query(`SELECT COUNT(*) as c FROM "${row.tablename}"`)
  console.log(`  ${row.tablename}: ${count.rows[0].c} rows (${(row.size_bytes / 1024).toFixed(1)} KB)`)
}
await client.end()
