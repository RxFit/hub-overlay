/**
 * bootstrap-project.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Injects initialization prompts into all 3 Paperclip workspaces for a given
 * project using the `paperclipai issue create` CLI — no running local server
 * required, works with any API base URL (localhost, Docker, tunnel).
 *
 * Cerberus Mandate: environment-agnostic, all credentials via env vars.
 * RxHarden Mandate: exits with clear error if any credential is unset/placeholder.
 *
 * Usage:
 *   node orchestration/scripts/bootstrap-project.js --project RxFit
 *   node orchestration/scripts/bootstrap-project.js --project WellnessApp
 *   node orchestration/scripts/bootstrap-project.js --project FridgeSnap
 *   node orchestration/scripts/bootstrap-project.js --project RxFit-SEO-Agent
 *   node orchestration/scripts/bootstrap-project.js --project JadeCoS
 *   node orchestration/scripts/bootstrap-project.js --project NotebookRx
 *
 * Flags:
 *   --project <name>     Required. Matches a folder in orchestration/
 *   --dry-run            Print CLI commands without executing them
 *   --workspace <name>   Run only one workspace: marketing | technical | revenue
 */

import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import path from 'path';
import os from 'os';
import { loadEnv, validateEnv } from './create-issue.js';

// ─── Parse CLI args ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (flag) => {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : null;
};
const hasFlag = (flag) => args.includes(flag);

const PROJECT      = getArg('--project');
const DRY_RUN      = hasFlag('--dry-run');
const ONLY_WORKSPACE = getArg('--workspace');

if (!PROJECT) {
  console.error('❌ --project is required. Example: node bootstrap-project.js --project RxFit');
  process.exit(1);
}

// ─── Resolve paths ───────────────────────────────────────────────────────────
const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const ORCHESTRATION_DIR = path.resolve(__dirname, '..');
const PROJECT_DIR  = path.join(ORCHESTRATION_DIR, PROJECT);

if (!existsSync(PROJECT_DIR)) {
  console.error(`❌ Project folder not found: ${PROJECT_DIR}`);
  process.exit(1);
}

// ─── Load environment ────────────────────────────────────────────────────────
loadEnv(PROJECT_DIR);
validateEnv(['PAPERCLIP_BASE_URL', 'PAPERCLIP_API_KEY']);

const BASE_URL = process.env.PAPERCLIP_BASE_URL;
const API_KEY  = process.env.PAPERCLIP_API_KEY;

// ─── Workspace definitions ───────────────────────────────────────────────────
const workspaces = [
  {
    key: 'marketing',
    label: `${PROJECT} - Marketing`,
    companyIdVar: 'PAPERCLIP_COMPANY_ID_MARKETING',
    agentIdVar: 'PAPERCLIP_AGENT_ID_CMO',
    initFilePaths: [
      path.join(PROJECT_DIR, 'agents', 'cmo', 'INIT.md'),
      path.join(PROJECT_DIR, 'agents', 'cmo', 'INIT_MARKETING.md'),
      path.join(PROJECT_DIR, 'agents', 'marketing', 'INIT.md'),
      path.join(PROJECT_DIR, 'agents', 'marketing', 'INIT_MARKETING.md'),
    ],
  },
  {
    key: 'technical',
    label: `${PROJECT} - Technical`,
    companyIdVar: 'PAPERCLIP_COMPANY_ID_TECHNICAL',
    agentIdVar: 'PAPERCLIP_AGENT_ID_CTO',
    initFilePaths: [
      path.join(PROJECT_DIR, 'agents', 'cto', 'INIT.md'),
      path.join(PROJECT_DIR, 'agents', 'cto', 'INIT_TECHNICAL.md'),
      path.join(PROJECT_DIR, 'agents', 'technical', 'INIT.md'),
      path.join(PROJECT_DIR, 'agents', 'technical', 'INIT_TECHNICAL.md'),
    ],
  },
  {
    key: 'revenue',
    label: `${PROJECT} - Revenue`,
    companyIdVar: 'PAPERCLIP_COMPANY_ID_REVENUE',
    agentIdVar: 'PAPERCLIP_AGENT_ID_CFO',
    initFilePaths: [
      path.join(PROJECT_DIR, 'agents', 'cfo', 'INIT.md'),
      path.join(PROJECT_DIR, 'agents', 'cfo', 'INIT_REVENUE.md'),
      path.join(PROJECT_DIR, 'agents', 'revenue', 'INIT.md'),
      path.join(PROJECT_DIR, 'agents', 'revenue', 'INIT_REVENUE.md'),
    ],
  },
];

// ─── Helper: read first matching INIT file ────────────────────────────────────
function readInitContent(filePaths, label) {
  for (const fp of filePaths) {
    if (existsSync(fp)) {
      console.log(`  📄 Found INIT file: ${path.relative(ORCHESTRATION_DIR, fp)}`);
      return readFileSync(fp, 'utf8');
    }
  }
  console.error(`  ❌ No INIT file found for ${label}. Checked:`);
  for (const fp of filePaths) console.error(`     ${fp}`);
  return null;
}

