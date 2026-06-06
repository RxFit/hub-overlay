import { z } from 'zod'

/* ── Paperclip API response schemas ── */

export const IssueStateSchema = z.object({
  id: z.string(),
  name: z.string(),
  group: z.enum(['backlog', 'unstarted', 'started', 'completed', 'cancelled']),
  color: z.string(),
}).passthrough()

export const IssueSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  identifier: z.string(),
  priority: z.enum(['urgent', 'high', 'medium', 'low', 'none']),
  state: IssueStateSchema,
  assigneeId: z.string().nullable(),
  assigneeName: z.string().nullable(),
  companyId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).passthrough()

export const RunSchema = z.object({
  id: z.string(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
  agentId: z.string(),
  agentName: z.string(),
  issueId: z.string(),
  issueIdentifier: z.string(),
  model: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
  companyId: z.string(),
}).passthrough()

export const AgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  adapter: z.string(),
  status: z.enum(['active', 'inactive', 'error']),
  companyId: z.string(),
  createdAt: z.string(),
  lastHeartbeat: z.string().nullable(),
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

/* ── Wrapped response schemas ── */

export const IssuesResponseSchema = z.object({
  issues: IssueSchema.array(),
}).passthrough()

export const IssueResponseSchema = z.object({
  issue: IssueSchema,
}).passthrough()

export const RunsResponseSchema = z.object({
  runs: RunSchema.array(),
}).passthrough()

export const AgentsResponseSchema = z.object({
  agents: AgentSchema.array(),
}).passthrough()

export const AgentResponseSchema = z.object({
  agent: AgentSchema,
}).passthrough()

export const CompaniesResponseSchema = z.union([
  CompanySchema.array(),
  z.object({ companies: CompanySchema.array() }).passthrough(),
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
  priority: z.enum(['urgent', 'high', 'medium', 'low', 'none']).optional(),
  assigneeId: z.string().optional(),
  companyId: z.string().optional(),
})

/* ── Inferred types ── */

export type ValidatedIssueState = z.infer<typeof IssueStateSchema>
export type ValidatedIssue = z.infer<typeof IssueSchema>
export type ValidatedRun = z.infer<typeof RunSchema>
export type ValidatedAgent = z.infer<typeof AgentSchema>
export type ValidatedCompany = z.infer<typeof CompanySchema>
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

