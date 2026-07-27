/**
 * Google Chat space classification + visibility preferences (PURE, client-safe).
 *
 * WHY THIS EXISTS
 * ---------------
 * Google Chat auto-creates a conversation for things the user never chose to
 * join: every Google Meet call spawns an unnamed group chat, and every 1:1
 * message opens a DM. Listing `spaces.list` verbatim therefore floods the Hub's
 * Chat panel with dozens of throwaway conversations that bury the handful of
 * real, deliberately-created team spaces.
 *
 * So visibility is no longer "whatever the raw API returned". Each space is
 * classified into a `ChatSpaceKind`, only deliberately-created NAMED spaces are
 * visible by DEFAULT, and the user's saved preference is expressed as explicit
 * OVERRIDES on top of that default rather than as a snapshot list of names.
 *
 * The override model matters: a snapshot ("show exactly these 12 spaces") is
 * frozen at save time, so it says nothing about a space that did not exist yet.
 * With overrides, a Meet chat created tomorrow is hidden by the default rule
 * without the user having to re-open Settings — which is the actual complaint
 * this module fixes.
 *
 * This module is deliberately free of React, Postgres and `next/*` imports so
 * it can be shared by the client panel, the Settings editor, the API routes and
 * the server-side AI context builder without dragging a driver into the bundle.
 */

/* ══════════════════════════════════════════
   Types
   ══════════════════════════════════════════ */

/** The subset of the Chat API `Space` resource that classification needs. */
export interface ClassifiableSpace {
  name: string
  displayName?: string
  /**
   * DEPRECATED Chat API discriminator. Only three values exist —
   * `TYPE_UNSPECIFIED | ROOM | DM` — and they do NOT mean what the names
   * suggest:
   *   ROOM = any conversation between two or more HUMANS, which lumps named
   *          spaces, group chats and human 1:1 DMs together;
   *   DM   = a 1:1 conversation between a human and a Chat APP — explicitly
   *          NOT a direct message between two people.
   * It is therefore useless for the distinction we care about, and is used
   * here only as a fallback when `spaceType` is absent.
   */
  type?: string
  /** Current discriminator: SPACE | GROUP_CHAT | DIRECT_MESSAGE. Authoritative. */
  spaceType?: string
  /** True for a DM with a Chat app/bot rather than a person. */
  singleUserBotDm?: boolean
  /**
   * `UNTHREADED_MESSAGES` marks continuous meeting chat (and pre-2022 legacy
   * group conversations). Not currently used to classify — `spaceType` already
   * buckets Meet conversations as GROUP_CHAT — but recorded here because it is
   * the only positive Meet-origin signal the API exposes.
   */
  spaceThreadingState?: string
}

/**
 * What kind of conversation a space actually is.
 *
 * - `named`  — a real space/room someone deliberately created and named.
 * - `group`  — an unnamed multi-person conversation. This is what Google Meet
 *              creates for a call, and what an ad-hoc "message these 3 people"
 *              thread becomes. The overwhelming majority of the clutter.
 * - `dm`     — a 1:1 direct message with a person.
 * - `bot`    — a DM with a Chat app / bot (`singleUserBotDm`).
 */
export type ChatSpaceKind = 'named' | 'group' | 'dm' | 'bot'

export interface ChatSpacePreferences {
  /** Space names forced VISIBLE even though the default rule hides them. */
  shown: string[]
  /** Space names forced HIDDEN even though the default rule shows them. */
  hidden: string[]
}

export const EMPTY_CHAT_SPACE_PREFERENCES: ChatSpacePreferences = { shown: [], hidden: [] }

/**
 * Cap on each override list. Overrides only grow when the user toggles a space
 * by hand, so this is a sanity bound against a malformed/hostile payload, not a
 * limit anyone should reach. A workspace with more spaces than this still works
 * — the default rule covers everything past the cap.
 */
export const MAX_SPACE_OVERRIDES = 500

/** localStorage key of the pre-server pinned-space list (see migration below). */
export const LEGACY_PINNED_SPACES_KEY = 'hub-chat-pinned-spaces'

/* ══════════════════════════════════════════
   Classification
   ══════════════════════════════════════════ */

