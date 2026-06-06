/**
 * bootstrap-hub.js
 * Bootstraps the HUB Overlay workspace agents with their respective INIT prompts.
 * Uses the paperclipai CLI to create issues.
 */

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import path from 'path';
import { loadEnv, validateEnv } from './create-issue.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, '../HUB');

// Load environment variables
loadEnv(PROJECT_DIR);
validateEnv([
  'PAPERCLIP_BASE_URL',
  'PAPERCLIP_API_KEY',
  'PAPERCLIP_COMPANY_ID',
  'PAPERCLIP_AGENT_ID_CEO',
  'PAPERCLIP_AGENT_ID_COO',
  'PAPERCLIP_AGENT_ID_CTO'
]);

const BASE_URL = process.env.PAPERCLIP_BASE_URL;
const API_KEY = process.env.PAPERCLIP_API_KEY;
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID;

const agents = [
  {
    key: 'ceo',
    name: 'CEO',
    id: process.env.PAPERCLIP_AGENT_ID_CEO,
    initFile: path.join(PROJECT_DIR, 'agents/ceo/INIT.md'),
    title: '[CEO] HUB Overlay CEO Initialization'
  },
  {
    key: 'coo',
    name: 'COO',
    id: process.env.PAPERCLIP_AGENT_ID_COO,
    initFile: path.join(PROJECT_DIR, 'agents/coo/INIT.md'),
    title: '[COO] HUB Overlay COO Initialization'
  },
  {
    key: 'cto',
    name: 'CTO',
    id: process.env.PAPERCLIP_AGENT_ID_CTO,
    initFile: path.join(PROJECT_DIR, 'agents/cto/INIT.md'),
    title: '[CTO] HUB Overlay CTO Initialization'
  }
];

function checkAlreadyBootstrapped(title) {
  try {
    const listArgs = [
      'paperclipai', 'issue', 'list',
      '--api-base', BASE_URL,
      '--api-key',  API_KEY,
      '--company-id', COMPANY_ID,
      '--json'
    ];
    const isWindows = process.platform === 'win32';
    const result = isWindows
      ? execFileSync('cmd.exe', ['/c', 'npx', ...listArgs], { encoding: 'utf8', timeout: 15000, windowsHide: true })
      : execFileSync('npx', listArgs, { encoding: 'utf8', timeout: 15000 });

    const data = JSON.parse(result);
    const issues = Array.isArray(data) ? data : (data.issues || data.data || []);
    return issues.some(i => i.title === title);
  } catch {
    return false;
  }
}

function runCliCreate({ companyId, title, description, agentId }) {
  const cliArgs = [
    'paperclipai', 'issue', 'create',
    '--api-base', BASE_URL,
    '--api-key',  API_KEY,
    '--company-id', companyId,
    '--title', title,
    '--description', description,
    '--json'
  ];

  if (agentId) {
    cliArgs.push('--assignee-agent-id', agentId);
  }

  const isWindows = process.platform === 'win32';
  const result = isWindows
    ? execFileSync('cmd.exe', ['/c', 'npx', ...cliArgs], { encoding: 'utf8', timeout: 30000, windowsHide: true })
    : execFileSync('npx', cliArgs, { encoding: 'utf8', timeout: 30000 });

  return JSON.parse(result);
}

async function run() {
  console.log('🚀 Bootstrapping HUB Overlay Workspace Agents using CLI...');
  console.log(`   Base URL: ${BASE_URL}`);
  console.log(`   Company ID: ${COMPANY_ID}\n`);

  for (const agent of agents) {
    console.log(`--- Bootstrapping ${agent.name} Agent ---`);
    if (!existsSync(agent.initFile)) {
      console.error(`❌ INIT file not found: ${agent.initFile}`);
      continue;
    }

    const alreadyDone = checkAlreadyBootstrapped(agent.title);
    if (alreadyDone) {
      console.log(`⏭️  Already bootstrapped ${agent.name} (issue exists). Skipping.`);
      continue;
    }

    const description = readFileSync(agent.initFile, 'utf8');
    try {
      const result = runCliCreate({
        companyId: COMPANY_ID,
        title: agent.title,
        description,
        agentId: agent.id
      });
      console.log(`✅ Successfully bootstrapped ${agent.name}. Issue ID: ${result.id}`);
    } catch (err) {
      console.error(`❌ Failed to bootstrap ${agent.name}: ${err.message}`);
    }
  }

  console.log('\n🎉 HUB Overlay bootstrap process complete!');
}

run().catch(err => {
  console.error('Fatal error during bootstrap:', err);
  process.exit(1);
});
