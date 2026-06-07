require('dotenv').config({ path: '.env.local' });
const postgres = require('postgres');

async function main() {
  const sql = postgres(process.env.DATABASE_URL);
  try {
    await sql`ALTER TABLE "hub_users" ADD COLUMN "google_refresh_token" text;`;
    console.log('Migration successful');
  } catch (err) {
    if (err.message.includes('already exists')) {
      console.log('Column already exists.');
    } else {
      console.error(err);
      process.exit(1);
    }
  } finally {
    await sql.end();
  }
}

main();
