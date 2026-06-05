const puppeteer = require('puppeteer');

async function runTests() {
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  
  console.log('--- Starting 3 Browser Tests ---');

  // Test 1: Verify homepage load
  console.log('\\n[Test 1] Navigating to https://hub.casatrejo.com...');
  const response = await page.goto('https://hub.casatrejo.com', { waitUntil: 'networkidle2' });
  const title = await page.title();
  console.log(`Status: ${response.status()}`);
  console.log(`Title: ${title}`);
  if (response.status() === 200) {
    console.log('✓ Test 1 Passed: Homepage loaded successfully.');
  } else {
    console.log('✗ Test 1 Failed: Homepage did not load properly.');
  }

  // Test 2: Check API Embeddings Upsert endpoint (Expect 401 without auth)
  console.log('\\n[Test 2] Testing /api/embeddings/upsert POST endpoint...');
  const apiResponse = await page.evaluate(async () => {
    const res = await fetch('https://hub.casatrejo.com/api/embeddings/upsert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId: 'test', sourceUrl: 'test', content: 'test' })
    });
    return { status: res.status };
  });
  console.log(`API Status: ${apiResponse.status}`);
  if (apiResponse.status === 401) {
    console.log('✓ Test 2 Passed: Endpoint securely rejected unauthorized request.');
  } else {
    console.log('✗ Test 2 Failed: Endpoint did not return 401 as expected.');
  }

  // Test 3: Check Chat API Endpoint (Expect 401 or similar without auth)
  console.log('\\n[Test 3] Testing /api/chat POST endpoint...');
  const chatResponse = await page.evaluate(async () => {
    const res = await fetch('https://hub.casatrejo.com/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'test' }] })
    });
    return { status: res.status };
  });
  console.log(`Chat API Status: ${chatResponse.status}`);
  if (chatResponse.status === 401 || chatResponse.status === 405) {
    console.log(`✓ Test 3 Passed: Chat endpoint responded appropriately (${chatResponse.status}).`);
  } else {
    console.log('✗ Test 3 Failed: Unexpected response from chat endpoint.');
  }

  await browser.close();
  console.log('\\n--- Browser Tests Complete ---');
}

runTests().catch(console.error);
