const { Client } = require('pg');
const client = new Client({ connectionString: 'postgresql://postgres:REDACTED_PASSWORD@localhost:5432/railway' });

client.connect().then(() => {
  return client.query('SELECT * FROM "account"');
}).then(res => {
  console.log(res.rows);
  client.end();
}).catch(err => {
  console.error(err);
  client.end();
});
