/**
 * Pure routing decision for the panel → chat "inject" path.
 *
 * Two semantic classes of inject exist:
 *  - Action-style ('execute'): create/launch prompts that must run the full
 *    send pipeline (detectIntent → role-gate → Interview Mode), exactly as if
 *    the user had typed the sentence. These route through `doSend`.
 *  - Read-style ('recall' / 'deep_dive'): informational lookups
 *    ("tell me about…", "summarize…"). These stay on the direct, intent-free
 *    `sendToApi` path.
 *
 * Extracted as a pure predicate so the routing rule is unit-testable without
 * mounting the React component.
 */
export function shouldRouteThroughSend(useCase: string): boolean {
  return useCase === 'execute'
}