/**
 * Classify a space, bucketing on `spaceType` — the only field that actually
 * separates a named space from a Meet conversation from a human DM.
 *
 * `spaceType` is output-only and populated on every `spaces.list` result, so in
 * production this is a straight lookup. The deprecated `type` field is consulted
 * ONLY when `spaceType` is missing (older fixtures and test mocks), and is read
 * with its real semantics: `DM` there means a human↔Chat-app conversation, not
 * a person-to-person one, while `ROOM` is too coarse to decide anything on its
 * own and falls through to the displayName check below.
 *
 * Both fields are compared case-insensitively: the enums are documented
 * upper-case, but nothing in the API contract makes casing meaningful.
 *
 * A `named` verdict additionally REQUIRES a non-empty displayName. Google
 * requires a display name when creating a `SPACE`, so every genuine named space
 * has one; an unnamed conversation was not deliberately named by a human and is
 * treated as ad-hoc. Note this check cannot be used in reverse — Meet
 * conversations DO carry a system-generated name like "Sales Team Weekly -
 * Nov 8", which is why they are identified by `spaceType`, not by name shape.
 */
export function classifyChatSpace(space: ClassifiableSpace): ChatSpaceKind {
  if (space.singleUserBotDm === true) return 'bot'

  const spaceType = (space.spaceType ?? '').trim().toUpperCase()
  if (spaceType === 'DIRECT_MESSAGE') return 'dm'
  if (spaceType === 'GROUP_CHAT') return 'group'

  // No spaceType: fall back to the deprecated field, where DM means an app DM.
  if (!spaceType && (space.type ?? '').trim().toUpperCase() === 'DM') return 'bot'

  // SPACE / ROOM (or an unrecognized future enum) — a real space only if it
  // actually carries a human-chosen name.
  if (!(space.displayName ?? '').trim()) return 'group'
  return 'named'
}

/**
 * The DEFAULT visibility rule: only named spaces show up on their own.
 *
 * DMs, unnamed/Meet group chats and bot DMs stay hidden until the user turns
 * them on individually in Settings. This is the behavior change the Hub owner
 * asked for — "I want them off by default".
 */
export function isDefaultVisibleSpace(space: ClassifiableSpace): boolean {
  return classifyChatSpace(space) === 'named'
}

/** Human-readable label for a kind — used by the Settings list grouping. */
export function chatSpaceKindLabel(kind: ChatSpaceKind): string {
  switch (kind) {
    case 'named': return 'Spaces'
    case 'group': return 'Group & Meet chats'
    case 'dm':    return 'Direct messages'
    case 'bot':   return 'Apps & bots'
  }
}

/* ══════════════════════════════════════════
   Preference normalization
   ══════════════════════════════════════════ */

function normalizeNameList(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  for (const raw of input) {
    if (typeof raw !== 'string') continue
    const value = raw.trim()
    // Space resource names are always "spaces/<id>"; anything else is junk we
    // must not persist (it could never match a real space anyway).
    if (!/^spaces\/[A-Za-z0-9_-]+$/.test(value)) continue
    seen.add(value)
    if (seen.size >= MAX_SPACE_OVERRIDES) break
  }
  return Array.from(seen).sort()
}

/**
 * Harden an arbitrary payload into storable preferences.
 *
 * Applied on the way IN (before the DB write) and on the way OUT (after the
 * read), so a row written by an older client — or a hand-edited one — can never
 * feed malformed names into the visibility computation.
 *
 * A name present in BOTH lists is contradictory; `hidden` wins, because the
 * failure mode of wrongly hiding a space (the user re-enables it) is far milder
 * than wrongly surfacing a private DM.
 */
export function normalizeChatSpacePreferences(input: unknown): ChatSpacePreferences {
  const source = (input ?? {}) as Record<string, unknown>
  const hidden = normalizeNameList(source.hidden)
  const hiddenSet = new Set(hidden)
  const shown = normalizeNameList(source.shown).filter(n => !hiddenSet.has(n))
  return { shown, hidden }
}

/** True when the user has never expressed an opinion (pure defaults). */
export function hasNoChatSpaceOverrides(prefs: ChatSpacePreferences): boolean {
  return prefs.shown.length === 0 && prefs.hidden.length === 0
}

/* ══════════════════════════════════════════
   Visibility resolution
   ══════════════════════════════════════════ */