// ─── Run paperclipai CLI command ─────────────────────────────────────────────
function runCliCreate({ companyId, title, description, agentId, dryRun }) {
  // Write description to a temp file to avoid CLI arg length limits
  const tmpFile = path.join(os.tmpdir(), `pcp-init-${Date.now()}.md`);
  writeFileSync(tmpFile, description, 'utf8');

  const cliArgs = [
    'paperclipai', 'issue', 'create',
    '--api-base', BASE_URL,
    '--api-key',  API_KEY,
    '--company-id', companyId,
    '--title', title,
    '--description', description,
    '--json',
  ];

  if (agentId) cliArgs.push('--assignee-agent-id', agentId);

  if (dryRun) {
    // Mask the API key in output
    const displayArgs = cliArgs.map((a, i) =>
      cliArgs[i - 1] === '--api-key' ? 'sk_pc_***' : a
    );
    console.log(`\n[DRY RUN] Would run:\n  npx ${displayArgs.join(' ')}`);
    unlinkSync(tmpFile);
    return { dryRun: true };
  }

  try {
    // On Windows, npx is a .ps1 wrapper that can't be called via execFileSync directly.
    // Use cmd.exe /c to resolve it correctly.
    const isWindows = process.platform === 'win32';
    const result = isWindows
      ? execFileSync('cmd.exe', ['/c', 'npx', ...cliArgs], {
          encoding: 'utf8',
          timeout: 30000,
          windowsHide: true,
        })
      : execFileSync('npx', cliArgs, {
          encoding: 'utf8',
          timeout: 30000,
        });
    unlinkSync(tmpFile);
    try {
      return JSON.parse(result);
    } catch {
      return { raw: result.trim() };
    }
  } catch (err) {
    unlinkSync(tmpFile);
    throw new Error(err.stderr || err.message);
  }
}

// ─── Duplicate guard via CLI list ─────────────────────────────────────────────
function checkAlreadyBootstrapped(companyId, issueTitle) {
  try {
    const isWindows = process.platform === 'win32';
    const listArgs = [
      'paperclipai', 'issue', 'list',
      '--api-base', BASE_URL,
      '--api-key',  API_KEY,
      '--company-id', companyId,
      '--json',
    ];
    const result = isWindows
      ? execFileSync('cmd.exe', ['/c', 'npx', ...listArgs], { encoding: 'utf8', timeout: 15000, windowsHide: true })
      : execFileSync('npx', listArgs, { encoding: 'utf8', timeout: 15000 });

    const data = JSON.parse(result);
    const issues = Array.isArray(data) ? data : (data.issues || data.data || []);
    return issues.some(i => i.title === issueTitle);
  } catch {
    return false; // fail open
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
console.log(`\n🚀 Paperclip Bootstrap — Project: ${PROJECT}`);
console.log(`   Base URL: ${BASE_URL}`);
console.log(`   Mode: ${DRY_RUN ? '⚠️  DRY RUN (no API calls)' : '🔴 LIVE'}`);
if (ONLY_WORKSPACE) console.log(`   Filter: ${ONLY_WORKSPACE} workspace only\n`);

let successCount = 0;
let skipCount = 0;
let failCount = 0;

for (const ws of workspaces) {
  if (ONLY_WORKSPACE && ws.key !== ONLY_WORKSPACE) continue;

  console.log(`\n─── ${ws.label} ──────────────────────────────────`);

  // RxHarden: company ID must be populated
  const companyId = process.env[ws.companyIdVar];
  if (!companyId || companyId === 'FILL_ME_IN') {
    console.error(`  ❌ ${ws.companyIdVar} is not set. Fill in ${PROJECT}/.env and retry.`);
    failCount++;
    continue;
  }

  // Agent ID is optional
  const agentId = process.env[ws.agentIdVar];
  if (!agentId || agentId === 'FILL_ME_IN') {
    console.warn(`  ⚠️  ${ws.agentIdVar} not set — issue will post to workspace inbox.`);
  }

  // Read INIT content
  const body = readInitContent(ws.initFilePaths, ws.label);
  if (!body) { failCount++; continue; }

  const issueTitle = `[INIT] ${ws.label} — Agent Bootstrap`;

  // Duplicate guard (skip in dry-run)
  if (!DRY_RUN) {
    const alreadyDone = checkAlreadyBootstrapped(companyId, issueTitle);
    if (alreadyDone) {
      console.log(`  ✅ Already bootstrapped — skipping.`);
      skipCount++;
      continue;
    }
  }

  try {
    const result = runCliCreate({
      companyId,
      title: issueTitle,
      description: body,
      agentId: (!agentId || agentId === 'FILL_ME_IN') ? undefined : agentId,
      dryRun: DRY_RUN,
    });

    if (DRY_RUN) {
      console.log(`  ✅ Dry run OK`);
    } else {
      const id = result.id || result._id || result.identifier || JSON.stringify(result).slice(0, 60);
      console.log(`  ✅ Issue created: ${id}`);
    }
    successCount++;
  } catch (err) {
    console.error(`  ❌ Failed: ${err.message}`);
    failCount++;
  }
}

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(55)}`);
console.log(`Bootstrap complete — ${PROJECT}`);
console.log(`  ✅ Success:  ${successCount}`);
console.log(`  ⏭️  Skipped: ${skipCount}`);
console.log(`  ❌ Failed:  ${failCount}`);

if (failCount > 0) {
  console.log('\nResolve failures above, then re-run. Already-bootstrapped workspaces will be skipped.');
  process.exit(1);
}
