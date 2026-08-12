import { z } from 'zod'

/* ── Paperclip API response schemas ── */

/*
 * NOTE — Paperclip API contract (verified against @paperclipai/server):
 *   - List endpoints return BARE arrays; single resources return bare objects.
 *     All wrapped-response schemas below are unions tolerating both shapes.
 *   - Issues carry a flat `status` string (backlog|todo|in_progress|in_review|
 *     done|blocked|cancelled). The Linear-style `state` object does not exist
 *     on the wire — lib/paperclip.ts derives it during normalization.
 *   - Issue priorities on the wire are critical|high|medium|low.
 *   - Assignee is `assigneeAgentId`; agents use the full 7-value status enum.
 */

export const IssueStateSchema = z.object({
  id: z.string(),
  name: z.string(),
  group: z.enum(['backlog', 'unstarted', 'started', 'completed', 'cancelled']),
  color: z.string(),
}).passthrough()

export const IssueSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  identifier: z.string().optional(),
  // Accept both Paperclip's wire vocabulary and the Hub's internal one
  priority: z.enum(['critical', 'urgent', 'high', 'medium', 'low', 'none']).optional(),
  status: z.enum(['backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled']).optional(),
  state: IssueStateSchema.optional(),
  assigneeAgentId: z.string().nullable().optional(),
  assigneeId: z.string().nullable().optional(),
  assigneeName: z.string().nullable().optional(),
  companyId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).passthrough()

export const RunSchema = z.object({
  // Heartbeat runs expose `runId`/`finishedAt`; older shapes used `id`/`completedAt`
  id: z.string().optional(),
  runId: z.string().optional(),
  status: z.enum([
    'queued', 'scheduled_retry', 'running',
    'succeeded', 'completed', 'failed', 'timed_out', 'cancelled',
  ]),
  agentId: z.string(),
  agentName: z.string().optional(),
  startedAt: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
  finishedAt: z.string().nullable().optional(),
  durationMs: z.number().nullable().optional(),
}).passthrough()

export const AgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  adapter: z.string().optional(),
  adapterType: z.string().optional(),
  status: z.enum([
    'active', 'paused', 'idle', 'running', 'error',
    'pending_approval', 'terminated', 'inactive',
  ]),
  companyId: z.string(),
  createdAt: z.string(),
  lastHeartbeat: z.string().nullable().optional(),
  lastHeartbeatAt: z.string().nullable().optional(),
}).passthrough()

export const CompanySchema = z.object({
  id: z.string(),
  name: z.string(),
  identifier: z.string(),
  description: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  memberCount: z.number().optional(),
  issueCount: z.number().optional(),
}).passthrough()

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  status: z.string().default('backlog'),
  urlKey: z.string().optional().default(''),
  color: z.string().nullable().optional(),
  companyId: z.string(),
  leadAgentId: z.string().nullable().optional(),
  targetDate: z.string().nullable().optional(),
  goalIds: z.string().array().optional().default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
}).passthrough()

/* ── Wrapped response schemas ── */

/* Every list/single response tolerates both the bare shape (current
   Paperclip API) and the wrapped shape (legacy expectation). */

export const IssuesResponseSchema = z.union([
  IssueSchema.array(),
  z.object({ issues: IssueSchema.array() }).passthrough(),
])

export const IssueResponseSchema = z.union([
  IssueSchema,
  z.object({ issue: IssueSchema }).passthrough(),
])

export const RunsResponseSchema = z.union([
  RunSchema.array(),
  z.object({ runs: RunSchema.array() }).passthrough(),
])

export const AgentsResponseSchema = z.union([
  AgentSchema.array(),
  z.object({ agents: AgentSchema.array() }).passthrough(),
])

export const AgentResponseSchema = z.union([
  AgentSchema,
  z.object({ agent: AgentSchema }).passthrough(),
])

export const CompaniesResponseSchema = z.union([
  CompanySchema.array(),
  z.object({ companies: CompanySchema.array() }).passthrough(),
])

export const ProjectsResponseSchema = z.union([
  ProjectSchema.array(),
  z.object({ projects: ProjectSchema.array() }).passthrough(),
])

/* Routines and Goals (right-panel Phase 3). Lenient: only `id` and `title`
   are required on the wire; everything else normalizes with defaults in
   lib/paperclip.ts. */
export const RoutineSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  status: z.string().optional(),
  assigneeAgentId: z.string().nullable().optional(),
  assigneeName: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
  companyId: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}).passthrough()

