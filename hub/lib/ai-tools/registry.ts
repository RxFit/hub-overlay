/**
 * Read-tool registry — the tools the model may run to ANSWER a question.
 *
 * ── Why reads need a different path from writes ──
 * Every write in the Hub goes through intent → interview → confirm card → gate
 * token → audit, and should keep doing so. That pipeline is wrong for reads:
 * "how did organic traffic do last month?" should be answered, not negotiated
 * through a three-question interview. So reads get this registry instead.
 *
 * ── Read-only BY CONSTRUCTION, not by convention ──
 * The safety property that makes auto-execution acceptable is that nothing
 * reachable from here can mutate anything. Each entry wires up to a GET or to a
 * reporting endpoint that only queries. There is deliberately no mechanism to
 * register a mutating tool: adding one would mean adding an executor that calls
 * a write API, which is a reviewable change, not a config toggle.
 *
 * The registry is the single source for three things that must not drift apart:
 *   (a) the function declarations handed to the model,
 *   (b) executor dispatch,
 *   (c) role gating.
 * Deriving all three from one table is what keeps a tool from being advertised
 * to the model but unrunnable, or runnable but ungated.
 */

import { z } from 'zod'
import { runGA4Report, reportToSheetRows } from '../google/analytics'
import { querySearchConsole, GSC_DIMENSIONS, resultToSheetRows, type GSCDimension } from '../google/search-console'
import { fenceUntrusted } from '../prompt-safety'
import { searchDriveWithContents, searchChatHistory } from './workspace-search'
import { queryFreeBusy } from '../google/calendar'
import type { ChatSpacePreferences } from '../chat-spaces'

/** Tool groups keep each request's advertised tool set small — model providers
 *  degrade at picking from long tool lists, so a request carries only the group
 *  its question needs. */
export type ToolGroup = 'analytics' | 'workspace' | 'none'

export type ToolRole = 'staff' | 'admin' | 'superadmin'

const ROLE_RANK: Record<string, number> = { onboarding: 0, staff: 1, admin: 2, superadmin: 3 }

/** True when `role` meets or exceeds `required`. */
export function roleAllows(role: string | undefined, required: ToolRole): boolean {
  return (ROLE_RANK[role ?? ''] ?? 0) >= ROLE_RANK[required]
}

export interface ToolContext {
  accessToken: string
  role: string
  /** Resolved per-tenant analytics targets. A tool whose target is unset
   *  reports that as a result, rather than throwing. */
  ga4PropertyId?: string
  gscSiteUrl?: string
  /** The user's Chat space visibility choices. A space they hid from the panel
   *  must not be readable by the assistant either. */
  chatSpacePreferences?: ChatSpacePreferences
  /** Injectable for tests. */
  today?: Date
}

export interface ToolResult {
  /** One line of plain prose the UI can show as a status/caption. */
  summary: string
  /** Fenced, model-facing payload. ALWAYS passed through fenceUntrusted. */
  fenced: string
  /** Tabular form for "export to Sheet" / rendering, when applicable. */
  rows?: string[][]
  /** Set when the tool could not run for a benign, explainable reason
   *  (nothing configured, empty result) rather than an error. */
  note?: string
}

export interface ReadTool {
  name: string
  description: string
  group: ToolGroup
  minRole: ToolRole
  /** Validates model-supplied arguments before anything is called. */
  schema: z.ZodTypeAny
  /** JSON Schema for the provider's function declaration. */
  parameters: Record<string, unknown>
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>
}

/* ══════════════════════════════════════════
   Shared argument pieces
   ══════════════════════════════════════════ */

/** ISO date, or a GA4-style relative token like "28daysAgo" / "today". */
const DateArg = z.string().min(1).max(20)

/* ══════════════════════════════════════════
   ga4_run_report
   ══════════════════════════════════════════ */

const Ga4Args = z.object({
  startDate: DateArg,
  endDate: DateArg,
  metrics: z.array(z.string().min(1)).min(1).max(8),
  dimensions: z.array(z.string().min(1)).max(4).optional(),
  limit: z.number().int().positive().optional(),
  orderByMetric: z.string().optional(),
})

