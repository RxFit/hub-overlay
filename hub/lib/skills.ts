/**
 * Hub Skills Catalog — Client-safe metadata
 *
 * This file contains ONLY the static catalog metadata (no fs/path imports)
 * so it can be safely imported from both client and server components.
 *
 * For server-side skill content loading, use `hub/lib/skills-loader.ts`.
 */

export type SkillPlugin = 'gstack' | 'enterprise-ai'

export interface SkillDefinition {
  id: string
  name: string
  description: string
  plugin: SkillPlugin
}

/* ═══════════════════════════════════════════════════════════════════════════
   ENTERPRISE-AI SKILLS (12 entries including router)
   ═══════════════════════════════════════════════════════════════════════════ */

const enterpriseAiSkills: SkillDefinition[] = [
  { id: 'enterprise-ai', name: 'Enterprise AI Router', description: 'Suite of consulting, PM, strategy, prioritization, deck, and meeting-prep workflows', plugin: 'enterprise-ai' },
  { id: 'ai-use-case-scorer', name: 'AI Use Case Scorer', description: 'Score personal AI use cases on Value × Feasibility × Safety', plugin: 'enterprise-ai' },
  { id: 'data-insights', name: 'Data Insights', description: 'Analyze CSV or Excel data and produce plain-English insights on targets, trends, anomalies, and segments', plugin: 'enterprise-ai' },
  { id: 'decision-memo', name: 'Decision Memo', description: 'Draft a 1-page decision memo that forces a yes/no call: context, complication, options, recommendation, risks', plugin: 'enterprise-ai' },
  { id: 'deck-pipeline', name: 'Deck Pipeline', description: 'Four-step presentation workflow: strategist, builder, critic, fixer for high-stakes decks', plugin: 'enterprise-ai' },
  { id: 'gamma-deck', name: 'Gamma Deck', description: 'Generate a Gamma presentation from a storyline or content file', plugin: 'enterprise-ai' },
  { id: 'issue-tree', name: 'Issue Tree', description: 'Break complex problems into MECE branches and testable hypotheses', plugin: 'enterprise-ai' },
  { id: 'mckinsey-critic', name: 'McKinsey Critic', description: 'Review decks, memos, and strategies like a consulting engagement manager', plugin: 'enterprise-ai' },
  { id: 'meeting-prep', name: 'Meeting Prep', description: 'Prepare outcome-driven meetings with pre-read, agenda, talking points, and objection rebuttals', plugin: 'enterprise-ai' },
  { id: 'prioritization', name: 'Prioritization', description: 'Score features/tasks using RICE, impact/effort, value/complexity, or weighted scoring', plugin: 'enterprise-ai' },
  { id: 'scpr', name: 'SCPR Framework', description: 'Structure business arguments using Situation, Complication, Problem, Recommendation', plugin: 'enterprise-ai' },
  { id: 'storyline', name: 'Storyline Builder', description: 'Create claim-based presentation storylines where each line becomes a slide title', plugin: 'enterprise-ai' },
]

/* ═══════════════════════════════════════════════════════════════════════════
   GSTACK SKILLS (27 entries)
   ═══════════════════════════════════════════════════════════════════════════ */

