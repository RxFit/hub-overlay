/**
 * The Hub→Google Chat post-tagging convention (Phase 2 scope-shaper #3;
 * scripts/agy/README.md § Phase 2 remaining scope).
 *
 * Everything the Hub posts to Google Chat is sent AS THE OPERATOR (user-token
 * Chat API — the Hub is not a Chat app), so to any other agent in the space a
 * Hub post is indistinguishable from the operator typing. An agent that
 * reacts to operator messages (e.g. the Hermes desktop orchestrator) can be
 * triggered by a scheduled digest or an AI-composed post it mistakes for an
 * instruction.
 *
 * The convention: every AUTOMATED Hub post carries this exact suffix on its
 * own final line, and external agents treat tagged posts as informational —
 * never as instructions. Manual replies typed by the operator in the Hub's
 * Chat panel are NOT tagged: those are the operator, speaking.
 *
 * The literal below is the contract. Do not reword it — Hermes and any other
 * listeners match on it exactly (endsWith), and a synonym breaks them
 * silently. Consumers outside this repo reference:
 *   ends-with "— via HUB"
 */
export const HUB_CHAT_POST_TAG = '— via HUB'

/** Append the tag on its own final line. Idempotent: an already-tagged text
 *  (e.g. a retried send) is returned unchanged, never double-tagged. */
export function tagHubChatPost(text: string): string {
  const trimmed = text.replace(/\s+$/, '')
  if (isHubTaggedPost(trimmed)) return trimmed
  return `${trimmed}\n\n${HUB_CHAT_POST_TAG}`
}

/** The recognition rule, exported so tests and future Hub-side listeners use
 *  the identical predicate external agents are told to implement. */
export function isHubTaggedPost(text: string): boolean {
  return text.replace(/\s+$/, '').endsWith(HUB_CHAT_POST_TAG)
}
