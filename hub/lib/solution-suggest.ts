/* ══════════════════════════════════════════════════════════════════════════
   SOLUTION SUGGEST — "Paperclip as a solution" proactive suggestion engine
   (Phase 6a, deterministic detector. See docs/architecture/PHASE6_*.md)

   Pure, client-safe module. Given a detected Interview Mode intent + the
   user's message, decides whether a Paperclip primitive (routine / delegated
   issue / project / goal) is a better solution than the plain action the user
   asked for — and builds the prefill to open the matching gated interview.

   The engine only PROPOSES. Creation always flows through the existing
   interview → context-sufficiency gate → gate token → proxy role tiers. A
   suggestion carries zero new write privileges.
   ══════════════════════════════════════════════════════════════════════════ */

import type { InterviewIntent } from '@/types'

export type SolutionPrimitive = 'routine' | 'issue' | 'project' | 'goal'

export interface SolutionSuggestion {
  /** Stable id for React keys / telemetry. */
  id: string
  primitive: SolutionPrimitive
  /** The gated interview to open on accept. */
  targetIntent: InterviewIntent
  /** Card copy. */
  headline: string
  body: string
  acceptLabel: string
  /** Prefill for the target interview's context (keys match its sequence). */
  prefill: Record<string, string>
  /** primitive × topic — stable across rephrasings, for dismissal memory. */
  dismissKey: string
  /** 0..1 — deterministic matches are high; a display threshold gates the rest. */
  confidence: number
  source: 'deterministic'
}

/* ── Recurrence detection ─────────────────────────────────────────────────
   Turns natural-language cadence into a cron expression for the routine
   prefill. Conservative: only returns a schedule when the phrasing is
   clearly recurring, so we never mis-offer a routine for a one-off task. */

export interface Recurrence {
  isRecurring: boolean
  /** 5-field cron when derivable, else null (routine can still be manual). */
  cron: string | null
  /** Human echo for the card body, e.g. "every day at 9am". */
  phrase: string | null
}

const DAY_OF_WEEK: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6,
}

const RECURRING_RE =
  /\b(every|each|daily|weekly|hourly|monthly|recurring|repeat(?:ing|edly)?|routine|each morning|every morning|weekdays?|on\s+(?:mon|tue|wed|thu|fri|sat|sun))\b/i

/**
 * Parse a clock time from text → [hour, minute] in 24h, or null.
 * Handles "9am", "9:30 am", "at 17:00", "noon", "midnight".
 */
function parseTime(text: string): [number, number] | null {
  const t = text.toLowerCase()
  if (/\bnoon\b/.test(t)) return [12, 0]
  if (/\bmidnight\b/.test(t)) return [0, 0]
  // Prefer an explicit time expression so a stray count ("check 3 metrics
  // every day at 9am") never anchors the schedule at 3am. In priority order:
  // (1) a time with am/pm, (2) an "at <time>" phrase. We do NOT guess from a
  // bare number — the caller defaults to 9am when no clear time is present.
  const m =
    t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/) ||
    t.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\b/)
  if (!m) return null
  let hour = parseInt(m[1], 10)
  const minute = m[2] ? parseInt(m[2], 10) : 0
  const mer = m[3]
  if (hour > 23 || minute > 59) return null
  if (mer === 'pm' && hour < 12) hour += 12
  if (mer === 'am' && hour === 12) hour = 0
  return [hour, minute]
}

