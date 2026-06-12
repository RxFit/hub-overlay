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

