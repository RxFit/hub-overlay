const { Client } = require('pg');
const crypto = require('crypto');

const DB_URL = 'postgresql://postgres:REDACTED_PASSWORD@localhost:5432/railway';
const USER_ID = 'danny-rxfit-admin';

async function main() {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();

  // Get all companies
  const companies = await client.query('SELECT id, name, issue_prefix FROM companies');
  console.log(`Found ${companies.rows.length} companies:\n`);

  for (const co of companies.rows) {
    console.log(`  ${co.issue_prefix} — ${co.name} (${co.id})`);

    // Check if membership already exists
    const existing = await client.query(
      'SELECT id FROM company_memberships WHERE principal_id = $1 AND company_id = $2',
      [USER_ID, co.id]
    );

    if (existing.rows.length > 0) {
      console.log(`    ✅ Already a member`);
      continue;
    }

    // Add membership with admin role
    await client.query(`
      INSERT INTO company_memberships (id, company_id, principal_type, principal_id, status, membership_role, created_at, updated_at)
      VALUES ($1, $2, 'user', $3, 'active', 'admin', now(), now())
    `, [crypto.randomUUID(), co.id, USER_ID]);
    console.log(`    ✅ Added as admin`);
  }

  console.log('\nDone. Refresh the Paperclip dashboard.');
  await client.end();
}

main().catch(e => { console.error(e); process.exit(1); });
