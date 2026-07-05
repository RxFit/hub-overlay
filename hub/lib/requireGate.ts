/**
 * Server-verified gate for AI-originated sends (P0-2 completion, Option B).
 *
 * The Paperclip proxy already verifies the HMAC-signed quality-gate token on
 * high-stakes issue creation. The AI's direct Google sends (send_gmail /
 * post_chat_message) previously had no server-side check — the interview,
 * Pre-Cog validation, and Approve click were browser-only for those routes.
 *
 * This helper closes that gap without touching manual sends:
 *
 *  - AI-originated requests carry `X-AI-Intent` (executeAction is the only AI
 *    send pathway and always attaches it, failing fast without a token).
 *  - Manual composer sends carry no AI marker, so the gate does not apply and
 *    an authenticated human keeps composing exactly as before.
 *  - When the marker IS present, the request must also carry a valid,
 *    unexpired, above-threshold `X-Gate-Token` whose signed intent matches
 *    the declared intent — anything else fails closed with a 403.
 */
import { verifyGateToken } from '@/lib/gateToken'

/** Header marking a request as AI-originated, carrying the declared intent. */
export const AI_INTENT_HEADER = 'x-ai-intent'

/** Header carrying the server-issued, HMAC-signed quality-gate token. */
export const GATE_TOKEN_HEADER = 'x-gate-token'

export type RequireGateResult =
  | { ok: true; intent?: string }
  | { ok: false; status: number; error: string }

/**
 * Enforce the quality gate on AI-originated requests.
 *
 * If the AI-intent header is absent the request is manual/non-AI and the gate
 * is not applicable — `{ ok: true }`. If present, the declared intent must be
 * one of `allowedIntents`, the gate token must verify via `verifyGateToken`
 * (signature, expiry, score threshold), and the token's signed intent must
 * equal the declared intent. Any mismatch fails closed with a 403; this
 * function never throws.
 */
export function requireAiGate(
  headers: Headers,
  allowedIntents: readonly string[]
): RequireGateResult {
  try {
    const declaredIntent = headers.get(AI_INTENT_HEADER)
    if (declaredIntent === null) {
      // No AI marker — a manual, human-composed request. Gate not applicable.
      return { ok: true }
    }

    if (!allowedIntents.includes(declaredIntent)) {
      return {
        ok: false,
        status: 403,
        error: `AI intent "${declaredIntent}" is not permitted on this route.`,
      }
    }

    const gate = verifyGateToken(headers.get(GATE_TOKEN_HEADER))
    if (!gate.valid) {
      return {
        ok: false,
        status: 403,
        error: `Quality gate not satisfied (${gate.reason ?? 'no valid gate token'}). Re-run this action through the assistant so it can be re-validated.`,
      }
    }

    if (gate.intent !== declaredIntent) {
      return {
        ok: false,
        status: 403,
        error: `Quality gate not satisfied (token intent mismatch). Re-run this action through the assistant so it can be re-validated.`,
      }
    }

    return { ok: true, intent: declaredIntent }
  } catch {
    // verifyGateToken is designed not to throw, but this boundary must never
    // let an unexpected error open the gate — fail closed.
    return { ok: false, status: 403, error: 'Quality gate verification failed.' }
  }
}
