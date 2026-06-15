const { Client } = require('pg');
// SECURITY: hardcoded credential removed 2026-06-12. Set PAPERCLIP_DB_URL to run.
if (!process.env.PAPERCLIP_DB_URL) { console.error('PAPERCLIP_DB_URL env var is required'); process.exit(1); }
const client = new Client({ connectionString: process.env.PAPERCLIP_DB_URL });

client.connect().then(() => {
  return client.query('SELECT * FROM "account"');
}).then(res => {
  console.log(res.rows);
  client.end();
}).catch(err => {
  console.error(err);
  client.end();
});
