/**
 * Database migration v3: Disables FK constraints during restore.
 * Usage: node scripts/restore-to-railway.mjs <sql-file> <database-url>
 */
import { readFileSync } from 'fs'
import pg from 'pg'

const [,, sqlFile, databaseUrl] = process.argv
if (!sqlFile || !databaseUrl) {
  console.error('Usage: node restore-to-railway.mjs <sql-file> <database-url>')
  process.exit(1)
}

console.log(`Reading SQL dump: ${sqlFile}`)
const sql = readFileSync(sqlFile, 'utf-8')
console.log(`SQL size: ${(Buffer.byteLength(sql) / 1024 / 1024).toFixed(2)} MB`)

const client = new pg.Client({ connectionString: databaseUrl, ssl: false })

try {
  await client.connect()
  console.log('Connected to Railway Postgres!')
  
  // Drop ALL tables for clean restore
  console.log('Dropping existing tables...')
  const existing = await client.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`)
  for (const row of existing.rows) {
    await client.query(`DROP TABLE IF EXISTS "public"."${row.tablename}" CASCADE`)
  }
  await client.query('DROP SCHEMA IF EXISTS "drizzle" CASCADE')
  console.log(`Dropped ${existing.rows.length} tables`)

  // Disable FK constraints for the session
  await client.query('SET session_replication_role = replica')
  console.log('FK constraints disabled for restore')

  const lines = sql.split('\n')
  let sqlSuccess = 0, sqlErrors = 0
  let copySuccess = 0, copyErrors = 0
  const errorMessages = []
  
  let i = 0
  let currentStatement = ''
  let inCopyBlock = false
  let copyHeader = ''
  let copyData = []
  
  while (i < lines.length) {
    const line = lines[i]
    
    if (line.startsWith('-- paperclip statement breakpoint') || 
        (line.startsWith('--') && !inCopyBlock)) {
      i++; continue
    }
    
    if (!inCopyBlock && line.trim() === '') { i++; continue }
    
    if (!inCopyBlock && line.startsWith('COPY ') && line.includes('FROM stdin')) {
      inCopyBlock = true
      copyHeader = line.replace(/;$/, '')
      copyData = []
      i++; continue
    }
    
    if (inCopyBlock) {
      if (line === '\\.') {
        inCopyBlock = false
        
        const match = copyHeader.match(/COPY\s+"?(\w+)"?(?:\."?(\w+)"?)?\s*\(([^)]+)\)/)
        if (match && copyData.length > 0) {
          let schema, table, columns
          if (match[2]) { schema = match[1]; table = match[2] }
          else { schema = 'public'; table = match[1] }
          columns = match[3]
          
          // Batch INSERT (50 rows at a time)
          const batchSize = 50
          for (let b = 0; b < copyData.length; b += batchSize) {
            const batch = copyData.slice(b, b + batchSize)
            const allValues = []
            const valueRows = []
            let paramIdx = 1
            
            for (const row of batch) {
              const values = row.split('\t').map(v => v === '\\N' ? null : v.replace(/\\\\/g, '\\'))
              const placeholders = values.map(() => `$${paramIdx++}`)
              valueRows.push(`(${placeholders.join(', ')})`)
              allValues.push(...values)
            }
            
            try {
              await client.query(
                `INSERT INTO "${schema}"."${table}" (${columns}) VALUES ${valueRows.join(', ')}`,
                allValues
              )
              copySuccess += batch.length
            } catch (err) {
              // Try one at a time for the failed batch
              for (let r = 0; r < batch.length; r++) {
                const values = batch[r].split('\t').map(v => v === '\\N' ? null : v.replace(/\\\\/g, '\\'))
                const placeholders = values.map((_, idx) => `$${idx + 1}`)
                try {
                  await client.query(
                    `INSERT INTO "${schema}"."${table}" (${columns}) VALUES (${placeholders.join(', ')})`,
                    values
                  )
                  copySuccess++
                } catch (e2) {
                  copyErrors++
                  if (errorMessages.length < 10) {
                    errorMessages.push(`  ROW ${schema}.${table}: ${e2.message.slice(0, 100)}`)
                  }
                }
              }
            }
          }
        }
        i++; continue
      }
      
      copyData.push(line)
      i++; continue
    }
    
    // Regular SQL
    currentStatement += line + '\n'
    
    if (line.trimEnd().endsWith(';')) {
      const stmt = currentStatement.trim()
      currentStatement = ''
      
      if (stmt && stmt !== 'BEGIN;' && stmt !== 'COMMIT;' && 
          !stmt.startsWith('SET LOCAL session_replication_role') &&
          !stmt.startsWith('SET LOCAL client_min_messages')) {
        try {
          await client.query(stmt)
          sqlSuccess++
        } catch (err) {
          sqlErrors++
          if (errorMessages.length < 10) {
            errorMessages.push(`  SQL: ${err.message.slice(0, 100)} | ${stmt.slice(0, 60)}`)
          }
        }
      }
    }
    
    i++
    if (i % 10000 === 0) {
      console.log(`  Line ${i}/${lines.length} | SQL: ${sqlSuccess} | COPY: ${copySuccess} rows`)
    }
  }

  // Re-enable FK constraints
  await client.query('SET session_replication_role = DEFAULT')
  console.log('\nFK constraints re-enabled')

  console.log(`\n✅ Migration complete!`)
  console.log(`  SQL: ${sqlSuccess} ok, ${sqlErrors} errors`)
  console.log(`  COPY rows: ${copySuccess} inserted, ${copyErrors} errors`)
  
  if (errorMessages.length > 0) {
    console.log(`\nErrors:`)
    errorMessages.forEach(e => console.log(e))
  }

  // Verify
  console.log('\n--- Verification ---')
  const keyTables = ['companies', 'projects', 'issues', 'agents', 'user', 'board_api_keys', 
                     'company_memberships', 'labels', 'environments', 'activity_log', 'instance_settings']
  for (const t of keyTables) {
    try {
      const r = await client.query(`SELECT COUNT(*) as count FROM "public"."${t}"`)
      console.log(`  ✓ ${t}: ${r.rows[0].count} rows`)
    } catch (err) {
      console.log(`  ✗ ${t}: ${err.message.slice(0, 60)}`)
    }
  }

} finally {
  await client.end()
}
