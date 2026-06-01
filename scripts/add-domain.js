const fs = require('fs');
const path = require('path');
const https = require('https');

const configPath = path.join(process.env.USERPROFILE, '.railway', 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const token = config.user.accessToken;

const projectId = '3c889d9f-407e-4a67-b1d3-377976b4b2c8';
const serviceId = '76af7f7b-82d5-4dbc-a3c0-ca5926a1e296';
const environmentId = 'badae8a7-6d37-4eb5-bab6-279fbecd601e';
const domain = 'hub.casatrejo.com';

const query = JSON.stringify({
  query: `mutation { customDomainCreate(input: {domain: "${domain}", serviceId: "${serviceId}", environmentId: "${environmentId}", projectId: "${projectId}"}) { id domain } }`
});

const req = https.request('https://backboard.railway.com/graphql/v2', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(query),
  }
}, (res) => {
  let data = '';
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => console.log(data));
});

req.write(query);
req.end();
