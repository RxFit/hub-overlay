const { Client } = require('pg');
const crypto = require('crypto');
const { scryptSync } = require('crypto');

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) { console.error('DATABASE_URL not set'); process.exit(1); }

// Better Auth uses scrypt with these exact parameters:
// N: 16384, r: 16, p: 1, dkLen: 64
// Hash format: hex(salt):hex(derived_key)

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = scryptSync(
    Buffer.from(password.normalize('NFKC')),
    salt,
    64,
    { N: 16384, r: 16, p: 1, maxmem: 128 * 16384 * 16 * 2 }
  );
  return `${salt}:${key.toString('hex')}`;
}

async function main() {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();

  const userId = 'danny-rxfit-admin';
  const password = 'RxFit2026!';
  const hash = hashPassword(password);

  console.log(`Generated scrypt hash: ${hash.substring(0, 40)}...`);

  // Update the existing credential account with the correct hash format
  const result = await client.query(`
    UPDATE account SET password = $1, updated_at = now()
    WHERE id = 'danny-rxfit-credential' AND provider_id = 'credential'
  `, [hash]);

  console.log(`✅ Updated ${result.rowCount} row(s)`);
  console.log('');
  console.log('=== LOGIN CREDENTIALS ===');
  console.log(`Email:    danny@rxfitatx.com`);
  console.log(`Password: ${password}`);
  console.log('');
  console.log('Go to: https://paperclip-production-4394.up.railway.app');

  await client.end();
}

main().catch(e => { console.error(e); process.exit(1); });
