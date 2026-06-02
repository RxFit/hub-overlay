const fetch = require('node-fetch') || globalThis.fetch;

async function testChat() {
  console.log("Sending chat test...");
  try {
    const res = await fetch('http://localhost:3000/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ id: '1', role: 'user', content: 'What is the status of the project?' }],
        useCase: 'deep_dive'
      })
    });
    
    if (!res.ok) {
      console.error("API error:", res.status, await res.text());
      return;
    }
    
    const text = await res.text();
    console.log("Response chunks length:", text.length);
    console.log("Snippet:", text.substring(0, 500));
  } catch (err) {
    console.error("Fetch failed:", err);
  }
}

testChat();
