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
  kpiSheetId?: string         // Google Sheet ID for KPI dashboard
  kpiSheetRange?: string      // e.g. "KPIs!A1:F20"
  feedPollingIntervalMs?: number
  hubRolesSheetId?: string    // Google Sheet ID for Hub role assignments
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

export type InterviewIntent = 'create_task' | 'schedule_event' | 'send_communication' | 'create_paperclip_issue'

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
}

export interface ActionSpec {
  intent: InterviewIntent
  details: Record<string, string>
  targetSystems: string[]
  summary: string
}