export const RoutinesResponseSchema = z.union([
  RoutineSchema.array(),
  z.object({ routines: RoutineSchema.array() }).passthrough(),
])

export const GoalSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  level: z.string().optional(),
  status: z.string().optional(),
  parentId: z.string().nullable().optional(),
  ownerAgentId: z.string().nullable().optional(),
  companyId: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}).passthrough()

export const GoalsResponseSchema = z.union([
  GoalSchema.array(),
  z.object({ goals: GoalSchema.array() }).passthrough(),
])

/* Company dashboard snapshot (GET /api/companies/:id/dashboard).
   Deliberately lenient: every section is optional and passthrough because the
   snapshot's field set varies across Paperclip versions — normalization to a
   zero-filled shape happens in lib/execution-dashboard.ts, not here. */
export const DashboardResponseSchema = z.object({
  companyId: z.string().optional(),
  agents: z.object({
    active: z.number().optional(),
    running: z.number().optional(),
    paused: z.number().optional(),
    error: z.number().optional(),
  }).passthrough().optional(),
  tasks: z.object({
    open: z.number().optional(),
    inProgress: z.number().optional(),
    blocked: z.number().optional(),
    done: z.number().optional(),
  }).passthrough().optional(),
  costs: z.object({
    monthSpendCents: z.number().optional(),
    monthBudgetCents: z.number().optional(),
    monthUtilizationPercent: z.number().optional(),
  }).passthrough().optional(),
  pendingApprovals: z.number().optional(),
  budgets: z.object({
    activeIncidents: z.number().optional(),
    pendingApprovals: z.number().optional(),
    pausedAgents: z.number().optional(),
    pausedProjects: z.number().optional(),
  }).passthrough().optional(),
}).passthrough()

/* ── HUB API input schemas ── */

export const ChatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  timestamp: z.string(),
  grillMode: z.boolean().optional(),
  grillOptions: z.string().array().optional(),
})

export const ChatRequestSchema = z.object({
  messages: ChatMessageSchema.array().min(1),
  useCase: z.enum(['recall', 'deep_dive', 'execute', 'interview']).optional(),
  skillContext: z.string().optional(),
  // EXA Search mode — when true, the chat route bypasses all internal tools and
  // context assembly and runs a pure Exa.AI web search summarizer (header toggle).
  exaMode: z.boolean().optional(),
  attachments: z.array(z.object({
    id: z.string(),
    type: z.enum(['document', 'url', 'text']),
    label: z.string(),
    content: z.string().optional(),
    fileId: z.string().optional(),
    url: z.string().optional(),
    mimeType: z.string().optional(),
  })).optional(),
})

export const CreateIssueRequestSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  description: z.string().optional(),
  // Hub + Paperclip vocabularies both accepted; lib/paperclip.ts maps
  // urgent→critical and none→low before hitting the Paperclip API.
  priority: z.enum(['critical', 'urgent', 'high', 'medium', 'low', 'none']).optional(),
  assigneeId: z.string().optional(),
  companyId: z.string().optional(),
})

/* ── Inferred types ── */

export type ValidatedIssueState = z.infer<typeof IssueStateSchema>
export type ValidatedIssue = z.infer<typeof IssueSchema>
export type ValidatedRun = z.infer<typeof RunSchema>
export type ValidatedAgent = z.infer<typeof AgentSchema>
export type ValidatedCompany = z.infer<typeof CompanySchema>
export type ValidatedProject = z.infer<typeof ProjectSchema>
export type ValidatedChatMessage = z.infer<typeof ChatMessageSchema>
export type ValidatedChatRequest = z.infer<typeof ChatRequestSchema>
export type ValidatedCreateIssueRequest = z.infer<typeof CreateIssueRequestSchema>

/* ── Agent Memory Schemas ── */

export const MemoryTypeSchema = z.enum(['insight', 'decision', 'error_pattern', 'success_pattern'])

export const StoreMemoryRequestSchema = z.object({
  agentId: z.string().min(1, 'agentId is required'),
  memoryType: MemoryTypeSchema,
  content: z.string().min(1, 'content is required'),
  context: z.record(z.any()).nullable().optional(),
  relevanceScore: z.number().int().min(1).max(10).optional(),
  expiresAt: z.string().datetime().nullable().optional(),
})

