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
 * The default company for Hub-created issues. This is the SAME company as
 * RXFIT_COMPANY_ID — RxFit Enterprise — because that is where the CEO agent
 * (RXFIT_CEO_AGENT_ID) actually lives and the only RxFit company the Hub's
 * board user can access.
 *
 * FIXED 2026-07-19 (live-instance audit): this previously pointed at
 * 8f2acc3d-f2dc-4f8c-897e-7c400e91fd85, a phantom "CEO sibling company" that
 * the board user gets 403 on and where the CEO agent does NOT live. Assigning
 * the CEO agent to an issue in that company is a cross-company error, so the
 * issue-creation fallback (app/api/paperclip/issues/route.ts) 403'd whenever
 * DEFAULT_PAPERCLIP_COMPANY_ID was unset. There is one RxFit company, not two.
 */
export const RXFIT_CEO_COMPANY_ID = RXFIT_COMPANY_ID

/**
 * CEO — the default assignee for Hub-created issues when no agent match is
 * found. Officer agents (COO/CTO/CMO/CFO) are resolved BY NAME at runtime via
 * classifyAgentRole (lib/agentRoles.ts) — their previously hardcoded UUIDs
 * had zero consumers and were removed (2026-07-19 cleanup).
 */
export const RXFIT_CEO_AGENT_ID = isLocal ? 'a26e5555-2ce0-4eda-a5d3-fb4a15109612' : '82984f59-633e-4cdf-b8a1-d0499f6c226a'

