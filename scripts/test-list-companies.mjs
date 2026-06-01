const email = "Danny@rxfitatx.com";
const password = "Paperclip2026!";
const baseUrl = "https://rxfit-paperclip-11747747730.us-central1.run.app";
const companyId = "829b2493-97ed-4cb9-8775-ff8298dcf650";

async function main() {
  console.log("Authenticating...");
  const authRes = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': baseUrl
    },
    body: JSON.stringify({ email, password })
  });

  if (!authRes.ok) {
    console.error("Auth failed:", authRes.status, await authRes.text());
    return;
  }

  const cookie = authRes.headers.get('set-cookie');
  console.log("Authenticated! Fetching agents...");

  const agentsRes = await fetch(`${baseUrl}/api/companies/${companyId}/agents`, {
    headers: {
      'cookie': cookie,
      'Origin': baseUrl
    }
  });

  if (!agentsRes.ok) {
    console.error("Fetch agents failed:", agentsRes.status, await agentsRes.text());
    return;
  }

  const data = await agentsRes.json();
  console.log("Agents:", JSON.stringify(data, null, 2));
}

main().catch(console.error);