export function detectRecurrence(message: string): Recurrence {
  const text = message.toLowerCase()
  if (!RECURRING_RE.test(text)) return { isRecurring: false, cron: null, phrase: null }

  const time = parseTime(text)
  const [hour, minute] = time ?? [9, 0] // default 9am when a cadence is named without a clock
  const timePhrase = time
    ? ` at ${hour % 12 === 0 ? 12 : hour % 12}${minute ? ':' + String(minute).padStart(2, '0') : ''}${hour < 12 ? 'am' : 'pm'}`
    : ''

  // Specific weekday → weekly on that day
  for (const [name, dow] of Object.entries(DAY_OF_WEEK)) {
    // Word-boundary match; skip 3-letter prefixes colliding with other words
    const re = new RegExp(`\\b(?:every|each|on)\\s+${name}s?\\b`, 'i')
    if (re.test(text)) {
      return { isRecurring: true, cron: `${minute} ${hour} * * ${dow}`, phrase: `every ${name}${timePhrase}` }
    }
  }

  if (/\bweekdays?\b/.test(text)) {
    return { isRecurring: true, cron: `${minute} ${hour} * * 1-5`, phrase: `every weekday${timePhrase}` }
  }
  if (/\bhourly\b|\bevery\s+hour\b/.test(text)) {
    return { isRecurring: true, cron: `0 * * * *`, phrase: 'every hour' }
  }
  if (/\bmonthly\b|\bevery\s+month\b/.test(text)) {
    return { isRecurring: true, cron: `${minute} ${hour} 1 * *`, phrase: `monthly${timePhrase}` }
  }
  if (/\bweekly\b|\bevery\s+week\b/.test(text)) {
    return { isRecurring: true, cron: `${minute} ${hour} * * 1`, phrase: `every week${timePhrase}` }
  }
  if (/\bdaily\b|\bevery\s+day\b|\b(?:each|every)\s+morning\b/.test(text)) {
    return { isRecurring: true, cron: `${minute} ${hour} * * *`, phrase: `every day${timePhrase}` }
  }
  // Recurrence word present but cadence unclear → recurring, manual schedule.
  return { isRecurring: true, cron: null, phrase: 'on a recurring basis' }
}

/* ── Agent-doable detection ───────────────────────────────────────────────
   Verbs that describe work an AGENT could perform (not just a reminder). If
   the user is asking to be reminded to DO something an agent could do itself,
   we can offer to have the agent do it. */

const AGENT_VERB_RE =
  /\b(check|monitor|track|review|audit|reconcile|summari[sz]e|report|generate|compile|pull|fetch|scan|analy[sz]e|update|post|send|email|draft|watch|collect|gather|compare|calculate|log)\b/i

/* Aspirational / goal phrasing. */
const GOAL_RE =
  /\b(our goal is|the goal is|we (?:need|want) to (?:reach|hit|get to|grow|achieve)|by (?:q[1-4]|end of|next)|target of|aiming (?:for|to)|mission to)\b/i

/* Multi-step deliverable phrasing → project. */
const PROJECT_RE =
  /\b(launch|build|ship|migrate|redesign|roll out|set up (?:a|the) (?:system|pipeline|campaign)|end[- ]to[- ]end|multi[- ]step|campaign|overhaul|implement)\b/i

/* Delivery-channel hints so the routine prefill can name where results go. */
function detectDeliveryChannel(text: string): string | null {
  const t = text.toLowerCase()
  if (/\bgoogle chat|g[- ]?chat\b/.test(t)) return 'Google Chat'
  if (/\bslack\b/.test(t)) return 'Slack'
  if (/\bemail|gmail\b/.test(t)) return 'email'
  if (/\bchat\b/.test(t)) return 'Google Chat'
  return null
}

/* ── Topic hashing (for dismissal memory) ─────────────────────────────────
   Normalize to the salient content words so "check token usage every day"
   and "check the token usage daily" collapse to the same dismiss key, but
   "check SEO rankings" does not. */

const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'me', 'my', 'i', 'we', 'our', 'us', 'on', 'in', 'at', 'of', 'for',
  'and', 'or', 'every', 'each', 'day', 'daily', 'week', 'weekly', 'hour', 'hourly', 'month',
  'monthly', 'morning', 'set', 'create', 'add', 'make', 'remind', 'reminder', 'task', 'please',
  'can', 'you', 'would', 'could', 'want', 'need', 'am', 'pm', 'that', 'this', 'it', 'so', 'up',
  'with', 'send', 'results', 'recurring', 'routine', 'schedule', 'scheduled',
])

export function topicHash(message: string): string {
  const words = message
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    // Drop digit-led tokens (clock times like "9am", counts) so a schedule
    // change never fragments the dismiss key.
    .filter((w) => w.length > 2 && !STOPWORDS.has(w) && !/^\d/.test(w))
  // Stable, order-independent: sort unique salient words, take up to 5.
  const key = Array.from(new Set(words)).sort().slice(0, 5).join('-')
  return key || 'general'
}

/* ── The upgrade table ────────────────────────────────────────────────────
   Given a detected intent and the message, produce at most one suggestion.
   Ordered by value: recurring automation > agent delegation > project > goal.
   Only fires for a small set of "upgradeable" intents so we never suggest on
   an action that is already the right tool (e.g. delete_agent). */

const UPGRADEABLE_INTENTS = new Set<InterviewIntent>([
  'create_task',
  'update_task',
  'schedule_event',
  'send_communication',
  'create_paperclip_issue',
])