const ga4Tool: ReadTool = {
  name: 'ga4_run_report',
  description:
    'Query Google Analytics 4 for this business. Use for traffic, sessions, users, engagement, ' +
    'conversions and page performance. Metric and dimension names must be GA4 API names ' +
    '(e.g. metrics "sessions", "totalUsers", "conversions"; dimensions "pagePath", "sessionDefaultChannelGroup", "country", "date"). ' +
    'Dates are YYYY-MM-DD or relative tokens like "28daysAgo" and "today".',
  group: 'analytics',
  minRole: 'staff',
  schema: Ga4Args,
  parameters: {
    type: 'object',
    properties: {
      startDate: { type: 'string', description: 'YYYY-MM-DD or a relative token like "28daysAgo"' },
      endDate: { type: 'string', description: 'YYYY-MM-DD or "today"' },
      metrics: { type: 'array', items: { type: 'string' }, description: 'GA4 metric API names' },
      dimensions: { type: 'array', items: { type: 'string' }, description: 'GA4 dimension API names' },
      limit: { type: 'integer', description: 'Max rows (default 50)' },
      orderByMetric: { type: 'string', description: 'Metric to sort by, descending' },
    },
    required: ['startDate', 'endDate', 'metrics'],
  },

  async execute(rawArgs, ctx) {
    const args = Ga4Args.parse(rawArgs)

    if (!ctx.ga4PropertyId) {
      return {
        summary: 'No Google Analytics property is configured for this workspace.',
        fenced: '',
        note: 'NOT_CONFIGURED',
      }
    }

    const report = await runGA4Report(ctx.accessToken, {
      propertyId: ctx.ga4PropertyId,
      startDate: args.startDate,
      endDate: args.endDate,
      metrics: args.metrics,
      dimensions: args.dimensions,
      limit: args.limit,
      orderByMetric: args.orderByMetric,
    })

    const rows = reportToSheetRows(report)
    const summary = `GA4 ${args.metrics.join(', ')} for ${args.startDate}–${args.endDate} (${report.rows.length} rows)`

    return {
      summary,
      // GA4 dimension values are third-party text — page titles and paths come
      // from whatever the site published, and land verbatim in the model's
      // context. They get the same fencing as any external content.
      fenced: fenceUntrusted(
        'Google Analytics report',
        JSON.stringify({ range: [args.startDate, args.endDate], rows: report.rows }),
      ),
      rows,
    }
  },
}

/* ══════════════════════════════════════════
   gsc_search_analytics
   ══════════════════════════════════════════ */

const GscArgs = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dimensions: z.array(z.enum(GSC_DIMENSIONS)).max(3).optional(),
  rowLimit: z.number().int().positive().optional(),
})

const gscTool: ReadTool = {
  name: 'gsc_search_analytics',
  description:
    'Query Google Search Console for this business — organic search clicks, impressions, ' +
    'click-through rate and average position. Dimensions: query, page, date, device, country, ' +
    'searchAppearance. Dates must be YYYY-MM-DD. Data goes back about 16 months.',
  group: 'analytics',
  minRole: 'staff',
  schema: GscArgs,
  parameters: {
    type: 'object',
    properties: {
      startDate: { type: 'string', description: 'YYYY-MM-DD' },
      endDate: { type: 'string', description: 'YYYY-MM-DD' },
      dimensions: {
        type: 'array',
        items: { type: 'string', enum: [...GSC_DIMENSIONS] },
        description: 'Break results down by these dimensions',
      },
      rowLimit: { type: 'integer', description: 'Max rows (default 50)' },
    },
    required: ['startDate', 'endDate'],
  },

  async execute(rawArgs, ctx) {
    const args = GscArgs.parse(rawArgs)

    if (!ctx.gscSiteUrl) {
      return {
        summary: 'No Search Console site is configured for this workspace.',
        fenced: '',
        note: 'NOT_CONFIGURED',
      }
    }

    const result = await querySearchConsole(
      ctx.accessToken,
      {
        siteUrl: ctx.gscSiteUrl,
        startDate: args.startDate,
        endDate: args.endDate,
        dimensions: args.dimensions as GSCDimension[] | undefined,
        rowLimit: args.rowLimit,
      },
      ctx.today ?? new Date(),
    )

    const rows = resultToSheetRows(result)

    return {
      summary: `Search Console ${args.startDate}–${args.endDate} (${result.rows.length} rows)`,
      // The caveat travels WITH the data. If query-dimensioned totals silently
      // under-report, an answer built on them is wrong in a way the reader
      // cannot detect — so the model is told, in the payload it reasons over.
      fenced: fenceUntrusted(
        'Google Search Console report',
        JSON.stringify({
          range: [args.startDate, args.endDate],
          ...(result.anonymizedDataWarning ? { caveat: result.anonymizedDataWarning } : {}),
          rows: result.rows,
        }),
      ),
      rows,
    }
  },
}

