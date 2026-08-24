/**
 * lib/deep-runs.ts — configuration + prompt composition for the deep lane
 * (docs/architecture/DEEP_LANE_2026-08-23.md §4-§5, PR B).
 *
 * A deep run = a user-confirmed brief, composed with the tool's protocol
 * into ONE self-contained agy prompt, executed as a work_item on the desktop
 * worker. The protocol prefers the tool's SKILL.md
 * (hub/skills/enterprise-ai/<tool>/SKILL.md, PR C) and falls back to the
 * built-in protocol below, so the lane is fully functional before the skill
 * files land and improves automatically when they do.
 *
 * Deadlines are TOTAL job lifetime (queue wait + execution): ≈ 2× the
 * intended run budget, so a run queued behind another doesn't lose its
 * execution window (design §4.2). The worker derives agy's own timeout from
 * what remains of the deadline at claim time.
 */

import type { JobDetail } from '@/lib/dispatch-store'
import type { ToolRunRecord } from '@/lib/tool-runs'
import { DEEP_TOOL_IDS } from '@/lib/skills'

export { DEEP_TOOL_IDS }
export type DeepToolId = (typeof DEEP_TOOL_IDS)[number]

export function isDeepToolId(v: unknown): v is DeepToolId {
  return typeof v === 'string' && (DEEP_TOOL_IDS as readonly string[]).includes(v)
}

interface DeepToolConfig {
  id: DeepToolId
  name: string
  /** Total job deadline (queue + run), ms. */
  deadlineMsDefault: number
  /** Env var that overrides the deadline (clamped 2–60 min). */
  deadlineEnv: string
  /** agy effort pin, carried in payload_meta for the worker. */
  effort?: 'low' | 'medium' | 'high'
  /** Built-in protocol used until/unless the tool's SKILL.md exists. */
  fallbackProtocol: string
}

const RESEARCH_PROTOCOL = `You are running Deep Research: a long-form, tool-using research run.
Work the brief with this protocol, in order:
1. DECOMPOSE the question into 3-6 sub-questions that together cover it (note any the brief rules out).
2. SEARCH: for each sub-question, run separate web searches/fetches. Prefer primary sources; capture publisher and date for everything you keep.
3. TRIANGULATE: where sources disagree, say so explicitly and weigh recency and authority. Never present a single source's claim as settled.
4. SYNTHESIZE a decision-oriented report: lead with the answer, then the evidence per sub-question, then what remains unknown.
Rules: cite every non-obvious claim inline as [n] against the source list. Label estimates as estimates. If the web tools fail entirely, say so plainly in the report instead of answering from memory.`

const THINK_PROTOCOL = `You are running Deep Think: a long-form deliberation run. Do NOT use web tools — this is reasoning over what is given.
Work the brief with this protocol, in order:
1. FRAMINGS: lay out the 2-4 genuinely different ways to frame the problem; name the assumptions each smuggles in.
2. STEELMAN: argue the strongest honest case for each leading option — strong enough that its advocate would sign it.
3. SELF-CRITIQUE: attack your own emerging conclusion; name the evidence that would change it.
4. CONCLUDE: one recommendation with an explicit confidence level, the load-bearing assumptions, and the cheapest test that would validate or kill it.
Rules: keep every step visible in the report — the reasoning is the product. Make disagreements between framings explicit rather than averaging them away.`

export const DEEP_TOOLS: Record<DeepToolId, DeepToolConfig> = {
  'deep-research': {
    id: 'deep-research',
    name: 'Deep Research',
    deadlineMsDefault: 30 * 60_000, // ~15 min run budget, 2× for queue wait
    deadlineEnv: 'DEEP_RESEARCH_DEADLINE_MS',
    fallbackProtocol: RESEARCH_PROTOCOL,
  },
  'deep-think': {
    id: 'deep-think',
    name: 'Deep Think',
    deadlineMsDefault: 16 * 60_000, // ~8 min run budget, 2× for queue wait
    deadlineEnv: 'DEEP_THINK_DEADLINE_MS',
    effort: 'high',
    fallbackProtocol: THINK_PROTOCOL,
  },
}

export function deepToolDeadlineMs(tool: DeepToolId): number {
  const cfg = DEEP_TOOLS[tool]
  const raw = Number(process.env[cfg.deadlineEnv])
  const ms = Number.isFinite(raw) && raw > 0 ? raw : cfg.deadlineMsDefault
  return Math.min(Math.max(ms, 2 * 60_000), 60 * 60_000)
}

