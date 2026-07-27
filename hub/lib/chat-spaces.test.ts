import { describe, it, expect } from 'vitest'
import {
  classifyChatSpace,
  isDefaultVisibleSpace,
  isSpaceVisible,
  resolveVisibleSpaces,
  normalizeChatSpacePreferences,
  toggleSpaceVisibility,
  showAllSpaces,
  hideAllSpaces,
  migrateLegacyPinnedSpaces,
  hasNoChatSpaceOverrides,
  chatSpaceKindLabel,
  MAX_SPACE_OVERRIDES,
  EMPTY_CHAT_SPACE_PREFERENCES,
  type ClassifiableSpace,
} from './chat-spaces'

/**
 * The contract this suite pins: Google Chat's auto-created conversations
 * (Meet group chats, DMs, bot DMs) are HIDDEN by default, named spaces are
 * shown, and the user's saved choice is an override set that keeps working for
 * spaces that did not exist when it was saved.
 */

const named = (name: string, displayName = 'RxFit Ops'): ClassifiableSpace =>
  ({ name, displayName, spaceType: 'SPACE', type: 'ROOM' })

/** What Google Meet leaves behind: a group chat with no human-chosen name. */
const meetChat = (name: string): ClassifiableSpace =>
  ({ name, displayName: '', spaceType: 'GROUP_CHAT', type: 'GROUP_CHAT' })

const dm = (name: string): ClassifiableSpace =>
  ({ name, displayName: '', spaceType: 'DIRECT_MESSAGE', type: 'DM' })

const botDm = (name: string): ClassifiableSpace =>
  ({ name, displayName: 'Google Drive', spaceType: 'DIRECT_MESSAGE', type: 'DM', singleUserBotDm: true })

describe('classifyChatSpace', () => {
  it('classifies a named space as named', () => {
    expect(classifyChatSpace(named('spaces/AAA'))).toBe('named')
  })

  it('classifies a Meet/ad-hoc group chat as group', () => {
    expect(classifyChatSpace(meetChat('spaces/BBB'))).toBe('group')
  })

  it('classifies a direct message as dm', () => {
    expect(classifyChatSpace(dm('spaces/CCC'))).toBe('dm')
  })

  it('classifies a bot DM as bot even though it looks like a DM', () => {
    expect(classifyChatSpace(botDm('spaces/DDD'))).toBe('bot')
  })

  it('prefers spaceType over the deprecated type field when they disagree', () => {
    // A legacy `type: 'ROOM'` must not promote a DIRECT_MESSAGE to a named space.
    const conflicted: ClassifiableSpace = {
      name: 'spaces/EEE', displayName: 'looks named', spaceType: 'DIRECT_MESSAGE', type: 'ROOM',
    }
    expect(classifyChatSpace(conflicted)).toBe('dm')
  })

  it('falls back to the deprecated type when spaceType is absent', () => {
    // The deprecated `DM` value means a human↔Chat-APP conversation, not a
    // person-to-person DM — so it classifies as a bot conversation.
    expect(classifyChatSpace({ name: 'spaces/FFF', displayName: '', type: 'DM' })).toBe('bot')
    // `ROOM` is too coarse to decide on its own; the display name settles it.
    expect(classifyChatSpace({ name: 'spaces/GGG', displayName: 'Ops', type: 'ROOM' })).toBe('named')
    expect(classifyChatSpace({ name: 'spaces/HHH', displayName: '', type: 'ROOM' })).toBe('group')
  })

  it('classifies a Meet conversation by spaceType even though it HAS a display name', () => {
    // Google names meeting conversations "<event> - <date>", so an empty-name
    // heuristic would miss them entirely.
    const meet: ClassifiableSpace = {
      name: 'spaces/MEET1',
      displayName: 'Sales Team Weekly - Nov 8',
      spaceType: 'GROUP_CHAT',
      type: 'ROOM',
      spaceThreadingState: 'UNTHREADED_MESSAGES',
    }
    expect(classifyChatSpace(meet)).toBe('group')
    expect(isDefaultVisibleSpace(meet)).toBe(false)
  })

  it('classifies a human 1:1 DM that carries the coarse legacy type ROOM', () => {
    // Per the API docs a human DM reports `type: 'ROOM'`; only spaceType is
    // decisive. Getting this wrong would file private DMs under "Spaces".
    expect(classifyChatSpace({
      name: 'spaces/DM9', displayName: '', spaceType: 'DIRECT_MESSAGE', type: 'ROOM',
    })).toBe('dm')
  })

  it('treats a SPACE with no displayName as ad-hoc, not named', () => {
    // An unnamed "space" was never deliberately named by a human.
    expect(classifyChatSpace({ name: 'spaces/HHH', displayName: '  ', spaceType: 'SPACE' })).toBe('group')
  })

  it('is case-insensitive about the enum values', () => {
    expect(classifyChatSpace({ name: 'spaces/III', displayName: '', spaceType: 'direct_message' })).toBe('dm')
  })

  it('labels every kind', () => {
    expect(chatSpaceKindLabel('named')).toMatch(/space/i)
    expect(chatSpaceKindLabel('group')).toMatch(/meet|group/i)
    expect(chatSpaceKindLabel('dm')).toMatch(/direct/i)
    expect(chatSpaceKindLabel('bot')).toMatch(/app|bot/i)
  })
})

