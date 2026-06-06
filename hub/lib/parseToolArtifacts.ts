import type { ToolArtifactData, ToolArtifactSection } from '@/types'

type SectionType = ToolArtifactSection['type']

/** Matches a regex against combined assistant text; returns extracted sections. */
type ToolParser = (text: string, nextId: () => string) => ToolArtifactSection[]

/**
 * Multi-line non-greedy capture: [\s\S]+? is the ES5-safe equivalent
 * of .+? with the `s` (dotAll) flag. The project tsconfig targets ES5,
 * so we avoid the `s` flag entirely.
 */

/* ── Per-tool parsers ──────────────────────────────────────────────────────── */

const parsers: Record<string, ToolParser> = {
  'issue-tree': (text, nextId) => {
    const sections: ToolArtifactSection[] = []
    match(text, /Governing Question:\s*(.+)/gi, (m) =>
      sections.push(sec(nextId(), 'generic', 'Governing Question', m[1])))
    match(text, /(?:Branch [A-Z]|Level 1 Branch)[:\s]*(.+?)(?:\n|$)/gi, (m) =>
      sections.push(sec(nextId(), 'branch', m[0].split(':')[0].trim(), m[1])))
    match(text, /Hypothesis [A-Z]\d?[:\s]*(.+?)(?:\n|$)/gi, (m) =>
      sections.push(sec(nextId(), 'hypothesis', m[0].split(':')[0].trim(), m[1])))
    match(text, /MECE Check[:\s]*([\s\S]+?)(?:\n\n|$)/gi, (m) =>
      sections.push(sec(nextId(), 'critique', 'MECE Check', m[1])))
    match(text, /Recommended First Branch[:\s]*(.+?)(?:\n|$)/gi, (m) =>
      sections.push(sec(nextId(), 'recommendation', 'Recommended First Branch', m[1], 'recommended')))
    return sections
  },

  'decision-memo': (text, nextId) => {
    const sections: ToolArtifactSection[] = []
    match(text, /Context[:\s]*([\s\S]+?)(?:\n\n|$)/gi, (m) =>
      sections.push(sec(nextId(), 'generic', 'Context', m[1])))
    match(text, /Option [1-3][:\s]*([\s\S]+?)(?:\n\n|$)/gi, (m) =>
      sections.push(sec(nextId(), 'branch', m[0].split(':')[0].trim(), m[1])))
    match(text, /Pro[:\s]*(.+?)(?:\n|$)/gi, (m) =>
      sections.push(sec(nextId(), 'pro', 'Pro', m[1])))
    match(text, /Con[:\s]*(.+?)(?:\n|$)/gi, (m) =>
      sections.push(sec(nextId(), 'con', 'Con', m[1])))
    match(text, /Recommendation[:\s]*([\s\S]+?)(?:\n\n|$)/gi, (m) =>
      sections.push(sec(nextId(), 'recommendation', 'Recommendation', m[1], 'recommended')))
    match(text, /Risks?[:\s]*([\s\S]+?)(?:\n\n|$)/gi, (m) =>
      sections.push(sec(nextId(), 'critique', 'Risks', m[1], 'warning')))
    match(text, /Ask[:\s]*(.+?)(?:\n|$)/gi, (m) =>
      sections.push(sec(nextId(), 'generic', 'Ask', m[1])))
    return sections
  },

  'prioritization': (text, nextId) => {
    const sections: ToolArtifactSection[] = []
    match(text, /(?:Rank|#)\s*\d+[:\s]*(.+?)(?:\n|$)/gi, (m) =>
      sections.push(sec(nextId(), 'step', m[0].split(':')[0].trim(), m[1])))
    match(text, /Score[:\s]*(\d[\d.]*)/gi, (m) =>
      sections.push(sec(nextId(), 'score', 'Score', m[1], undefined, parseFloat(m[1]))))
    match(text, /Recommendation[:\s]*([\s\S]+?)(?:\n\n|$)/gi, (m) =>
      sections.push(sec(nextId(), 'recommendation', 'Recommendation', m[1], 'recommended')))
    return sections
  },

  'scpr': (text, nextId) => {
    const sections: ToolArtifactSection[] = []
    match(text, /Situation[:\s]*([\s\S]+?)(?:\n\n|$)/gi, (m) =>
      sections.push(sec(nextId(), 'generic', 'Situation', m[1])))
    match(text, /Complication[:\s]*([\s\S]+?)(?:\n\n|$)/gi, (m) =>
      sections.push(sec(nextId(), 'critique', 'Complication', m[1], 'warning')))
    match(text, /(?:Promise|Problem)[:\s]*([\s\S]+?)(?:\n\n|$)/gi, (m) =>
      sections.push(sec(nextId(), 'generic', 'Promise', m[1])))
    match(text, /(?:Resolution|Recommendation)[:\s]*([\s\S]+?)(?:\n\n|$)/gi, (m) =>
      sections.push(sec(nextId(), 'recommendation', 'Resolution', m[1], 'recommended')))
    return sections
  },

  'storyline': (text, nextId) => {
    const sections: ToolArtifactSection[] = []
    match(text, /Governing Thought[:\s]*([\s\S]+?)(?:\n\n|$)/gi, (m) =>
      sections.push(sec(nextId(), 'narrative', 'Governing Thought', m[1])))
    match(text, /Slide \d+[:\s]*([\s\S]+?)(?:\n\n|$)/gi, (m) =>
      sections.push(sec(nextId(), 'slide', m[0].split(':')[0].trim(), m[1])))
    match(text, /Narrative Block[:\s]*([\s\S]+?)(?:\n\n|$)/gi, (m) =>
      sections.push(sec(nextId(), 'narrative', 'Narrative Block', m[1])))
    return sections
  },

  'meeting-prep': (text, nextId) => {
    const sections: ToolArtifactSection[] = []
    match(text, /Agenda[:\s]*([\s\S]+?)(?:\n\n|$)/gi, (m) =>
      sections.push(sec(nextId(), 'generic', 'Agenda', m[1])))
    match(text, /Attendee[:\s]*(.+?)(?:\n|$)/gi, (m) =>
      sections.push(sec(nextId(), 'generic', 'Attendee', m[1])))
    match(text, /Talking Point[:\s]*(.+?)(?:\n|$)/gi, (m) =>
      sections.push(sec(nextId(), 'step', 'Talking Point', m[1])))
    match(text, /Objection[:\s]*([\s\S]+?)(?:\n\n|$)/gi, (m) =>
      sections.push(sec(nextId(), 'critique', 'Objection', m[1], 'warning')))
    return sections
  },

  'mckinsey-critic': (text, nextId) => {
    const sections: ToolArtifactSection[] = []
    match(text, /Grade[:\s]*(.+?)(?:\n|$)/gi, (m) =>
      sections.push(sec(nextId(), 'score', 'Grade', m[1])))
    match(text, /Verdict[:\s]*([\s\S]+?)(?:\n\n|$)/gi, (m) =>
      sections.push(sec(nextId(), 'recommendation', 'Verdict', m[1])))
    match(text, /Fix \d+[:\s]*([\s\S]+?)(?:\n\n|$)/gi, (m) =>
      sections.push(sec(nextId(), 'critique', m[0].split(':')[0].trim(), m[1], 'warning')))
    match(text, /Section Review[:\s]*([\s\S]+?)(?:\n\n|$)/gi, (m) =>
      sections.push(sec(nextId(), 'critique', 'Section Review', m[1])))
    return sections
  },

  'ai-use-case-scorer': (text, nextId) => {
    const sections: ToolArtifactSection[] = []
    match(text, /Use Case[:\s]*(.+?)(?:\n|$)/gi, (m) =>
      sections.push(sec(nextId(), 'generic', 'Use Case', m[1])))
    match(text, /Score[:\s]*(\d[\d.]*)/gi, (m) =>
      sections.push(sec(nextId(), 'score', 'Score', m[1], undefined, parseFloat(m[1]))))
    match(text, /Tier[:\s]*(.+?)(?:\n|$)/gi, (m) =>
      sections.push(sec(nextId(), 'generic', 'Tier', m[1])))
    match(text, /Do Now[:\s]*([\s\S]+?)(?:\n\n|$)/gi, (m) =>
      sections.push(sec(nextId(), 'recommendation', 'Do Now', m[1], 'recommended')))
    match(text, /Park[:\s]*([\s\S]+?)(?:\n\n|$)/gi, (m) =>
      sections.push(sec(nextId(), 'generic', 'Park', m[1])))
    match(text, /Avoid[:\s]*([\s\S]+?)(?:\n\n|$)/gi, (m) =>
      sections.push(sec(nextId(), 'critique', 'Avoid', m[1], 'warning')))
    return sections
  },

  'deck-pipeline': (text, nextId) => {
    const sections: ToolArtifactSection[] = []
    match(text, /Step \d+[:\s]*([\s\S]+?)(?:\n\n|$)/gi, (m) =>
      sections.push(sec(nextId(), 'step', m[0].split(':')[0].trim(), m[1])))
    for (const role of ['Strategist', 'Builder', 'Critic', 'Fixer']) {
      match(text, new RegExp(role + '[:\\s]*([\\s\\S]+?)(?:\\n\\n|$)', 'gi'), (m) =>
        sections.push(sec(nextId(), 'generic', role, m[1])))
    }
    match(text, /Slide[:\s]*([\s\S]+?)(?:\n\n|$)/gi, (m) =>
      sections.push(sec(nextId(), 'slide', 'Slide', m[1])))
    return sections
  },

  'gamma-deck': (text, nextId) => {
    const sections: ToolArtifactSection[] = []
    match(text, /Slide \d+[:\s]*([\s\S]+?)(?:\n\n|$)/gi, (m) =>
      sections.push(sec(nextId(), 'slide', m[0].split(':')[0].trim(), m[1])))
    match(text, /Theme[:\s]*(.+?)(?:\n|$)/gi, (m) =>
      sections.push(sec(nextId(), 'generic', 'Theme', m[1])))
    match(text, /Status[:\s]*(.+?)(?:\n|$)/gi, (m) =>
      sections.push(sec(nextId(), 'generic', 'Status', m[1])))
    return sections
  },

  'data-insights': (text, nextId) => {
    const sections: ToolArtifactSection[] = []
    match(text, /Insight \d+[:\s]*([\s\S]+?)(?:\n\n|$)/gi, (m) =>
      sections.push(sec(nextId(), 'insight', m[0].split(':')[0].trim(), m[1])))
    match(text, /Metric[:\s]*(.+?)(?:\n|$)/gi, (m) =>
      sections.push(sec(nextId(), 'score', 'Metric', m[1])))
    match(text, /Trend[:\s]*(.+?)(?:\n|$)/gi, (m) =>
      sections.push(sec(nextId(), 'insight', 'Trend', m[1])))
    return sections
  },
}

/* ── Public API ────────────────────────────────────────────────────────────── */

/**
 * Scan assistant messages for structured patterns matching the given toolId.
 * Returns a ToolArtifactData object if any patterns match, otherwise null.
 */
export function parseToolArtifacts(
  toolId: string,
  messages: Array<{ role: string; content: string }>,
): ToolArtifactData | null {
  const parser = parsers[toolId]
  if (!parser) return null

  /* Concatenate all assistant messages into a single searchable text block */
  const assistantText = messages
    .filter((m) => m.role === 'assistant')
    .map((m) => m.content)
    .join('\n\n')

  if (!assistantText.trim()) return null

  let counter = 0
  const nextId = () => `${toolId}-sec-${++counter}`

  const sections = parser(assistantText, nextId)
  if (sections.length === 0) return null

  /* Auto-generate a title from the first meaningful section heading */
  const title = deriveTitle(toolId, sections, assistantText)

  return { toolId, title, sections }
}

/* ── Helpers ───────────────────────────────────────────────────────────────── */

/** Run a regex against text, calling `cb` for each match. */
function match(text: string, re: RegExp, cb: (m: RegExpExecArray) => void) {
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) cb(m)
}

/** Build a ToolArtifactSection with optional status and score. */
function sec(
  id: string,
  type: SectionType,
  title: string,
  content: string,
  status?: ToolArtifactSection['status'],
  score?: number,
): ToolArtifactSection {
  const s: ToolArtifactSection = { id, type, title, content: content.trim() }
  if (status) s.status = status
  if (score !== undefined) s.score = score
  return s
}

/** Derive a human-readable title from the parsed output. */
function deriveTitle(
  toolId: string,
  sections: ToolArtifactSection[],
  fullText: string,
): string {
  /* Prefer specific anchors per tool type */
  const govQ = fullText.match(/Governing Question:\s*(.+)/i)
  if (govQ) return govQ[1].trim().slice(0, 80)

  const govT = fullText.match(/Governing Thought:\s*(.+)/i)
  if (govT) return govT[1].trim().slice(0, 80)

  /* Fall back to the first section's title + abbreviated content */
  const first = sections[0]
  if (first) {
    const preview = first.content.slice(0, 60)
    return `${first.title}: ${preview}${first.content.length > 60 ? '…' : ''}`
  }

  /* Last resort: use the tool name */
  return toolId.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}
