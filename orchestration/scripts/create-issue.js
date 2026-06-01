/**
 * create-issue.js
 * Reusable helper: POST a single issue to a Paperclip workspace via REST API.
 * Cerberus Mandate: credentials sourced from env vars only, never hardcoded.
 *
 * Usage (module):
 *   import { createIssue } from './create-issue.js';
 *   await createIssue({ companyId, title, body, agentId, dryRun });
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

/**
 * Load .env files manually (no external deps — plain parsing only).
 * Loads shared orchestration/.env first, then project-scoped .env.
 */
export function loadEnv(projectDir) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const orchestrationDir = path.resolve(__dirname, '..');

  // Load order: project .env FIRST (wins), shared .env SECOND (fallback).
  // Each Paperclip instance has its own port + API key, so project values must
  // take priority over any shared defaults.
  const envFiles = [
    path.join(projectDir, '.env'),                 // project-specific (highest priority)
    path.join(orchestrationDir, '.env'),           // shared fallback
  ];

  // First pass: collect all values with project taking priority
  const collected = {};
  for (const envFile of envFiles) {
    try {
      const lines = readFileSync(envFile, 'utf8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (!(key in collected)) collected[key] = val; // first file wins
      }
    } catch {
      // File missing is non-fatal — warn only
      console.warn(`[create-issue] Warning: env file not found: ${envFile}`);
    }
  }

  // Apply to process.env (don't override shell-level env vars)
  for (const [key, val] of Object.entries(collected)) {
    if (!process.env[key]) process.env[key] = val;
  }
}

/**
 * Validate required env vars are set and not placeholder values.
 */
export function validateEnv(required) {
  const FILL_ME_IN = 'FILL_ME_IN';
  const missing = [];
  for (const key of required) {
    const val = process.env[key];
    if (!val || val === FILL_ME_IN) missing.push(key);
  }
  if (missing.length > 0) {
    console.error('❌ RxHarden check FAILED — missing or unfilled env vars:');
    for (const key of missing) console.error(`   ${key}`);
    console.error('Fill in orchestration/.env and/or the project .env file, then retry.');
    process.exit(1);
  }
}

/**
 * POST /api/issues to create a new Paperclip issue/task.
 *
 * @param {object} opts
 * @param {string} opts.baseUrl      - Paperclip instance URL
 * @param {string} opts.apiKey       - Board API Key
 * @param {string} opts.companyId    - Paperclip company UUID for the workspace
 * @param {string} opts.title        - Issue title
 * @param {string} opts.body         - Issue body (the initialization prompt)
 * @param {string} [opts.agentId]    - Optional: assign directly to agent UUID
 * @param {boolean} [opts.dryRun]    - If true, print payload but do not POST
 * @returns {Promise<object>}        - Created issue object
 */
export async function createIssue({ baseUrl, apiKey, companyId, title, body, agentId, dryRun = false }) {
  const url = `${baseUrl}/api/issues`;

  const payload = {
    companyId,
    title,
    body,
    ...(agentId ? { assigneeId: agentId } : {}),
  };

  if (dryRun) {
    console.log('\n[DRY RUN] Would POST to:', url);
    console.log('[DRY RUN] Payload:', JSON.stringify(payload, null, 2));
    return { dryRun: true, payload };
  }

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status}: ${text}`);
      }

      const data = await response.json();
      return data;
    } catch (err) {
      lastError = err;
      if (attempt < 3) {
        console.warn(`  [attempt ${attempt}/3] failed: ${err.message} — retrying in 2s...`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  throw new Error(`createIssue failed after 3 attempts: ${lastError.message}`);
}
