/**
 * Centralized Paperclip configuration.
 * All Paperclip-related constants live here — no hardcoded URLs or IDs in route files.
 *
 * RxFit Org: https://rxfit-paperclip-11747747730.us-central1.run.app
 * Local dev:  http://127.0.0.1:3100
 *
 * IDs updated 2026-06-04 from live Cloud Run audit by Antigravity.
 */

export const PAPERCLIP_BASE_URL =
  process.env.PAPERCLIP_BASE_URL || 'https://rxfit-paperclip-11747747730.us-central1.run.app'

const isLocal = PAPERCLIP_BASE_URL.includes('127.0.0.1') || PAPERCLIP_BASE_URL.includes('localhost')

/* ── RxFit AI Org — canonical IDs (Cloud Run) vs Local (HUB Overlay) ── */
/**
 * The unified RxFit Enterprise org in Paperclip.
 * All C-Suite agents (CEO, CMO, CTO, CFO, COO) live here.
 */
export const RXFIT_COMPANY_ID = isLocal ? '05787964-7240-4851-b7df-d006f0d8001c' : '829b2493-97ed-4cb9-8775-ff8298dcf650'

/**
 * The CEO's default company. NOTE: this is a SIBLING Paperclip company to
 * RXFIT_COMPANY_ID — Paperclip companies are mutually isolated with no
 * cross-company delegation; there is no "triage then delegate to officer
 * workspaces" routing (verified against the live instance, 2026-06 audit
 * P1-3). It exists only as the default landing company for Hub-created
 * issues when no workspace is selected.
 */
export const RXFIT_CEO_COMPANY_ID = isLocal ? '05787964-7240-4851-b7df-d006f0d8001c' : '8f2acc3d-f2dc-4f8c-897e-7c400e91fd85'

/**
 * CEO — the default assignee for Hub-created issues when no agent match is
 * found. Officer agents (COO/CTO/CMO/CFO) are resolved BY NAME at runtime via
 * classifyAgentRole (lib/agentRoles.ts) — their previously hardcoded UUIDs
 * had zero consumers and were removed (2026-07-19 cleanup).
 */
export const RXFIT_CEO_AGENT_ID = isLocal ? 'a26e5555-2ce0-4eda-a5d3-fb4a15109612' : '82984f59-633e-4cdf-b8a1-d0499f6c226a'

