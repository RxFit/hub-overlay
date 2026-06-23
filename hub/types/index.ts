/* ── Paperclip API Types ── */

export interface Company {
  id: string
  name: string
  identifier: string
  description: string | null
  createdAt: string
  updatedAt: string
  memberCount?: number
  issueCount?: number
}

export interface Issue {
  id: string
  title: string
  description: string | null
  identifier: string
  priority: 'urgent' | 'high' | 'medium' | 'low' | 'none'
  state: IssueState
  assigneeId: string | null
  assigneeName: string | null
  companyId: string
  createdAt: string
  updatedAt: string
}

export interface IssueState {
  id: string
  name: string
  group: 'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled'
  color: string
}

export interface Run {
  id: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  agentId: string
  agentName: string
  issueId: string
  issueIdentifier: string
  model: string | null
  startedAt: string | null
  completedAt: string | null
  durationMs: number | null
  companyId: string
}

export interface Agent {
  id: string
  name: string
  description: string | null
  adapter: string
  status: 'active' | 'inactive' | 'error'
  companyId: string
  createdAt: string
  lastHeartbeat: string | null
}

export interface Project {
  id: string
  name: string
  description: string | null | undefined
  status: string                // 'backlog' | 'planned' | 'started' | 'paused' | 'completed' | 'cancelled'
  urlKey: string
  color?: string | null
  companyId: string
  companyName?: string          // enriched client-side for dropdown display
  leadAgentId?: string | null
  targetDate?: string | null
  goalIds: string[]
  createdAt: string
  updatedAt: string
}

/* ── Hub User Types ── */

export type UserRole = 'superadmin' | 'admin' | 'staff' | 'onboarding'

export interface HubUser {
  id: string
  email: string
  name: string
  image: string | null
  role: UserRole
  assignedProjects: string[]  // company IDs
  lastLogin: string | null
  createdAt: string
}

export interface ProjectAssignment {
  userId: string
  companyId: string
  companyName: string
  assignedAt: string
}

/* ── Chat Types ── */

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
  grillMode?: boolean
  grillOptions?: string[]
}

export interface GrillState {
  active: boolean
  intent: 'create' | 'adjust' | 'escalate' | null
  questionsAsked: number
  context: Record<string, string>
}

/* ── KPI / Intelligence Types ── */

export interface KPIData {
  label: string
  value: string | number
  unit?: string
  trend: number  // percentage change
  trendUp: boolean
  description?: string
}

export interface IntelligenceNode {
  id: string
  name: string
  department: string
  goals: GoalItem[]
  status: 'active' | 'paused' | 'completed'
}

export interface GoalItem {
  id: string
  title: string
  progress: number  // 0–100
  status: 'on-track' | 'at-risk' | 'behind'
  deadline?: string
}

/* ── API Error ── */

export interface PaperclipApiError {
  error: string
  message: string
  statusCode: number
}
/* ── Panel & Role System Types ── */

export type PanelSide = 'left' | 'right'

export interface PanelModule {
  id: string
  label: string
  panel: PanelSide
  icon: string
}

export interface RoleConfig {
  id: string
  name: string
  description: string
  leftPanelModules: string[]   // module IDs visible in left panel
  rightPanelModules: string[]  // module IDs visible in right panel
  canChat: boolean
  canManageRoles: boolean
  canViewAllProjects: boolean
  canUseInterviewMode: boolean  // Interview Mode (action execution via Paperclip)
  canAccessAdmin: boolean       // /admin route access
}

export interface TenantConfig {
  tenantId: string
  tenantName: string
  roles: Record<string, RoleConfig>  // keyed by role ID (e.g. 'admin', 'staff')
  feedPollingIntervalMs?: number
}

/* ── Activity Feed Types ── */

export type FeedSource = 'paperclip' | 'google-tasks' | 'google-calendar' | 'google-drive' | 'system'
export type FeedItemType = 'completed' | 'in_progress' | 'needs_you' | 'info'

export interface FeedItem {
  id: string
  source: FeedSource
  type: FeedItemType
  title: string
  description: string
  timestamp: string
  icon?: string
  actionUrl?: string
  metadata?: Record<string, unknown>
}

/* ── Interview Mode Types ── */

export type InterviewIntent =
  | 'create_task'
  | 'schedule_event'
  | 'send_communication'
  | 'create_paperclip_issue'
  // Phase 3: Paperclip orchestrator intents
  | 'check_agent_status'
  | 'view_runs'
  | 'assign_issue'
  | 'update_issue_state'
  | 'create_agent'
  | 'launch_campaign'
  | 'restart_agent'
  | 'run_audit'
  | 'create_workspace'
  | 'delete_workspace'
  | 'delete_agent'

export interface InterviewStep {
  question: string
  key: string
  defaultValue?: string
}

export interface InterviewState {
  active: boolean
  intent: InterviewIntent | null
  step: number
  questionsAsked: number
  context: Record<string, string>
  spec: ActionSpec | null
  /** When re-editing, holds the previous answers as defaults for each question */
  _editDefaults?: Record<string, string>
}

export interface ActionSpec {
  intent: InterviewIntent
  details: Record<string, string>
  targetSystems: string[]
  summary: string
  requiredPermission?: ActionPermission
  /**
   * Server-issued, HMAC-signed quality-gate token (P0-2). Minted by
   * /api/chat/score-context on a genuine pass and forwarded on high-stakes
   * writes so the API boundary can verify the gate was satisfied server-side.
   */
  gateToken?: string
}