/**
 * Should this space appear in the Chat panel?
 *
 * Precedence: explicit hide → explicit show → default rule. Explicit hide is
 * checked first so the contradictory-payload case resolves the same way
 * `normalizeChatSpacePreferences` does, even if a caller skipped normalization.
 */
export function isSpaceVisible(
  space: ClassifiableSpace,
  prefs: ChatSpacePreferences = EMPTY_CHAT_SPACE_PREFERENCES,
): boolean {
  if (prefs.hidden.includes(space.name)) return false
  if (prefs.shown.includes(space.name)) return true
  return isDefaultVisibleSpace(space)
}

/** Filter a space list down to what the user should actually see. */
export function resolveVisibleSpaces<T extends ClassifiableSpace>(
  spaces: T[],
  prefs: ChatSpacePreferences = EMPTY_CHAT_SPACE_PREFERENCES,
): T[] {
  return spaces.filter(s => isSpaceVisible(s, prefs))
}

/**
 * Flip one space's visibility, returning the new override set.
 *
 * Toggling a space back to its default state REMOVES the override instead of
 * writing the opposite one. That keeps the stored preference minimal and — more
 * importantly — keeps the space governed by the default rule, so it stays
 * correct if the rule itself ever changes.
 */
export function toggleSpaceVisibility(
  space: ClassifiableSpace,
  prefs: ChatSpacePreferences,
): ChatSpacePreferences {
  const nextVisible = !isSpaceVisible(space, prefs)
  const shown = prefs.shown.filter(n => n !== space.name)
  const hidden = prefs.hidden.filter(n => n !== space.name)

  if (nextVisible === isDefaultVisibleSpace(space)) {
    // Back to the default — no override needed.
    return { shown, hidden }
  }
  return nextVisible
    ? { shown: [...shown, space.name].sort(), hidden }
    : { shown, hidden: [...hidden, space.name].sort() }
}

/** Force every listed space visible (the Settings "Show all" button). */
export function showAllSpaces(spaces: ClassifiableSpace[]): ChatSpacePreferences {
  return normalizeChatSpacePreferences({
    shown: spaces.filter(s => !isDefaultVisibleSpace(s)).map(s => s.name),
    hidden: [],
  })
}

/** Force every listed space hidden (the Settings "Hide all" button). */
export function hideAllSpaces(spaces: ClassifiableSpace[]): ChatSpacePreferences {
  return normalizeChatSpacePreferences({
    shown: [],
    hidden: spaces.map(s => s.name),
  })
}

/* ══════════════════════════════════════════
   Legacy localStorage migration
   ══════════════════════════════════════════ */

/**
 * Convert the old browser-local pinned list into server-side overrides.
 *
 * The previous implementation stored an absolute snapshot of pinned space names
 * in `localStorage` under {@link LEGACY_PINNED_SPACES_KEY}, with `null` meaning
 * "never configured → show everything". That is what was silently lost on every
 * new login, browser or device.
 *
 * Returns `null` when there is nothing worth migrating, in which case the user
 * simply lands on the new defaults:
 *
 *  - no legacy value (never configured), or
 *  - a legacy value that covers EVERY known space. That is the old "Show all"
 *    state, which was also the old default — it records no actual decision, and
 *    importing it would re-import exactly the Meet/DM clutter this change
 *    exists to remove.
 *
 * Anything else is a real choice and is preserved faithfully: pinned spaces
 * become visible, unpinned ones hidden, each expressed as an override only
 * where it differs from the new default rule.
 */
export function migrateLegacyPinnedSpaces(
  legacyPinned: string[] | null | undefined,
  allSpaces: ClassifiableSpace[],
): ChatSpacePreferences | null {
  if (!Array.isArray(legacyPinned)) return null
  if (allSpaces.length === 0) return null

  const pinned = new Set(legacyPinned)
  const coversEverything = allSpaces.every(s => pinned.has(s.name))
  if (coversEverything) return null

  const shown: string[] = []
  const hidden: string[] = []
  for (const space of allSpaces) {
    const wantVisible = pinned.has(space.name)
    if (wantVisible === isDefaultVisibleSpace(space)) continue
    if (wantVisible) shown.push(space.name)
    else hidden.push(space.name)
  }
  return normalizeChatSpacePreferences({ shown, hidden })
}
