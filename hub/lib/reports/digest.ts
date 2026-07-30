/**
 * Digest composition — analytics results in, report markdown out.
 *
 * Pure: takes already-fetched numbers and formats them. Keeping the formatting
 * separate from the fetching means the wording is unit-testable without any
 * network, and the same builder serves both the scheduled runner and an
 * on-demand "make me this week's digest" from chat.
 *
 * The markdown goes through the existing artifact engine
 * (`createDocFromMarkdown`), so headings, tables and lists arrive as real Doc
 * formatting rather than as a wall of text.
 */

import type { GA4ReportResult } from '../google/analytics'
import type { GSCQueryResult } from '../google/search-console'
import { normalizeDeckSpec, type DeckSpec } from '../google/deck-spec'

export interface DigestInput {
  title: string
  startDate: string
  endDate: string
  /** Site-wide totals for the window. */
  ga4?: GA4ReportResult
  /** Same metrics for the preceding window, for period-over-period deltas. */
  ga4Previous?: GA4ReportResult
  gsc?: GSCQueryResult
  /** Top pages by clicks, when fetched. */
  gscTopPages?: GSCQueryResult
  /** Reasons a section is missing (unconfigured source, failed call). */
  notes?: string[]
}

const num = (value: string | number | undefined): number => {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? '0'))
  return Number.isFinite(n) ? n : 0
}

const fmt = (n: number): string => {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}

/**
 * Period-over-period change.
 *
 * Returns an em dash rather than "+100%" or "∞" when the previous period was
 * zero: a percentage against nothing is not information, and printing one makes
 * a first week of data look like explosive growth.
 */
export function formatDelta(current: number, previous: number): string {
  if (!previous) return '—'
  const pct = ((current - previous) / previous) * 100
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`
}

/** Single-row GA4 totals keyed by metric name. */
function totals(report: GA4ReportResult | undefined): Record<string, number> {
  const row = report?.rows?.[0]
  if (!row) return {}
  const out: Record<string, number> = {}
  for (const metric of report?.metricHeaders ?? []) out[metric] = num(row[metric])
  return out
}

/** Aggregate Search Console rows into window totals. */
function gscTotals(result: GSCQueryResult | undefined): {
  clicks: number
  impressions: number
  position: number
} {
  const rows = result?.rows ?? []
  if (!rows.length) return { clicks: 0, impressions: 0, position: 0 }

  const clicks = rows.reduce((s, r) => s + r.clicks, 0)
  const impressions = rows.reduce((s, r) => s + r.impressions, 0)
  // Average position weighted by impressions — a plain mean would let a
  // one-impression page at position 1 outweigh the whole site.
  const weighted = rows.reduce((s, r) => s + r.position * r.impressions, 0)
  return { clicks, impressions, position: impressions ? weighted / impressions : 0 }
}

/**
 * Build the digest markdown.
 *
 * Missing sources are stated, not silently omitted. A digest that quietly drops
 * Search Console reads as "no search traffic" rather than "we couldn't reach
 * it", and the reader has no way to tell the difference.
 */
export function buildDigestMarkdown(input: DigestInput): string {
  const lines: string[] = [
    `# ${input.title}`,
    '',
    `**Reporting period:** ${input.startDate} → ${input.endDate}`,
    '',
  ]

  const ga4 = totals(input.ga4)
  const ga4Prev = totals(input.ga4Previous)

  if (Object.keys(ga4).length) {
    lines.push('## Website traffic', '', '| Metric | This period | Change |', '| --- | --- | --- |')
    for (const [metric, value] of Object.entries(ga4)) {
      lines.push(`| ${metric} | ${fmt(value)} | ${formatDelta(value, ga4Prev[metric] ?? 0)} |`)
    }
    lines.push('')
  }

  if (input.gsc) {
    const t = gscTotals(input.gsc)
    lines.push(
      '## Search performance',
      '',
      `- **Clicks:** ${fmt(t.clicks)}`,
      `- **Impressions:** ${fmt(t.impressions)}`,
      `- **Average position:** ${t.position.toFixed(1)}`,
      '',
    )
    if (input.gsc.anonymizedDataWarning) {
      lines.push(`> ${input.gsc.anonymizedDataWarning}`, '')
    }
  }

  const topRows = input.gscTopPages?.rows ?? []
  if (topRows.length) {
    lines.push('## Top pages by clicks', '', '| Page | Clicks | Impressions |', '| --- | --- | --- |')
    for (const row of topRows.slice(0, 10)) {
      lines.push(`| ${row.keys[0] ?? '—'} | ${fmt(row.clicks)} | ${fmt(row.impressions)} |`)
    }
    lines.push('')
  }

  if (input.notes?.length) {
    lines.push('## Notes', '', ...input.notes.map(n => `- ${n}`), '')
  }

  if (!Object.keys(ga4).length && !input.gsc && !topRows.length) {
    lines.push(
      'No analytics data was available for this period. An admin can choose a Google Analytics property and Search Console site under Settings → Analytics Sources.',
      '',
    )
  }

  lines.push('---', '', '_Generated automatically by the HUB Overlay._')
  return lines.join('\n')
}

