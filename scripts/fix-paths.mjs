import { Client } from 'pg';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  console.log('Connecting to database...');
  const client = new Client({ connectionString: url });
  await client.connect();

  const oldPath = 'C:\\\\Users\\\\danie\\\\.paperclip\\\\instances\\\\default'; // note four slashes for SQL LIKE
  const newPath = '/root/.paperclip/instances/default';

  // We need to find columns containing this path. The tables are likely:
  // agents (instructions_dir, etc)
  
  // Let's first look at all tables and columns
  const res = await client.query(`
    SELECT table_name, column_name 
    FROM information_schema.columns 
    WHERE table_schema = 'public' AND data_type IN ('text', 'character varying');
  `);

  console.log('Replacing paths in tables...');
  let totalChanged = 0;

  for (const row of res.rows) {
    const table = row.table_name;
    const col = row.column_name;
    try {
      const updateRes = await client.query(`
        UPDATE "${table}" 
        SET "${col}" = REPLACE("${col}", 'C:\\Users\\danie\\.paperclip\\instances\\default', '/root/.paperclip/instances/default')
        WHERE "${col}" LIKE '%C:\\\\Users\\\\danie\\\\.paperclip\\\\instances\\\\default%';
      `);
      if (updateRes.rowCount > 0) {
        console.log(`Updated ${updateRes.rowCount} rows in ${table}.${col}`);
        totalChanged += updateRes.rowCount;
      }
    } catch (e) {
      // some columns might be generated or read-only
    }
  }

  console.log(`Finished. Total rows updated: ${totalChanged}`);
  await client.end();
}

main().catch(console.error);