export function deriveSolutionSuggestion(
  intent: InterviewIntent | null,
  message: string,
): SolutionSuggestion | null {
  if (!intent || !UPGRADEABLE_INTENTS.has(intent)) return null

  const recurrence = detectRecurrence(message)
  const agentDoable = AGENT_VERB_RE.test(message)
  const channel = detectDeliveryChannel(message)
  const topic = topicHash(message)

  // 1) Recurring + agent-doable → the flagship: a routine an agent runs and
  //    reports back. (The user's canonical example.)
  if (recurrence.isRecurring && agentDoable && intent !== 'create_paperclip_issue') {
    const deliver = channel ?? 'Google Chat'
    const schedulePhrase = recurrence.phrase ?? 'on a schedule'
    return {
      id: `sol-routine-${topic}`,
      primitive: 'routine',
      targetIntent: 'create_routine',
      headline: 'Automate this with a Paperclip routine?',
      body: `Instead of a reminder, a Paperclip agent can do this ${schedulePhrase} and send you the results in ${deliver}. You'd never touch it manually.`,
      acceptLabel: 'Set up the routine',
      prefill: {
        description: `${message.trim()} — then post the results to ${deliver}.`,
        ...(recurrence.cron ? { schedule: recurrence.cron } : {}),
      },
      dismissKey: `routine:${topic}`,
      confidence: 0.9,
      source: 'deterministic',
    }
  }

  // 2) Recurring reminder (not obviously agent-doable) → still offer a routine,
  //    lower confidence, no schedule assumption beyond what we parsed.
  if (recurrence.isRecurring && (intent === 'create_task' || intent === 'schedule_event')) {
    const schedulePhrase = recurrence.phrase ?? 'on a schedule'
    return {
      id: `sol-routine-lite-${topic}`,
      primitive: 'routine',
      targetIntent: 'create_routine',
      headline: 'Make this a recurring Paperclip routine?',
      body: `A Paperclip routine can run this ${schedulePhrase} with an agent owner, so it happens automatically and shows up in your Routines tab.`,
      acceptLabel: 'Set up the routine',
      prefill: {
        description: message.trim(),
        ...(recurrence.cron ? { schedule: recurrence.cron } : {}),
      },
      dismissKey: `routine:${topic}`,
      confidence: 0.75,
      source: 'deterministic',
    }
  }

  // 3) One-off but clearly agent-doable work framed as a personal task →
  //    delegate it to an agent as a Paperclip issue.
  if (agentDoable && (intent === 'create_task' || intent === 'update_task' || intent === 'send_communication')) {
    return {
      id: `sol-issue-${topic}`,
      primitive: 'issue',
      targetIntent: 'create_paperclip_issue',
      headline: 'Hand this to an agent instead?',
      body: `This looks like work a Paperclip agent could just do for you. Want to delegate it as an issue and track the result in the Execution feed?`,
      acceptLabel: 'Delegate to an agent',
      prefill: { description: message.trim() },
      dismissKey: `issue:${topic}`,
      confidence: 0.7,
      source: 'deterministic',
    }
  }

  // 4) Multi-step deliverable → a project groups the work + its workspace.
  if (PROJECT_RE.test(message) && (intent === 'create_task' || intent === 'create_paperclip_issue')) {
    return {
      id: `sol-project-${topic}`,
      primitive: 'project',
      targetIntent: 'create_paperclip_issue',
      headline: 'This looks like a project.',
      body: `A multi-step effort like this fits a Paperclip project — a container for its issues, goals, and workspace. Want to frame it that way so the work traces back to one place?`,
      acceptLabel: 'Delegate the first issue',
      prefill: { description: message.trim() },
      dismissKey: `project:${topic}`,
      confidence: 0.6,
      source: 'deterministic',
    }
  }

  // 5) Aspirational phrasing → capture it in the goal tree.
  if (GOAL_RE.test(message)) {
    return {
      id: `sol-goal-${topic}`,
      primitive: 'goal',
      targetIntent: 'create_goal',
      headline: 'Capture this as a goal?',
      body: `Adding this to your Paperclip goal tree means every agent task can trace back to it — agents see the "why", not just the "what".`,
      acceptLabel: 'Create the goal',
      prefill: { description: message.trim() },
      dismissKey: `goal:${topic}`,
      confidence: 0.6,
      source: 'deterministic',
    }
  }

  return null
}
