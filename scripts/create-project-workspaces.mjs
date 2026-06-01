import fs from 'fs';
import path from 'path';

const email = "Danny@rxfitatx.com";
const password = "Paperclip2026!";
const baseUrl = "https://rxfit-paperclip-11747747730.us-central1.run.app";

const EXA_ENV_PATH = "C:\\Users\\danie\\OneDrive\\HQ Desktop\\Master .ENV\\exa.env";
const GITHUB_ENV_PATH = "C:\\Users\\danie\\OneDrive\\HQ Desktop\\Master .ENV\\Github.env";
const RXFIT_ENV_PATH = "C:\\Users\\danie\\OneDrive\\HQ Desktop\\RxFit Command Center\\.env";
const MASTER_ENV_PATH = "C:\\Users\\danie\\OneDrive\\HQ Desktop\\Master .ENV\\.env";

// Templates for seeding agents
const AGENT_TEMPLATES = [
  {
    role: 'ceo',
    name: (companyName) => `${companyName} CEO`,
    canCreateAgents: true,
    instructions: (companyName) => `You are the CEO of ${companyName}. You are the primary orchestrator for this company within Paperclip. You receive issues, delegate to your C-Suite, and ensure all company objectives are met. Always assign new issues to the most relevant C-Suite agent after reviewing them. Escalate to the board (Danny Trejo / Antigravity) only for: external communications, budget decisions over $500, and strategic pivots.`,
    reportingRole: null,
  },
  {
    role: 'cmo',
    name: (companyName) => `${companyName} CMO`,
    canCreateAgents: false,
    instructions: (companyName) => `You are the Chief Marketing Officer of ${companyName}. You own all marketing, growth, brand, and customer acquisition initiatives. Report to the CEO. Use web research (exa_search) for competitor intelligence and market trends. Your weekly heartbeat: audit all marketing KPIs and surface the top 3 actions needed.`,
    reportingRole: 'ceo',
  },
  {
    role: 'cto',
    name: (companyName) => `${companyName} CTO`,
    canCreateAgents: false,
    instructions: (companyName) => `You are the Chief Technology Officer of ${companyName}. You own all technical architecture, engineering quality, DevOps, and security. Report to the CEO. Your daily heartbeat: check system health, audit open GitHub issues/PRs, and flag any technical blockers. Use exa_search for relevant technology updates.`,
    reportingRole: 'ceo',
  },
  {
    role: 'cfo',
    name: (companyName) => `${companyName} CFO`,
    canCreateAgents: false,
    instructions: (companyName) => `You are the Chief Financial Officer of ${companyName}. You own all financial tracking, revenue analysis, and billing oversight. Report to the CEO. Your weekly heartbeat: audit Stripe data, track revenue vs. projections, flag variances >15%. Never execute charges — prepare for human (Danny) approval.`,
    reportingRole: 'ceo',
  },
  {
    role: 'general', // COO is mapped to general since 'coo' isn't in Paperclip schema role options
    roleLabel: 'COO',
    name: (companyName) => `${companyName} COO`,
    canCreateAgents: false,
    instructions: (companyName) => `You are the Chief Operating Officer of ${companyName}. You own operational workflows, team coordination, and process efficiency. Report to the CEO. Route all external-facing communications through Antigravity (board) before sending. Your weekly heartbeat: check all operational workflows and identify bottlenecks.`,
    reportingRole: 'ceo',
  },
];

// Heartbeat configs
const CADENCES = { ceo: 604800, cmo: 86400, cto: 86400, cfo: 604800, general: 604800 };
const PROMPTS = {
  ceo: "Conduct your weekly executive review. Check all C-Suite agent activity from the past week. Identify critical issues, flag blockers, and set priorities. Use exa_search for market context and industry news.",
  cmo: "Conduct your daily marketing review. Audit all marketing KPIs, campaign performance, and SEO metrics. Identify the top 3 marketing actions needed today. Use exa_search for competitor intelligence.",
  cto: "Conduct your daily technical review. Check system health, audit open GitHub issues/PRs, review QA and DevOps status. Flag any technical debt or blockers. Use exa_search for technology updates.",
  cfo: "Conduct your weekly financial review. Audit Stripe data, track revenue vs projections, flag anomalies over 15% variance. Escalate critical issues to the CEO immediately.",
  general: "Conduct your weekly operations review. Check all operational workflows, team communications, and process efficiency. Coordinate with C-Suite to resolve bottlenecks."
};

