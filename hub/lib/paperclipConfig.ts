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

/* ── RxFit AI Org — canonical IDs (Cloud Run) ── */
/** The single RxFit company workspace in Paperclip. All issues route here. */
export const RXFIT_COMPANY_ID = '829b2493-97ed-4cb9-8775-ff8298dcf650'

/** CEO — receives all inbound issues as orchestrator. */
export const RXFIT_CEO_AGENT_ID = '82984f59-633e-4cdf-b8a1-d0499f6c226a'

/** COO — handles Austin operations, client comms, onboarding. */
export const RXFIT_COO_AGENT_ID = '002a8e1c-9206-46a2-bf6e-4ffb46cbb254'

/** CTO — platform, infrastructure, tech. */
export const RXFIT_CTO_AGENT_ID = '91873c35-2586-4623-bb78-23627d3c5ca9'

/** CMO — growth, marketing, leads. */
export const RXFIT_CMO_AGENT_ID = '360e4642-135a-493d-b500-a532d23b3714'

/** CFO — revenue, finance, MRR. */
export const RXFIT_CFO_AGENT_ID = '4f4548b7-9f7d-458b-b4ec-3b373a0fff57'