/* ══════════════════════════════════════════
   search_drive
   ══════════════════════════════════════════ */

/**
 * Why the Workspace tools exist alongside the digest.
 *
 * The pre-assembled Live Google Workspace block gives the model Drive as 12
 * FILENAMES with no contents, and Chat as a few recent messages from the first
 * spaces. So "who is our account manager at Nuvita?" was unanswerable: the model
 * could see the Nuvita space existed and nothing inside it, and correctly but
 * uselessly replied that it had no access. These two tools are the access.
 *
 * Both are reads against the user's own OAuth token, and neither can mutate
 * anything — the read-only-by-construction property the registry depends on.
 */

const DriveArgs = z.object({
  query: z.string().min(2).max(200),
})

const searchDriveTool: ReadTool = {
  name: 'search_drive',
  description:
    'Search the user\'s Google Drive by document CONTENTS and filename, and read the text of the ' +
    'best matches. Use for questions about what a document says — agreements, proposals, notes, ' +
    'reports, meeting minutes. Pass distinctive keywords (a company, project or topic name), not ' +
    'the user\'s whole sentence.',
  group: 'workspace',
  minRole: 'staff',
  schema: DriveArgs,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Keywords to search for, e.g. "Nuvita partnership"' },
    },
    required: ['query'],
  },

  async execute(rawArgs, ctx) {
    const args = DriveArgs.parse(rawArgs)
    const { matches, documents } = await searchDriveWithContents(ctx.accessToken, args.query)

    if (matches.length === 0) {
      return {
        summary: `No Drive files matched "${args.query}" (searched contents and filenames).`,
        fenced: '',
        note: 'NO_RESULTS',
      }
    }

    return {
      summary: `Drive search "${args.query}" — ${matches.length} match(es), read ${documents.length}`,
      // Document text is user-and-third-party authored content landing verbatim
      // in the model's context; it gets the same fencing as any external data.
      fenced: fenceUntrusted(
        'Google Drive search results',
        JSON.stringify({ query: args.query, matches, documents }),
      ),
    }
  },
}

/* ══════════════════════════════════════════
   search_chat
   ══════════════════════════════════════════ */

const ChatArgs = z.object({
  query: z.string().min(2).max(200),
  space: z.string().max(200).optional(),
})

const searchChatTool: ReadTool = {
  name: 'search_chat',
  description:
    'Search the message history of the user\'s Google Chat spaces. Use for what someone said, ' +
    'who a contact is, or a decision or detail discussed in a space. Set "space" to the name of ' +
    'a space when the question names an organisation, team or project. Searches recent history, ' +
    'not the entire archive.',
  group: 'workspace',
  minRole: 'staff',
  schema: ChatArgs,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Keywords to look for in messages, e.g. "account manager contact"' },
      space: { type: 'string', description: 'Restrict to spaces whose name contains this, e.g. "Nuvita"' },
    },
    required: ['query'],
  },

  async execute(rawArgs, ctx) {
    const args = ChatArgs.parse(rawArgs)
    const outcome = await searchChatHistory(
      ctx.accessToken,
      args.query,
      args.space,
      ctx.chatSpacePreferences,
    )

    if (outcome.spacesSearched.length === 0) {
      // A named space that matched nothing is a DIFFERENT answer from "no
      // messages matched" — telling the model which spaces do exist lets it
      // correct the user instead of reporting a dead end.
      const available = outcome.availableSpaces?.length
        ? ` Visible spaces: ${outcome.availableSpaces.join(', ')}.`
        : ' The user has no visible Chat spaces.'
      return {
        summary: `No Chat space matched "${args.space ?? ''}".${available}`,
        fenced: '',
        note: 'NO_RESULTS',
      }
    }

    if (outcome.hits.length === 0) {
      return {
        summary: `No messages matched "${args.query}" in ${outcome.spacesSearched.join(', ')} (recent history).`,
        fenced: '',
        note: 'NO_RESULTS',
      }
    }

    return {
      summary: `Chat search "${args.query}" — ${outcome.hits.length} message(s) across ${outcome.spacesSearched.join(', ')}`,
      // Chat messages are written by other people. Fenced, always.
      fenced: fenceUntrusted(
        'Google Chat search results',
        JSON.stringify({
          query: args.query,
          spacesSearched: outcome.spacesSearched,
          ...(outcome.failures.length ? { unreadableSpaces: outcome.failures } : {}),
          messages: outcome.hits,
        }),
      ),
    }
  },
}

