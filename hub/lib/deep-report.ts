/**
 * lib/deep-report.ts — parse a deep run's report (PR C).
 *
 * The run contract (lib/deep-runs.ts REPORT_CONTRACT) ends every report with
 * ONE trailing fenced ```json block carrying the structured summary. This
 * parser extracts and validates it; on any miss the caller renders the raw
 * markdown instead. Deliberately NOT the regex-scraping of
 * lib/parseToolArtifacts.ts — one fenced block, strict JSON, graceful
 * fallback (deep lane design §5).
 */

export interface DeepReportSection {
  heading: string
  body: string
}

export interface DeepReportSource {
  title: string
  url: string
}

export interface DeepReport {
  title: string
  summary: string
  sections: DeepReportSection[]
  sources: DeepReportSource[]
  /** The report markdown with the JSON block removed — what a reader reads. */
  markdown: string
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null
}

/**
 * Extract the LAST fenced json block and everything before it. Tolerates
 * trailing whitespace after the fence; refuses a block that is not at the
 * tail (text after it means the model kept talking — trust the markdown).
 */
export function parseDeepReport(resultMd: string | null | undefined): DeepReport | null {
  if (!resultMd) return null
  // Anchor at the LAST opening fence: a single regex over the whole text
  // would lazily span from the FIRST ```json to the final close whenever the
  // report body itself contains a json example block.
  const start = resultMd.lastIndexOf('```json')
  if (start === -1) return null
  const match = resultMd.slice(start).match(/^```json\s*\n([\s\S]*?)\n```\s*$/)
  if (!match) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(match[1])
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const obj = parsed as Record<string, unknown>
  const title = str(obj.title)
  const summary = str(obj.summary)
  if (!title || !summary) return null

  const sections: DeepReportSection[] = []
  if (Array.isArray(obj.sections)) {
    for (const raw of obj.sections) {
      if (typeof raw !== 'object' || raw === null) continue
      const s = raw as Record<string, unknown>
      const heading = str(s.heading)
      const body = str(s.body)
      if (heading && body) sections.push({ heading, body })
    }
  }

  const sources: DeepReportSource[] = []
  if (Array.isArray(obj.sources)) {
    for (const raw of obj.sources) {
      if (typeof raw !== 'object' || raw === null) continue
      const s = raw as Record<string, unknown>
      const title2 = str(s.title)
      const url = str(s.url)
      // http(s) only — these render as anchors.
      if (title2 && url && /^https?:\/\//.test(url)) sources.push({ title: title2, url })
    }
  }

  return {
    title,
    summary,
    sections,
    sources,
    markdown: resultMd.slice(0, start).trimEnd(),
  }
}