const gstackSkills: SkillDefinition[] = [
  { id: 'autoplan', name: 'Auto Plan', description: 'Auto-review pipeline — runs CEO, design, and eng review skills sequentially', plugin: 'gstack' },
  { id: 'benchmark', name: 'Benchmark', description: 'Performance regression detection for page load times and Core Web Vitals', plugin: 'gstack' },
  { id: 'browse', name: 'Browse', description: 'Fast headless browser for QA testing and site dogfooding', plugin: 'gstack' },
  { id: 'canary', name: 'Canary', description: 'Post-deploy canary monitoring — watches for console errors and performance regressions', plugin: 'gstack' },
  { id: 'careful', name: 'Careful', description: 'Safety guardrails for destructive commands', plugin: 'gstack' },
  { id: 'codex', name: 'Codex', description: 'OpenAI Codex CLI wrapper — code review, chat mode, and task execution', plugin: 'gstack' },
  { id: 'cso', name: 'CSO (Security)', description: 'Chief Security Officer mode — OWASP Top 10 audit, STRIDE threat modeling', plugin: 'gstack' },
  { id: 'design-consultation', name: 'Design Consultation', description: 'Understand your product and propose a complete design system', plugin: 'gstack' },
  { id: 'design-review', name: 'Design Review', description: 'Designer\'s eye QA — visual inconsistency, spacing, hierarchy, AI slop patterns', plugin: 'gstack' },
  { id: 'document-release', name: 'Document Release', description: 'Post-ship documentation update — cross-references diff with README and ARCHITECTURE', plugin: 'gstack' },
  { id: 'freeze', name: 'Freeze', description: 'Restrict file edits to a specific directory for the session', plugin: 'gstack' },
  { id: 'gstack-upgrade', name: 'Upgrade', description: 'Upgrade gstack to the latest version', plugin: 'gstack' },
  { id: 'guard', name: 'Guard', description: 'Full safety mode — destructive command warnings + directory-scoped edits', plugin: 'gstack' },
  { id: 'investigate', name: 'Investigate', description: 'Systematic debugging — four phases: investigate, analyze, hypothesize, implement', plugin: 'gstack' },
  { id: 'land-and-deploy', name: 'Land & Deploy', description: 'Merge PR, wait for CI, verify production health via canary checks', plugin: 'gstack' },
  { id: 'office-hours', name: 'Office Hours', description: 'YC Office Hours — startup diagnostic or builder-mode design thinking brainstorming', plugin: 'gstack' },
  { id: 'plan-ceo-review', name: 'CEO Review', description: 'CEO/founder-mode plan review — rethink the problem, find the 10-star product', plugin: 'gstack' },
  { id: 'plan-design-review', name: 'Design Plan Review', description: 'Designer\'s eye plan review — rates each design dimension 0-10', plugin: 'gstack' },
  { id: 'plan-eng-review', name: 'Engineering Review', description: 'Eng manager-mode plan review — architecture, data flow, edge cases, test coverage', plugin: 'gstack' },
  { id: 'qa', name: 'QA', description: 'Systematically QA test a web application and fix bugs found', plugin: 'gstack' },
  { id: 'qa-only', name: 'QA Report', description: 'Report-only QA testing — structured report with health score and screenshots', plugin: 'gstack' },
  { id: 'retro', name: 'Retrospective', description: 'Weekly engineering retrospective — commit history, work patterns, code quality metrics', plugin: 'gstack' },
  { id: 'review', name: 'Code Review', description: 'Pre-landing PR review — SQL safety, LLM trust boundaries, test coverage', plugin: 'gstack' },
  { id: 'setup-browser-cookies', name: 'Browser Cookies', description: 'Import cookies from your browser into headless browse session', plugin: 'gstack' },
  { id: 'setup-deploy', name: 'Deploy Setup', description: 'Configure deployment settings — detects your platform (Fly, Render, Vercel, etc.)', plugin: 'gstack' },
  { id: 'ship', name: 'Ship', description: 'Ship workflow — merge, test, review diff, bump VERSION, update CHANGELOG, push, create PR', plugin: 'gstack' },
  { id: 'unfreeze', name: 'Unfreeze', description: 'Clear the freeze boundary — allows edits to all directories again', plugin: 'gstack' },
]

/* ═══════════════════════════════════════════════════════════════════════════
   EXPORTS
   ═══════════════════════════════════════════════════════════════════════════ */

export const SKILL_CATALOG: SkillDefinition[] = [...enterpriseAiSkills, ...gstackSkills]

export const SKILL_MAP: Record<string, SkillDefinition> = Object.fromEntries(
  SKILL_CATALOG.map(s => [s.id, s])
)

/** Lightweight catalog string for system prompt injection (names + descriptions only) */
export const SKILL_CATALOG_PROMPT = SKILL_CATALOG
  .map(s => `- **${s.id}** (${s.plugin}): ${s.description}`)
  .join('\n')
