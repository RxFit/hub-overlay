const { Client } = require('pg');
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
const client = new Client({ connectionString: process.env.DATABASE_URL });

client.connect().then(() => {
  return client.query('SELECT * FROM "account"');
}).then(res => {
  console.log(res.rows);
  client.end();
}).catch(err => {
  console.error(err);
  client.end();
});
