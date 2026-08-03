/**
 * Pure sharing vocabulary — role parsing and recipient splitting.
 *
 * Split out from `sharing.ts` (which reaches Drive) so the browser-side
 * confirm-card executor can normalize a role and split a recipient list without
 * dragging the whole Drive REST layer into the client bundle. Nothing here does
 * I/O, so both sides can agree on the same rules.
 */

/**
 * The access levels the Hub will grant. `owner` is deliberately absent:
 * ownership transfer is irreversible from the Hub's side and is not something a
 * chat confirm-card should be able to do.
 */
export type ShareRole = 'reader' | 'commenter' | 'writer'

const ROLE_SYNONYMS: Record<string, ShareRole> = {
  reader: 'reader', read: 'reader', view: 'reader', viewer: 'reader',
  'view only': 'reader', 'read only': 'reader', 'can view': 'reader',
  commenter: 'commenter', comment: 'commenter', 'can comment': 'commenter',
  writer: 'writer', write: 'writer', edit: 'writer', editor: 'writer',
  'can edit': 'writer', editable: 'writer',
}

/**
 * Map a human phrase ("can edit", "view only") to a Drive role.
 *
 * Returns `reader` for anything unrecognised — including an empty string. The
 * default is least-privilege on purpose: an ambiguous instruction must never
 * silently widen access, and the granted role is shown back to the user in both
 * the confirm card and the result message, so an under-grant is visible and
 * trivially corrected.
 */
export function normalizeShareRole(input: string | undefined): ShareRole {
  const key = (input ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
  return ROLE_SYNONYMS[key] ?? 'reader'
}

/** Human label for a role, for confirm cards and result messages. */
export function shareRoleLabel(role: ShareRole): string {
  return role === 'writer' ? 'editor' : role === 'commenter' ? 'commenter' : 'viewer'
}

/**
 * Split a free-text recipient list into individual references.
 *
 * Accepts commas, semicolons, newlines and a trailing " and " — the shapes a
 * person actually types ("maria@x.com, Danny and Sam"). References may be names
 * rather than addresses; resolving those is the caller's job (the Hub already
 * has a contacts lookup for it).
 */
export function parseRecipientRefs(raw: string): string[] {
  return (raw ?? '')
    .split(/[,;\n]|\band\b/i)
    .map(part => part.trim().replace(/^[<(]|[>)]$/g, '').trim())
    .filter(Boolean)
}