describe('isDefaultVisibleSpace — only named spaces are on by default', () => {
  it('shows named spaces', () => {
    expect(isDefaultVisibleSpace(named('spaces/AAA'))).toBe(true)
  })

  it('hides Meet chats, DMs and bot DMs', () => {
    expect(isDefaultVisibleSpace(meetChat('spaces/BBB'))).toBe(false)
    expect(isDefaultVisibleSpace(dm('spaces/CCC'))).toBe(false)
    expect(isDefaultVisibleSpace(botDm('spaces/DDD'))).toBe(false)
  })
})

describe('resolveVisibleSpaces', () => {
  const all = [named('spaces/AAA'), meetChat('spaces/BBB'), dm('spaces/CCC'), botDm('spaces/DDD')]

  it('shows only named spaces with no preferences at all', () => {
    expect(resolveVisibleSpaces(all).map(s => s.name)).toEqual(['spaces/AAA'])
  })

  it('honors an explicit show override for a DM', () => {
    const prefs = { shown: ['spaces/CCC'], hidden: [] }
    expect(resolveVisibleSpaces(all, prefs).map(s => s.name)).toEqual(['spaces/AAA', 'spaces/CCC'])
  })

  it('honors an explicit hide override for a named space', () => {
    const prefs = { shown: [], hidden: ['spaces/AAA'] }
    expect(resolveVisibleSpaces(all, prefs)).toEqual([])
  })

  it('hides a NEW Meet chat that appears after preferences were saved', () => {
    // The whole point of overrides-over-snapshot: a space the user has never
    // seen is governed by the default rule, so it stays out of the panel.
    const prefs = { shown: ['spaces/CCC'], hidden: [] }
    const withNewMeet = [...all, meetChat('spaces/ZZZ')]
    expect(resolveVisibleSpaces(withNewMeet, prefs).map(s => s.name)).not.toContain('spaces/ZZZ')
  })

  it('resolves a contradictory override in favor of hidden', () => {
    const prefs = { shown: ['spaces/AAA'], hidden: ['spaces/AAA'] }
    expect(isSpaceVisible(named('spaces/AAA'), prefs)).toBe(false)
  })
})

describe('normalizeChatSpacePreferences', () => {
  it('returns empty preferences for junk input', () => {
    expect(normalizeChatSpacePreferences(null)).toEqual(EMPTY_CHAT_SPACE_PREFERENCES)
    expect(normalizeChatSpacePreferences('nope')).toEqual(EMPTY_CHAT_SPACE_PREFERENCES)
    expect(normalizeChatSpacePreferences({ shown: 'x', hidden: 7 })).toEqual(EMPTY_CHAT_SPACE_PREFERENCES)
  })

  it('drops entries that are not real space resource names', () => {
    const out = normalizeChatSpacePreferences({
      shown: ['spaces/OK', 'not-a-space', '', 'spaces/bad id', 42, null],
      hidden: [],
    })
    expect(out.shown).toEqual(['spaces/OK'])
  })

  it('dedupes and sorts for a stable stored value', () => {
    const out = normalizeChatSpacePreferences({ shown: ['spaces/B', 'spaces/A', 'spaces/B'], hidden: [] })
    expect(out.shown).toEqual(['spaces/A', 'spaces/B'])
  })

  it('removes a name from shown when it also appears in hidden', () => {
    const out = normalizeChatSpacePreferences({ shown: ['spaces/A'], hidden: ['spaces/A'] })
    expect(out.shown).toEqual([])
    expect(out.hidden).toEqual(['spaces/A'])
  })

  it('caps each list so a hostile payload cannot grow unbounded', () => {
    const many = Array.from({ length: MAX_SPACE_OVERRIDES + 50 }, (_, i) => `spaces/S${i}`)
    const out = normalizeChatSpacePreferences({ shown: many, hidden: [] })
    expect(out.shown.length).toBeLessThanOrEqual(MAX_SPACE_OVERRIDES)
  })

  it('reports whether any override exists', () => {
    expect(hasNoChatSpaceOverrides(EMPTY_CHAT_SPACE_PREFERENCES)).toBe(true)
    expect(hasNoChatSpaceOverrides({ shown: ['spaces/A'], hidden: [] })).toBe(false)
  })
})

