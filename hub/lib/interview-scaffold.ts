/**
 * Typed discriminator for transient Interview Mode scaffold messages.
 *
 * Interview Mode injects throwaway assistant bubbles (the "Interview complete!"
 * and "Briefing approved" prompts shown above the ActionConfirmCard) that are
 * removed again during cleanup. Tagging them with a `kind` lets cleanup filter
 * by type instead of matching on user-visible content — the old approach could
 * delete a real user/assistant message that merely contained the same phrase.
 */
export const INTERVIEW_SCAFFOLD_KIND = 'interview-scaffold' as const

export type ChatMsgKind = typeof INTERVIEW_SCAFFOLD_KIND

/** Minimal shape needed to decide interview cleanup: a message with an optional kind tag. */
export type ScaffoldTaggable = { kind?: ChatMsgKind }

/**
 * True when a message is transient interview scaffolding that should be dropped
 * during interview cleanup. Keyed on the typed `kind` tag, never on content, so
 * a genuine message that happens to contain scaffold-like text always survives.
 */
export function isInterviewScaffold(msg: ScaffoldTaggable): boolean {
  return msg.kind === INTERVIEW_SCAFFOLD_KIND
}
