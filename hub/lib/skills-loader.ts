/**
 * Hub Skills Loader — Server-side only
 *
 * Dynamically loads the full markdown content of skills from the filesystem.
 * This cannot be imported by client components.
 */

import { readFile } from 'fs/promises'
import { join } from 'path'
import { SKILL_MAP } from './skills'

const SKILLS_BASE = process.env.SKILLS_BASE_PATH
  || join(process.cwd(), 'skills')

// Server-side cache for loaded skills
const contentCache: Record<string, string> = {}

export async function loadSkillContent(skillId: string): Promise<string | null> {
  const skill = SKILL_MAP[skillId]
  if (!skill) return null

  if (contentCache[skillId]) return contentCache[skillId]

  try {
    // Construct paths manually based on the original plugin structures
    let skillPath = ''
    if (skill.plugin === 'enterprise-ai') {
      if (skill.id === 'enterprise-ai') {
        skillPath = join(SKILLS_BASE, 'enterprise-ai', 'SKILL.md')
      } else {
        skillPath = join(SKILLS_BASE, 'enterprise-ai', skill.id, 'SKILL.md')
      }
    } else if (skill.plugin === 'gstack') {
      skillPath = join(SKILLS_BASE, 'gstack', skill.id, 'SKILL.md')
    } else {
      skillPath = join(SKILLS_BASE, skill.plugin, skill.id, 'SKILL.md')
    }

    const raw = await readFile(skillPath, 'utf-8')

    // Strip YAML frontmatter
    let content = raw.replace(/^---[\s\S]*?---\s*/, '')

    // For gstack skills, strip boilerplate sections that don't work in browser context
    if (skill.plugin === 'gstack') {
      content = stripGstackBoilerplate(content)
    }

    const finalContent = content.trim()
    contentCache[skillId] = finalContent
    return finalContent
  } catch (err) {
    console.warn(`[skills] Failed to load skill "${skillId}":`, err)
    return null
  }
}

/**
 * Strip gstack-specific boilerplate sections that reference
 * bash commands, filesystem operations, and telemetry.
 */
function stripGstackBoilerplate(content: string): string {
  // Sections to remove (match ## heading through next ## heading or end)
  const sectionsToStrip = [
    'Preamble \\(run first\\)',
    'AskUserQuestion Format',
    'Completeness Principle.*?Boil the Lake',
    'Repo Ownership Mode.*?See Something',
    'Search Before Building',
    'Contributor Mode',
    'Completion Status Protocol',
    'Telemetry \\(run last\\)',
    'SETUP \\(run this check.*?\\)',
  ]

  for (const section of sectionsToStrip) {
    const regex = new RegExp(`## ${section}[\\s\\S]*?(?=\\n## [^#]|$)`, 'i')
    content = content.replace(regex, '')
  }

  // Strip standalone bash code blocks that reference gstack binaries
  content = content.replace(/```bash\n[\s\S]*?gstack[\s\S]*?```/g, '')

  // Strip AUTO-GENERATED comments
  content = content.replace(/<!--\s*AUTO-GENERATED.*?-->/g, '')

  return content
}
