const fs = require('fs');
const path = require('path');
const https = require('https');

const configPath = path.join(process.env.USERPROFILE, '.railway', 'config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const token = config.user.accessToken;

const query = JSON.stringify({
  query: `mutation { serviceCreate(input: {name: "hub", projectId: "3c889d9f-407e-4a67-b1d3-377976b4b2c8"}) { id name } }`
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