/** Minimum Hub role required to execute an action */
export type ActionPermission = 'staff' | 'admin' | 'superadmin'

/* ── Multi-Tenant KPI Types ── */

export type KPISource = 'paperclip' | 'business' | 'derived'
export type KPIScope = 'global' | 'project'
export type KPIVisibility = 'public' | 'admin' | 'staff'

export interface LiveKPI {
  id: string
  label: string
  value: string | number
  unit?: string
  trend: string
  trendDirection: 'up' | 'down' | 'neutral'
  source: KPISource
  scope: KPIScope
  companyId?: string
  visibility: KPIVisibility
  updatedAt: string
}

export interface ProjectKPI {
  companyId: string
  companyName: string
  identifier: string
  health: 'healthy' | 'at-risk' | 'critical'
  openIssues: number
  completedThisWeek: number
  completionRate: number
  activeAgents: number
  failedRuns: number
  lastActivity: string
}

/* ── Chat Attachment Types ── */

export interface ChatAttachment {
  id: string
  type: 'document' | 'url' | 'text'
  label: string           // Display name (file name, URL, "Pasted text")
  content?: string        // For 'text' type or pre-resolved content
  fileId?: string         // For 'document' type (Google Drive file ID)
  url?: string            // For 'url' type
  mimeType?: string       // For document type
}

/* ── Active Skill Types ── */

export type SkillPlugin = 'gstack' | 'enterprise-ai'

export interface ActiveSkill {
  id: string
  name: string
  plugin: SkillPlugin
}

/* ══════════════════════════════════════════════════════════════════════════════
   BUSINESS MANAGER / CEO PULSE TYPES
   ══════════════════════════════════════════════════════════════════════════════ */

export type AgentRoleKey = 'ceo' | 'cmo' | 'cto' | 'cfo' | 'coo'
export type DepartmentHealth = 'ON_TRACK' | 'DRIFTING' | 'CRITICAL'
export type StallStatus = 'normal' | 'amber' | 'red'

export interface DepartmentPulse {
  role: AgentRoleKey
  status: DepartmentHealth
  kpiActual?: string
  kpiTarget?: string
  kpiLabel?: string
  lastTask?: string
  lastTaskTime?: string
  correctiveAction?: string | null
  blockedTasks?: number
}

export interface CEOPulseRecord {
  pulseId: string
  org: string
  orgId: string
  globalHealthPct: number
  departments: DepartmentPulse[]
  escalations: string[]
  lastPulseAt: string
  nextPulseAt?: string
}

/** Stall detection state for a single in_progress feed item */
export interface StallState {
  itemId: string
  status: StallStatus
  stalledSinceMs?: number
}

/* ── Founder Lens Wizard Types ── */

export type FounderLensRole = AgentRoleKey

export interface FounderLensCustomSection {
  role: FounderLensRole
  okrs?: string
  competitiveAdvantages?: string
  idealCustomer?: string
  quarterlyGoals?: string
  annualGoals?: string
  tonePreferences?: string
  uniqueInstructions?: string
}

export interface FounderLensConfig {
  orgId: string
  roles: FounderLensCustomSection[]
  updatedAt: string
}

/* ── Extended Interview Mode Types — Context Sufficiency Gate ── */

export interface ContextScoreResult {
  score: number                    // 0–100
  passed: boolean                  // score >= 80
  weakDimension: string | null     // e.g. "outcome", "timeline", "constraints"
  followUpQuestion: string | null  // AI-generated clarifying question when score < 80
  gateToken?: string               // P0-2: server-signed token, present only on a genuine pass
}

export type ExtendedInterviewIntent = InterviewIntent | 'create_task_for_agent'

/* ── Tool Guidance Panel Types ── */

/** Structured artifact data stored per tool session */
export interface ToolArtifactData {
  toolId: string
  title: string
  sections: ToolArtifactSection[]
  metadata?: Record<string, unknown>
}

/** A single section/card within a tool artifact */
export interface ToolArtifactSection {
  id: string
  type: 'branch' | 'hypothesis' | 'pro' | 'con' | 'recommendation' | 'step' | 'score' | 'critique' | 'slide' | 'insight' | 'narrative' | 'generic'
  title: string
  content: string
  children?: ToolArtifactSection[]
  status?: 'active' | 'recommended' | 'completed' | 'warning'
  score?: number
  collapsed?: boolean
}

/** Props for tool-specific panel content components */
export interface ToolPanelContentProps {
  toolId: string
  contextSummary: string | null
  messages: Array<{ id: string; role: 'user' | 'assistant'; content: string }>
  onInjectChat: (msg: string) => void
  onArtifactUpdate: (data: ToolArtifactData) => void
  artifacts: ToolArtifactData | null
}

/** Context card generated by AI on tool activation */
export interface ToolContextCard {
  summary: string
  suggestedPrompts: string[]
  keyEntities: string[]
}

/** Tool artifact record as stored in the database */
export interface ToolArtifactRecord {
  id: string
  toolId: string
  title: string
  content: ToolArtifactData
  contextSummary: string | null
  status: 'active' | 'completed' | 'archived'
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