/* ══════════════════════════════════════════
   Business review deck
   ══════════════════════════════════════════ */

/**
 * Build a deck outline from the same inputs as the markdown digest.
 *
 * `ReportKind` has always had a `business_review_deck` value, and both seeded
 * defaults set one — but the runner only ever built a Doc, so the monthly
 * "review deck" silently shipped as a second digest. Worse, when the 1st of the
 * month fell on a Monday both defaults came due in the same hour and admins got
 * two near-identical Docs. This is the missing branch.
 *
 * Pure, and deliberately expressed as a DeckSpec rather than as Slides requests:
 * the compiler (lib/google/slides-compiler.ts) owns the API mechanics, so this
 * only decides what goes on which slide.
 */
export function buildReviewDeckSpec(input: DigestInput): DeckSpec {
  const slides: Record<string, unknown>[] = [
    {
      layout: 'TITLE',
      title: input.title,
      bullets: [`${input.startDate} to ${input.endDate}`],
    },
  ]

  const current = totals(input.ga4)
  const previous = totals(input.ga4Previous)

  // One BIG_NUMBER slide per headline metric — the layout renders the figure
  // large, which is the whole point of a review deck versus a table.
  for (const [metric, value] of Object.entries(current)) {
    slides.push({
      layout: 'BIG_NUMBER',
      title: metric,
      bigNumber: fmt(value),
      bullets: [`${formatDelta(value, previous[metric] ?? 0)} vs. previous period`],
      speakerNotes: `${metric}: ${value} this period, ${previous[metric] ?? 0} previous.`,
    })
  }

  if (input.gsc) {
    const t = gscTotals(input.gsc)
    slides.push({
      layout: 'TITLE_AND_BODY',
      title: 'Search performance',
      bullets: [
        `Clicks: ${fmt(t.clicks)}`,
        `Impressions: ${fmt(t.impressions)}`,
        `Average position: ${t.position.toFixed(1)}`,
        ...(input.gsc.anonymizedDataWarning ? [input.gsc.anonymizedDataWarning] : []),
      ],
    })
  }

  const topRows = input.gscTopPages?.rows ?? []
  if (topRows.length) {
    slides.push({
      layout: 'TITLE_AND_BODY',
      title: 'Top pages by clicks',
      // Bullets cap at 7 per slide in the spec; normalizeDeckSpec would truncate
      // silently, so slice deliberately.
      bullets: topRows.slice(0, 7).map(r => `${r.keys[0] ?? '—'} — ${fmt(r.clicks)} clicks`),
    })
  }

  if (input.notes?.length) {
    slides.push({ layout: 'TITLE_AND_BODY', title: 'Notes', bullets: input.notes.slice(0, 7) })
  }

  if (slides.length === 1) {
    slides.push({
      layout: 'TITLE_AND_BODY',
      title: 'No data available',
      bullets: ['An admin can choose a GA4 property and Search Console site in Settings → Analytics Sources.'],
    })
  }

  return normalizeDeckSpec({ title: input.title, slides })
}