export const QueryMemoryRequestSchema = z.object({
  agentId: z.string().optional(),
  memoryType: MemoryTypeSchema.optional(),
  searchQuery: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})

export type ValidatedMemoryType = z.infer<typeof MemoryTypeSchema>
export type ValidatedStoreMemoryRequest = z.infer<typeof StoreMemoryRequestSchema>
export type ValidatedQueryMemoryRequest = z.infer<typeof QueryMemoryRequestSchema>


/* ── Google write-request schemas ──
 * Bound user input on Google mutations so a malformed/oversized payload is
 * rejected with a 400 before it reaches Google (prevents OOM, opaque upstream
 * errors, and rate-limit hits from pathological field sizes). Audit P1/P2. */

export const GoogleTaskCreateSchema = z.object({
  title: z.string().trim().min(1).max(1024),
  notes: z.string().max(8192).optional(),
  due: z.string().max(64).optional(),
})

export const GoogleCalendarCreateSchema = z.object({
  summary: z.string().trim().min(1).max(1024),
  description: z.string().max(8192).optional(),
  start: z.string().min(1).max(64),
  end: z.string().min(1).max(64),
  attendees: z.array(z.string().email().max(320)).max(100).optional(),
  location: z.string().max(1024).optional(),
  // IANA time-zone name (e.g. "America/Chicago"). Bounded so a pathological
  // value can't reach Google. Optional: all-day events omit it.
  timeZone: z.string().max(64).optional(),
  calendarId: z.string().max(1024).optional(),
  // When true, request a Google Meet link on the event (no new scope needed —
  // the existing full `calendar` scope covers conferenceData creation).
  addMeetLink: z.boolean().optional(),
})

export const GoogleGmailSendSchema = z.object({
  to: z.string().trim().min(1).max(2048),
  subject: z.string().max(998).optional(),
  message: z.string().min(1).max(1_000_000),
  threadId: z.string().max(256).optional(),
  inReplyTo: z.string().max(998).optional(),
  /**
   * 'draft' creates a Gmail draft and returns its id WITHOUT sending;
   * 'send' (the default, so existing callers are unaffected) delivers it.
   * See app/api/google/gmail/route.ts for why the AI path uses both.
   */
  mode: z.enum(['send', 'draft']).optional(),
})

/** Send an ALREADY-CREATED draft, by id. */
export const GoogleGmailSendDraftSchema = z.object({
  draftId: z.string().trim().min(1).max(256),
})

export const GoogleGmailActionSchema = z.object({
  action: z.enum(['trash', 'save_task']),
  threadId: z.string().trim().min(1).max(256),
  subject: z.string().max(998).optional(),
  from: z.string().max(512).optional(),
  snippet: z.string().max(1024).optional(),
})

export const GoogleChatSendSchema = z.object({
  spaceId: z.string().trim().min(1).max(256),
  text: z.string().trim().min(1).max(4096),
  /**
   * Reply into an EXISTING thread by resource name — what the panel's
   * reply-in-thread composer sends. Strict charset (the ids Google mints are
   * URL-safe) so a junk value can never reach Google as a routing field.
   */
  threadName: z.string().trim().regex(/^spaces\/[\w-]+\/threads\/[\w-]+$/).max(512).optional(),
  threadKey: z.string().max(256).optional(),
})

/**
 * Grant access to a Drive file the Hub created.
 *
 * `recipients` and `link` are the two shapes of a share and are mutually
 * exclusive — the route rejects a body carrying both, and one of them must be
 * present. Keeping link sharing a separate, explicit flag (rather than a magic
 * "anyone" recipient) is what stops a fuzzy recipient string from ever
 * widening a file to the whole internet by accident.
 */
export const GoogleShareSchema = z
  .object({
    fileId: z.string().trim().min(1).max(256),
    recipients: z.array(z.string().trim().email().max(320)).max(25).optional(),
    /** Link sharing — anyone holding the URL gets `role`. */
    link: z.boolean().optional(),
    role: z.enum(['reader', 'commenter', 'writer']).optional(),
    notify: z.boolean().optional(),
    message: z.string().max(2048).optional(),
  })
  .refine(b => Boolean(b.recipients?.length) !== Boolean(b.link), {
    message: 'Provide either recipients or link sharing, not both',
  })

/** Remove one existing grant from a Drive file the Hub created. */
export const GoogleUnshareSchema = z.object({
  fileId: z.string().trim().min(1).max(256),
  permissionId: z.string().trim().min(1).max(256),
})
