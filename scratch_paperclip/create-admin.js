const { Client } = require('pg');
const crypto = require('crypto');

const DB_URL = 'postgresql://postgres:REDACTED_PASSWORD@localhost:5432/railway';
const EMAIL = 'danny@rxfitatx.com';

async function main() {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();

  // 1. Upsert the user
  const userId = 'danny-rxfit-admin';
  await client.query(`
    INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
    VALUES ($1, $2, $3, true, now(), now())
    ON CONFLICT (id) DO UPDATE SET email = $3, updated_at = now()
  `, [userId, 'Danny Trejo', EMAIL]);
  console.log(`✅ User upserted: ${EMAIL}`);

  // 2. Upsert instance_admin role
  await client.query(`
    INSERT INTO instance_user_roles (id, user_id, role, created_at, updated_at)
    VALUES ($1, $2, 'instance_admin', now(), now())
    ON CONFLICT (user_id, role) DO NOTHING
  `, [crypto.randomUUID(), userId]);
  console.log('✅ instance_admin role granted');

  // 3. Generate a one-time magic link token
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expires = new Date(Date.now() + 15 * 60 * 1000); // 15 min

  await client.query(`
    INSERT INTO verification (id, identifier, value, expires_at, created_at, updated_at)
    VALUES ($1, $2, $3, $4, now(), now())
    ON CONFLICT DO NOTHING
  `, [crypto.randomUUID(), EMAIL, tokenHash, expires]);

  console.log('\n🔑 Magic link token generated.');
  console.log('Open this URL in your browser to sign in:');
  console.log(`\nhttps://paperclip-production-4394.up.railway.app/api/auth/callback/email?token=${token}&email=${encodeURIComponent(EMAIL)}\n`);

  await client.end();
}

main().catch(e => { console.error(e); process.exit(1); });