/* ══════════════════════════════════════════
   calendar_freebusy
   ══════════════════════════════════════════ */

const FreeBusyArgs = z.object({
  timeMin: z.string().min(10).max(40),
  timeMax: z.string().min(10).max(40),
  calendarIds: z.array(z.string().min(1).max(200)).max(20).optional(),
})

/**
 * Availability lookups.
 *
 * `queryFreeBusy` shipped with the Calendar work but nothing consumed it, so
 * "when am I free Thursday?" still had no path — the assistant's only calendar
 * awareness was the event-title summary in the Workspace context block, which
 * cannot answer a gap question. This closes that.
 *
 * Read-only by construction like the rest of the group: freeBusy returns busy
 * intervals and cannot mutate a calendar.
 */
const freeBusyTool: ReadTool = {
  name: 'calendar_freebusy',
  description:
    "Look up when the user is BUSY on their calendars over a time range, to answer availability " +
    'questions ("when am I free Thursday?", "do I have time before the 2pm?"). Returns busy ' +
    'intervals merged across calendars — free time is the gaps between them. Times are RFC 3339 ' +
    'instants (e.g. "2026-07-30T09:00:00Z"). Prefer a range of a few days at most.',
  group: 'workspace',
  minRole: 'staff',
  schema: FreeBusyArgs,
  parameters: {
    type: 'object',
    properties: {
      timeMin: { type: 'string', description: 'Start of the range, RFC 3339' },
      timeMax: { type: 'string', description: 'End of the range, RFC 3339' },
      calendarIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Calendar ids to check; omit for the primary calendar',
      },
    },
    required: ['timeMin', 'timeMax'],
  },

  async execute(rawArgs, ctx) {
    const args = FreeBusyArgs.parse(rawArgs)
    const result = await queryFreeBusy(ctx.accessToken, {
      timeMin: args.timeMin,
      timeMax: args.timeMax,
      calendarIds: args.calendarIds,
    })

    if (!result.merged.length) {
      // Genuinely-clear is a real answer, and a distinct one from "the lookup
      // failed" — say so plainly so the model does not hedge.
      return {
        summary: `No busy time found between ${args.timeMin} and ${args.timeMax} — the calendar is clear.`,
        fenced: '',
        note: 'NO_RESULTS',
      }
    }

    return {
      summary: `Calendar busy blocks between ${args.timeMin} and ${args.timeMax}: ${result.merged.length}`,
      // Busy blocks come from invitations other people created, and the merged
      // set is derived from their data.
      fenced: fenceUntrusted(
        'Calendar free/busy',
        JSON.stringify({ range: [args.timeMin, args.timeMax], busy: result.merged }),
      ),
    }
  },
}

/* ══════════════════════════════════════════
   Registry
   ══════════════════════════════════════════ */

export const READ_TOOLS: readonly ReadTool[] = [
  ga4Tool,
  gscTool,
  searchDriveTool,
  searchChatTool,
  freeBusyTool,
]

export function getTool(name: string): ReadTool | undefined {
  return READ_TOOLS.find(t => t.name === name)
}

/** Tools in a group that the caller's role may run. */
export function toolsFor(group: ToolGroup, role: string | undefined): ReadTool[] {
  if (group === 'none') return []
  return READ_TOOLS.filter(t => t.group === group && roleAllows(role, t.minRole))
}

/**
 * Function declarations for the model, derived from the same table as dispatch
 * so a tool can never be advertised without being runnable.
 */
export function toFunctionDeclarations(tools: readonly ReadTool[]): Record<string, unknown>[] {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }))
}

/** Anthropic `tools` shape, so provider failover keeps tool parity. */
export function toAnthropicTools(tools: readonly ReadTool[]): Record<string, unknown>[] {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }))
}
