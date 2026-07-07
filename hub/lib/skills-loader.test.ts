import { describe, it, expect } from 'vitest'
import { loadSkillContent } from './skills-loader'

/**
 * skills-loader reads real SKILL.md files from hub/skills/** (vitest runs with
 * cwd = hub/, matching the server's process.cwd()). These tests exercise the
 * actual path construction per plugin, YAML-frontmatter stripping, and the
 * gstack boilerplate scrubber against the files that ship with the repo.
 */
describe('loadSkillContent', () => {
  it('returns null for an unknown skill id', async () => {
    await expect(loadSkillContent('definitely-not-a-skill')).resolves.toBeNull()
  })

  it('loads the enterprise-ai router skill and strips YAML frontmatter', async () => {
    const content = await loadSkillContent('enterprise-ai')
    expect(content).toBeTruthy()
    // Frontmatter delimiters must be gone; the real body must remain.
    expect(content!.startsWith('---')).toBe(false)
    expect(content).not.toContain('allowed-tools')
    expect(content).toContain('# Enterprise AI')
  })

  it('loads an enterprise-ai SUB-skill from its own directory', async () => {
    const content = await loadSkillContent('decision-memo')
    expect(content).toBeTruthy()
    expect(content!.startsWith('---')).toBe(false)
    expect(content!.length).toBeGreaterThan(100)
  })

  it('strips gstack boilerplate sections that cannot run in the browser', async () => {
    const content = await loadSkillContent('autoplan')
    expect(content).toBeTruthy()
    // The raw file contains these; the loader must remove them.
    expect(content).not.toContain('## Preamble (run first)')
    expect(content).not.toContain('## AskUserQuestion Format')
    expect(content).not.toContain('AUTO-GENERATED')
    // Bash blocks invoking gstack binaries are scrubbed too.
    expect(content).not.toContain('gstack-update-check')
  })

  it('serves repeated loads consistently (cache path)', async () => {
    const first = await loadSkillContent('enterprise-ai')
    const second = await loadSkillContent('enterprise-ai')
    expect(second).toBe(first)
  })
})
