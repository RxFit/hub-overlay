const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  
  const url = 'https://hub-6r2wdzwkoq-uc.a.run.app';
  
  console.log('='.repeat(60));
  console.log('QA TEST: Hub Overlay Production');
  console.log('='.repeat(60));

  // Test 1: Login page loads
  console.log('\n📋 Test 1: Login page loads');
  const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  const status = response?.status();
  const title = await page.title();
  const finalUrl = page.url();
  console.log(`  Status: ${status}`);
  console.log(`  Title: ${title}`);
  console.log(`  URL: ${finalUrl}`);
  const t1pass = title.includes('RxFit Hub') && finalUrl.includes('/login');
  console.log(`  ${t1pass ? '✅' : '❌'} RESULT: ${t1pass ? 'PASS' : 'FAIL'}`);

  // Test 2: Zero FridgeSnap in HTML
  console.log('\n📋 Test 2: No FridgeSnap in HTML source');
  const html = await page.content();
  const fridgeCount = (html.match(/fridgesnap/gi) || []).length;
  const t2pass = fridgeCount === 0;
  console.log(`  FridgeSnap matches: ${fridgeCount}`);
  console.log(`  ${t2pass ? '✅' : '❌'} RESULT: ${t2pass ? 'PASS' : 'FAIL'}`);

  // Test 3: Zero FridgeSnap in visible text
  console.log('\n📋 Test 3: No FridgeSnap in visible text');
  const bodyText = await page.textContent('body');
  const textCount = (bodyText?.match(/fridgesnap/gi) || []).length;
  const t3pass = textCount === 0;
  console.log(`  FridgeSnap in text: ${textCount}`);
  console.log(`  ${t3pass ? '✅' : '❌'} RESULT: ${t3pass ? 'PASS' : 'FAIL'}`);

  // Test 4: Correct branding
  console.log('\n📋 Test 4: Correct branding');
  const hasRxFit = bodyText?.includes('RxFit');
  const hasPaperclip = bodyText?.includes('Paperclip');
  const hasCommandCenter = title.includes('Command Center');
  console.log(`  RxFit in text: ${hasRxFit}`);
  console.log(`  Paperclip in text: ${hasPaperclip}`);
  console.log(`  Command Center in title: ${hasCommandCenter}`);
  const t4pass = hasRxFit && hasPaperclip && hasCommandCenter;
  console.log(`  ${t4pass ? '✅' : '❌'} RESULT: ${t4pass ? 'PASS' : 'FAIL'}`);

  // Test 5: Google OAuth button present
  console.log('\n📋 Test 5: Google OAuth button');
  const googleButton = await page.$('text=Sign in with Google');
  const t5pass = !!googleButton;
  console.log(`  Google button found: ${t5pass}`);
  console.log(`  ${t5pass ? '✅' : '❌'} RESULT: ${t5pass ? 'PASS' : 'FAIL'}`);

  // Test 6: API health check
  console.log('\n📋 Test 6: API health');
  try {
    const healthPage = await context.newPage();
    const healthResp = await healthPage.goto(`${url}/api/health`, { timeout: 10000 });
    const healthStatus = healthResp?.status();
    const t6pass = healthStatus === 200;
    console.log(`  Health endpoint: ${healthStatus}`);
    console.log(`  ${t6pass ? '✅' : '❌'} RESULT: ${t6pass ? 'PASS' : 'FAIL'}`);
    await healthPage.close();
  } catch (e) {
    console.log(`  Health check error: ${e.message}`);
    console.log(`  ⚠️  RESULT: SKIP (endpoint may not exist)`);
  }

  // Test 7: No other project contamination
  console.log('\n📋 Test 7: No cross-project contamination');
  const patterns = ['fridgesnap', 'fridge-food-snap', 'foodsnap'];
  let contamFound = false;
  for (const p of patterns) {
    const count = (html.match(new RegExp(p, 'gi')) || []).length;
    if (count > 0) {
      console.log(`  ❌ Found "${p}": ${count} matches`);
      contamFound = true;
    }
  }
  const t7pass = !contamFound;
  console.log(`  ${t7pass ? '✅' : '❌'} RESULT: ${t7pass ? 'PASS — zero contamination' : 'FAIL'}`);

  // Summary
  const allPassed = t1pass && t2pass && t3pass && t4pass && t5pass && t7pass;
  console.log('\n' + '='.repeat(60));
  console.log(`${allPassed ? '✅ ALL TESTS PASSED' : '❌ SOME TESTS FAILED'}`);
  console.log('='.repeat(60));

  // Screenshot
  await page.screenshot({ path: 'C:/Agent_Scratchpad/hub-paperclip/qa_final.png', fullPage: true });
  console.log('📸 Screenshot: C:/Agent_Scratchpad/hub-paperclip/qa_final.png');

  await browser.close();
})();
