import { describe, it, expect } from 'vitest'
import { TOOL_PANEL_MAP } from './index'

/* ════════════════════════════════════════════════════════════════════════════
   Tool-panel dispatch map — key contract.
   Guards that every tool that has a dedicated (code-split) panel is wired into
   the dispatcher. The render behaviour itself is exercised by the e2e suite,
   which injects chat that drives each panel; this test only pins the mapping so
   a rename/typo can't silently drop a panel to the generic fallback.
   ════════════════════════════════════════════════════════════════════════════ */

const EXPECTED_TOOL_IDS = [
  'deep-research',
  'deep-think',
  'issue-tree',
  'decision-memo',
  'prioritization',
  'data-insights',
  'meeting-prep',
  'storyline',
  'scpr',
  'mckinsey-critic',
  'ai-use-case-scorer',
  'deck-pipeline',
  'gamma-deck',
]

describe('TOOL_PANEL_MAP', () => {
  it('maps exactly the expected tool ids', () => {
    expect(Object.keys(TOOL_PANEL_MAP).sort()).toEqual([...EXPECTED_TOOL_IDS].sort())
  })

  it('resolves every tool id to a renderable component', () => {
    for (const id of EXPECTED_TOOL_IDS) {
      const Panel = TOOL_PANEL_MAP[id]
      expect(Panel, `panel for "${id}"`).toBeTruthy()
      // next/dynamic returns a component (function or forwardRef object).
      expect(['function', 'object']).toContain(typeof Panel)
    }
  })
})