describe('toggleSpaceVisibility', () => {
  it('adds a show override when enabling a default-hidden DM', () => {
    const out = toggleSpaceVisibility(dm('spaces/CCC'), EMPTY_CHAT_SPACE_PREFERENCES)
    expect(out).toEqual({ shown: ['spaces/CCC'], hidden: [] })
  })

  it('adds a hide override when disabling a default-visible space', () => {
    const out = toggleSpaceVisibility(named('spaces/AAA'), EMPTY_CHAT_SPACE_PREFERENCES)
    expect(out).toEqual({ shown: [], hidden: ['spaces/AAA'] })
  })

  it('REMOVES the override when toggling back to the default state', () => {
    // Storing the redundant opposite override would freeze the space against a
    // future change to the default rule.
    const shown = toggleSpaceVisibility(dm('spaces/CCC'), EMPTY_CHAT_SPACE_PREFERENCES)
    const back = toggleSpaceVisibility(dm('spaces/CCC'), shown)
    expect(back).toEqual({ shown: [], hidden: [] })
  })

  it('round-trips a named space back to no overrides', () => {
    const hidden = toggleSpaceVisibility(named('spaces/AAA'), EMPTY_CHAT_SPACE_PREFERENCES)
    expect(toggleSpaceVisibility(named('spaces/AAA'), hidden)).toEqual({ shown: [], hidden: [] })
  })
})

describe('showAllSpaces / hideAllSpaces', () => {
  const all = [named('spaces/AAA'), meetChat('spaces/BBB'), dm('spaces/CCC')]

  it('show all makes every space visible', () => {
    const prefs = showAllSpaces(all)
    expect(resolveVisibleSpaces(all, prefs)).toHaveLength(3)
  })

  it('show all only records overrides for spaces the default rule hides', () => {
    expect(showAllSpaces(all).shown).toEqual(['spaces/BBB', 'spaces/CCC'])
  })

  it('hide all makes every space hidden', () => {
    expect(resolveVisibleSpaces(all, hideAllSpaces(all))).toEqual([])
  })
})

describe('migrateLegacyPinnedSpaces', () => {
  const all = [named('spaces/AAA'), named('spaces/BBB', 'Marketing'), meetChat('spaces/CCC'), dm('spaces/DDD')]

  it('returns null when there is no legacy value (never configured)', () => {
    expect(migrateLegacyPinnedSpaces(null, all)).toBeNull()
    expect(migrateLegacyPinnedSpaces(undefined, all)).toBeNull()
  })

  it('returns null when the legacy list covered EVERY space', () => {
    // That was the old "Show all" default — it records no decision, and
    // importing it would re-admit the exact Meet/DM clutter we are removing.
    expect(migrateLegacyPinnedSpaces(all.map(s => s.name), all)).toBeNull()
  })

  it('returns null when there are no spaces to compare against', () => {
    expect(migrateLegacyPinnedSpaces(['spaces/AAA'], [])).toBeNull()
  })

  it('preserves a real choice as overrides relative to the new defaults', () => {
    // The user kept one named space and one DM, and dropped the other space.
    const out = migrateLegacyPinnedSpaces(['spaces/AAA', 'spaces/DDD'], all)
    expect(out).toEqual({ shown: ['spaces/DDD'], hidden: ['spaces/BBB'] })
  })

  it('records no override for a space whose legacy state already matches the default', () => {
    const out = migrateLegacyPinnedSpaces(['spaces/AAA', 'spaces/BBB'], all)
    // Both named spaces stay visible (default) and the Meet chat + DM stay
    // hidden (default) — nothing to store.
    expect(out).toEqual({ shown: [], hidden: [] })
  })

  it('migrated preferences reproduce the legacy visible set exactly', () => {
    const legacy = ['spaces/BBB', 'spaces/CCC']
    const out = migrateLegacyPinnedSpaces(legacy, all)!
    expect(resolveVisibleSpaces(all, out).map(s => s.name).sort()).toEqual(legacy.sort())
  })
})
