/**
 * Centralized Paperclip configuration.
 * All Paperclip-related constants live here — no hardcoded URLs or IDs in route files.
 *
 * RxFit Org: https://rxfit-paperclip-11747747730.us-central1.run.app
 * Local dev:  http://127.0.0.1:3100
 */

export const PAPERCLIP_BASE_URL =
  process.env.PAPERCLIP_BASE_URL || 'https://rxfit-paperclip-11747747730.us-central1.run.app'

/* ── RxFit AI Org — canonical IDs ── */
/** The single RxFit company workspace in Paperclip. All issues route here. */
export const RXFIT_COMPANY_ID = '406f1235-9de9-4e58-8388-9e6a4a32c227'

/** CEO 2 — receives all inbound issues as orchestrator. */
export const RXFIT_CEO_AGENT_ID = '2f515236-8b0c-4de4-b598-5f885d96a837'

/** COO (General) — handles Austin operations, client comms, onboarding. */
export const RXFIT_COO_AGENT_ID = '81b229dc-b383-4916-a783-38e252097412'

/** CTO — platform, infrastructure, tech. */
export const RXFIT_CTO_AGENT_ID = '62a78441-97ff-4795-91d8-7bcaf778ef74'

/** CMO — growth, marketing, leads. */
export const RXFIT_CMO_AGENT_ID = 'b5d6a9e5-c991-449a-8639-d5895b6b1dc4'

/** CFO — revenue, finance, MRR. */
export const RXFIT_CFO_AGENT_ID = '871c1cd8-0c4a-4fef-89cd-d11f9afcad81'