export const BRIEF_MIN_CHARS = 3
export const BRIEF_MAX_CHARS = 8_000

export function briefError(brief: unknown): string | null {
  if (typeof brief !== 'string' || brief.trim().length < BRIEF_MIN_CHARS) {
    return `brief must be a string of at least ${BRIEF_MIN_CHARS} characters`
  }
  if (brief.length > BRIEF_MAX_CHARS) {
    return `brief must be at most ${BRIEF_MAX_CHARS} characters`
  }
  return null
}

/**
 * The output contract every deep run ends with. The report is plain
 * markdown; the machine-readable summary rides a trailing fenced JSON block
 * the panel parses — falling back to rendering the raw markdown when the
 * block is missing or malformed. Deliberately NOT the regex-scraping the
 * older tools use (design §5).
 */
export const REPORT_CONTRACT = `# Output contract
Write the full report in plain markdown (headings, lists, tables as needed).
Then end the reply with EXACTLY one fenced code block labeled json, shaped:
\`\`\`json
{"title": "...", "summary": "one-paragraph answer", "sections": [{"heading": "...", "body": "markdown"}], "sources": [{"title": "...", "url": "..."}]}
\`\`\`
"sources" may be an empty array when no external sources were used. Do not put anything after the JSON block.`

/**
 * Compose the single self-contained run prompt. Pure: the caller supplies
 * the SKILL.md body (or null → built-in protocol), so tests never touch fs.
 */
export function composeRunPrompt(tool: DeepToolId, brief: string, skillContent: string | null): string {
  const protocol = skillContent?.trim() || DEEP_TOOLS[tool].fallbackProtocol
  return [
    protocol,
    REPORT_CONTRACT,
    `# The brief\n${brief.trim()}`,
  ].join('\n\n')
}

/* ── Live-state derivation (design §4.5: state, never a percentage) ──────── */

/** How long a 'queued' row without a live job can claim to be queued before
 *  the view calls it what it is. Matches the store's active window. */
export const ORPHAN_AFTER_MS = 60 * 60_000

export interface DeepRunView extends ToolRunRecord {
  /** Presentation status: run status, or the live derivation while queued. */
  liveStatus: 'queued' | 'running' | 'finishing' | 'succeeded' | 'failed' | 'cancelled'
  liveAttempt?: number
  liveMaxAttempts?: number
  leaseFresh?: boolean
}

/**
 * PURE presentation of one run: tool_runs stores enqueue + terminal truth,
 * the dispatch job (fetched by the caller) owns execution state, and this
 * joins them into one honest view. agy emits nothing until a run completes,
 * so state is all there honestly is.
 */
export function deriveRunView(run: ToolRunRecord, job: JobDetail | null, now: number): DeepRunView {
  if (run.status !== 'queued') {
    return { ...run, liveStatus: run.status }
  }
  if (!job) {
    // Job row gone (TTL-deleted or the enqueue raced a crash). Recent →
    // still presentable as queued; old → say what it is instead of
    // pretending a dead run is waiting.
    const age = now - Date.parse(run.createdAt)
    if (age > ORPHAN_AFTER_MS) {
      return { ...run, liveStatus: 'failed', errorClass: run.errorClass ?? 'orphaned' }
    }
    return { ...run, liveStatus: 'queued' }
  }
  switch (job.state) {
    case 'queued':
      return { ...run, liveStatus: 'queued', liveAttempt: job.attempt, liveMaxAttempts: job.maxAttempts }
    case 'leased':
      return {
        ...run,
        liveStatus: 'running',
        liveAttempt: job.attempt,
        liveMaxAttempts: job.maxAttempts,
        leaseFresh: job.leaseExpiresAt !== null && job.leaseExpiresAt.getTime() > now,
      }
    case 'succeeded':
      // Landing is same-transaction with the job's terminal write, so this
      // window is a read-skew blink at most — the next poll shows terminal.
      return { ...run, liveStatus: 'finishing' }
    case 'cancelled':
      return { ...run, liveStatus: 'cancelled', errorClass: run.errorClass ?? job.errorClass }
    default: // failed | expired
      return { ...run, liveStatus: 'failed', errorClass: run.errorClass ?? job.errorClass, error: run.error ?? job.error }
  }
}
