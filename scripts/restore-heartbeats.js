const https = require('https');

const PAPERCLIP_URL = "https://rxfit-paperclip-11747747730.us-central1.run.app";
const EMAIL = "Danny@rxfitatx.com";
const PASSWORD = "Paperclip2026!";

const COMPANIES = {
  "RxFit Enterprise": "829b2493-97ed-4cb9-8775-ff8298dcf650",
  "NotebookRx": "05ca9da4-5ea1-4dc3-8a17-be9faa821dfb",
  "FridgeSnap": "fe281b7a-23c7-4b10-883c-997eebc841dc"
};

const CADENCES = {
  CEO: 604800,
  CMO: 86400,
  CTO: 86400,
  CFO: 604800,
  COO: 604800
};

const HEARTBEAT_PROMPTS = {
  CEO: "Conduct your weekly executive review. Check all C-Suite agent activity from the past week. Identify any critical issues, flag blockers, and set priorities for the coming week. Use exa_search if you need market context or news about our industry.",
  CMO: "Conduct your daily marketing review. Audit all marketing KPIs, check campaign performance, review SEO/AEO/GEO metrics, and identify the top 3 marketing actions needed today. Use exa_search for competitor intelligence and industry trends.",
  CTO: "Conduct your daily technical review. Check system health, audit any open GitHub issues or PRs, review QA status, assess DevOps pipeline state, and flag any technical debt or blockers. Use exa_search for relevant technology updates if needed.",
  CFO: "Conduct your weekly financial review. Audit all Stripe data, track revenue vs. projections, flag any billing anomalies, and prepare a financial summary. Escalate any variances >15% to the CEO immediately.",
  COO: "Conduct your weekly operations review. Check all operational workflows, team communications, and process efficiency. Identify any bottlenecks and coordinate with relevant C-Suite agents to resolve them."
};

function request(method, path, data = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(PAPERCLIP_URL + path);
    const options = {
      method,
      headers: { ...headers, Origin: PAPERCLIP_URL }
    };
    if (data) {
      options.headers['Content-Type'] = 'application/json';
    }

    const req = https.request(url, options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        let json;
        try { json = JSON.parse(body); } catch(e) { json = body; }
        
        let cookies = [];
        if (res.headers['set-cookie']) {
          cookies = res.headers['set-cookie'].map(c => c.split(';')[0]);
        }
        
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, data: json, cookies });
        } else {
          reject({ status: res.statusCode, data: json });
        }
      });
    });

    req.on('error', reject);
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

async function run() {
  try {
    console.log("🔐 Authenticating to Paperclip...");
    const authRes = await request('POST', '/api/auth/sign-in/email', { email: EMAIL, password: PASSWORD });
    const cookieHeader = authRes.cookies.join('; ');
    console.log("✅ Authenticated!");

    for (const [companyName, companyId] of Object.entries(COMPANIES)) {
      console.log(`\n📦 ${companyName} (${companyId})`);
      
      const agentsRes = await request('GET', `/api/companies/${companyId}/agents`, null, { Cookie: cookieHeader });
      const agents = agentsRes.data.agents || agentsRes.data;
      
      if (!agents || agents.length === 0) {
        console.warn(`  No agents found for ${companyName} - skipping`);
        continue;
      }
      
      console.log(`  Found ${agents.length} agents`);

      for (const role of ['CEO', 'CMO', 'CTO', 'CFO', 'COO']) {
        const agent = agents.find(a => a.name.includes(role));
        if (!agent) {
          console.log(`  [SKIP] No ${role} agent found in ${companyName}`);
          continue;
        }

        const cadence = CADENCES[role];
        const cadenceLabel = cadence === 86400 ? "Daily" : "Weekly";
        const body = {
          agentId: agent.id,
          type: "heartbeat",
          cadence: cadence,
          prompt: HEARTBEAT_PROMPTS[role],
          enabled: true,
          name: `${agent.name} Heartbeat`,
          title: `${role} Review`,
          description: `Automated ${role} review - ${cadenceLabel} cadence`
        };

        try {
          const routineRes = await request('POST', `/api/companies/${companyId}/routines`, body, { Cookie: cookieHeader });
          const routineId = routineRes.data.id || (routineRes.data.routine && routineRes.data.routine.id) || 'created';
          console.log(`  [OK] [${companyName}] ${role} (${cadenceLabel} heartbeat) -> routine ID: ${routineId}`);
        } catch (err) {
          if (err.status === 409) {
            console.log(`  [SKIP] [${companyName}] ${role} heartbeat already exists`);
          } else {
            console.error(`  [ERR] [${companyName}] ${role} heartbeat failed (HTTP ${err.status}):\n${JSON.stringify(err.data, null, 2)}`);
          }
        }
      }
    }
    
    console.log("\n✅ Heartbeat restoration complete!");
  } catch (err) {
    console.error("❌ Fatal error:", err);
  }
}

run();
