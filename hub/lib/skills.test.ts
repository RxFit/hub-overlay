import { describe, it, expect } from 'vitest'
import { DEEP_TOOL_IDS, isDeepTool, SKILL_CATALOG, SKILL_MAP } from './skills'

/**
 * lib/skills.ts — deep-tool registry invariants (PR C).
 *
 * The deep tools are PANEL tools: catalog-registered (so suggestion and
 * activation work) but excluded from chat-turn skill injection by
 * isDeepTool() — both useChatEngine and /api/chat consult it. These pins
 * keep a future catalog edit from silently breaking either half.
 */

describe('deep tool registry', () => {
  it('both deep tools are registered enterprise-ai catalog entries', () => {
    for (const id of DEEP_TOOL_IDS) {
      const skill = SKILL_MAP[id]
      expect(skill, `${id} missing from SKILL_MAP`).toBeTruthy()
      expect(skill.plugin).toBe('enterprise-ai')
      expect(skill.name.length).toBeGreaterThan(0)
    }
  })

  it('isDeepTool admits exactly the deep ids — the chat-lens exclusion predicate', () => {
    expect(isDeepTool('deep-research')).toBe(true)
    expect(isDeepTool('deep-think')).toBe(true)
    expect(isDeepTool('issue-tree')).toBe(false)
    expect(isDeepTool('')).toBe(false)
    expect(isDeepTool(null)).toBe(false)
    expect(isDeepTool(undefined)).toBe(false)
  })

  it('every catalog id is unique (the map cannot silently drop entries)', () => {
    const ids = SKILL_CATALOG.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