function readEnv(filePath) {
  const result = {};
  if (!fs.existsSync(filePath)) return result;
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const parts = trimmed.split('=');
      if (parts.length >= 2) {
        const key = parts[0].trim();
        const value = parts.slice(1).join('=').trim().replace(/^['"]|['"]$/g, '');
        result[key] = value;
      }
    }
  }
  return result;
}

async function main() {
  // Load secrets
  console.log("Loading local secrets...");
  const exaEnv = readEnv(EXA_ENV_PATH);
  const githubEnv = readEnv(GITHUB_ENV_PATH);
  const rxfitEnv = readEnv(RXFIT_ENV_PATH);
  const masterEnv = readEnv(MASTER_ENV_PATH);

  const secrets = {
    EXA_API_KEY: exaEnv.EXA_API_KEY || exaEnv.EXA_KEY || masterEnv.EXA_API_KEY,
    GITHUB_TOKEN: githubEnv.GITHUB_TOKEN || githubEnv.NOTEBOOKRX_GITHUB_TOKEN || masterEnv.GITHUB_TOKEN,
    STRIPE_API_KEY: rxfitEnv.STRIPE_SECRET_KEY || masterEnv.STRIPE_SECRET_KEY,
    GOOGLE_CHAT_WEBHOOK: masterEnv.GOOGLE_CHAT_WEBHOOK_URL || rxfitEnv.GOOGLE_CHAT_WEBHOOK_URL
  };

  console.log("Secrets loaded:", {
    EXA_API_KEY: secrets.EXA_API_KEY ? "PRESENT" : "MISSING",
    GITHUB_TOKEN: secrets.GITHUB_TOKEN ? "PRESENT" : "MISSING",
    STRIPE_API_KEY: secrets.STRIPE_API_KEY ? "PRESENT" : "MISSING",
    GOOGLE_CHAT_WEBHOOK: secrets.GOOGLE_CHAT_WEBHOOK ? "PRESENT" : "MISSING"
  });

  // Authenticate
  console.log("Authenticating to Paperclip...");
  const authRes = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': baseUrl
    },
    body: JSON.stringify({ email, password })
  });

  if (!authRes.ok) {
    throw new Error(`Auth failed: ${authRes.status} ${await authRes.text()}`);
  }
  const cookie = authRes.headers.get('set-cookie');
  console.log("Authenticated successfully!");

  const projectsToCreate = [
    { name: "Jade CoS", prefix: "JAD", description: "Jade Chief of Staff workspace" },
    { name: "SEO Agent", prefix: "SEO", description: "RxFit SEO Agent workspace" },
    { name: "Wellness App", prefix: "WEL", description: "RxFit Wellness App workspace" }
  ];

  for (const proj of projectsToCreate) {
    console.log(`\n=================== Creating ${proj.name} ===================`);
    
    // Check if company already exists
    let company;
    const listRes = await fetch(`${baseUrl}/api/companies`, {
      headers: { 'cookie': cookie, 'Origin': baseUrl }
    });
    if (listRes.ok) {
      const listData = await listRes.json();
      const existing = (listData.companies || listData).find(c => c.name === proj.name || c.issuePrefix === proj.prefix);
      if (existing) {
        company = existing;
        console.log(`Company already exists: ${company.name} (ID: ${company.id})`);
      }
    }

    if (!company) {
      // 1. Create Company
      const compRes = await fetch(`${baseUrl}/api/companies`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'cookie': cookie,
          'Origin': baseUrl
        },
        body: JSON.stringify({
          name: proj.name,
          identifier: proj.prefix,
          description: proj.description
        })
      });

      if (!compRes.ok) {
        console.error(`Failed to create company ${proj.name}:`, compRes.status, await compRes.text());
        continue;
      }
      const compData = await compRes.json();
      company = compData.company || compData;
      console.log(`Created Company: ${company.name} (ID: ${company.id})`);
    }

    // 2. Inject Secrets
    console.log("Injecting secrets...");
    for (const [key, value] of Object.entries(secrets)) {
      if (!value) continue;
      const secRes = await fetch(`${baseUrl}/api/companies/${company.id}/secrets`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'cookie': cookie,
          'Origin': baseUrl
        },
        body: JSON.stringify({ name: key, value })
      });
      if (secRes.ok || secRes.status === 409) {
        console.log(`  Secret ${key} injected`);
      } else {
        console.warn(`  Failed to inject secret ${key}:`, secRes.status, await secRes.text());
      }
    }

    // 3. Seed Agents
    console.log("Seeding agents...");
    const createdAgents = {}; // roleLabel/role -> id

    // Fetch existing agents to avoid duplicate seeding
    const existingAgentsRes = await fetch(`${baseUrl}/api/companies/${company.id}/agents`, {
      headers: { 'cookie': cookie, 'Origin': baseUrl }
    });
    const existingAgentsList = existingAgentsRes.ok ? (await existingAgentsRes.json()).agents || [] : [];
    const existingAgentsMap = {};
    for (const a of existingAgentsList) {
      existingAgentsMap[a.role] = a.id;
    }

    for (const template of AGENT_TEMPLATES) {
      const roleLabel = template.roleLabel || template.role.toUpperCase();
      const existingAgentId = existingAgentsMap[template.role];
      if (existingAgentId) {
        createdAgents[roleLabel] = existingAgentId;
        console.log(`  Agent ${roleLabel} already exists (ID: ${existingAgentId})`);
        continue;
      }

      const reportsTo = template.reportingRole ? createdAgents[template.reportingRole.toUpperCase()] : null;
      
      const agentRes = await fetch(`${baseUrl}/api/companies/${company.id}/agents`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'cookie': cookie,
          'Origin': baseUrl
        },
        body: JSON.stringify({
          name: template.name(proj.name),
          role: template.role,
          instructions: template.instructions(proj.name),
          canCreateAgents: template.canCreateAgents,
          adapterType: 'gemini_cli',
          adapterConfig: {
            baseUrl: 'https://rxfit-llm-proxy-6r2wdzwkoq-uc.a.run.app'
          },
          reportsTo
        })
      });

      if (!agentRes.ok) {
        console.error(`  Failed to create agent ${roleLabel}:`, agentRes.status, await agentRes.text());
        continue;
      }
      const agentData = await agentRes.json();
      const agent = agentData.agent || agentData;
      createdAgents[roleLabel] = agent.id;
      console.log(`  Agent ${roleLabel} created (ID: ${agent.id})`);

      // 4. Create Heartbeat routine for this agent
      const cadence = CADENCES[template.role];
      const prompt = PROMPTS[template.role];
      if (cadence && prompt) {
        const routineRes = await fetch(`${baseUrl}/api/companies/${company.id}/routines`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'cookie': cookie,
            'Origin': baseUrl
          },
          body: JSON.stringify({
            agentId: agent.id,
            type: 'heartbeat',
            cadence,
            prompt,
            enabled: true,
            name: `${agent.name} Heartbeat`
          })
        });

        if (routineRes.ok || routineRes.status === 409) {
          console.log(`    Heartbeat routine created`);
        } else {
          console.warn(`    Failed to create heartbeat routine:`, routineRes.status, await routineRes.text());
        }
      }
    }

    console.log(`Finished ${proj.name} successfully!`);
    console.log("JSON mapping of created agents:");
    console.log(JSON.stringify({
      companyId: company.id,
      agents: createdAgents
    }, null, 2));
  }
}

main().catch(console.error);
