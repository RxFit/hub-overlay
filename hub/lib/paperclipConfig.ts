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
 * CEO's personal workspace — inbound tasks from the Hub route here first.
 * The CEO agent triages and delegates to officer workspaces.
 */
export const RXFIT_CEO_COMPANY_ID = isLocal ? '05787964-7240-4851-b7df-d006f0d8001c' : '8f2acc3d-f2dc-4f8c-897e-7c400e91fd85'

/** CEO — receives all inbound issues as orchestrator. */
export const RXFIT_CEO_AGENT_ID = isLocal ? 'a26e5555-2ce0-4eda-a5d3-fb4a15109612' : '82984f59-633e-4cdf-b8a1-d0499f6c226a'

/** COO — handles Austin operations, client comms, onboarding. */
export const RXFIT_COO_AGENT_ID = isLocal ? 'c56e5206-5d54-4fe8-95ea-6e5669a7333e' : '002a8e1c-9206-46a2-bf6e-4ffb46cbb254'

/** CTO — platform, infrastructure, tech. */
export const RXFIT_CTO_AGENT_ID = isLocal ? '9eeb28d1-b8b2-4904-8486-39d8c77da86b' : '91873c35-2586-4623-bb78-23627d3c5ca9'

/** CMO — growth, marketing, leads. */
export const RXFIT_CMO_AGENT_ID = isLocal ? '' : '360e4642-135a-493d-b500-a532d23b3714'

/** CFO — revenue, finance, MRR. */
export const RXFIT_CFO_AGENT_ID = isLocal ? '' : '4f4548b7-9f7d-458b-b4ec-3b373a0fff57'

