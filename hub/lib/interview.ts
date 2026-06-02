/**
 * Interview Mode Engine
 *
 * Detects task-creation intents and walks the user through a structured
 * question sequence before building an ActionSpec for confirmation.
 *
 * Phase 3: Expanded to 12 intents with role-gated Paperclip orchestration.
 */

import type {
  InterviewIntent,
  InterviewStep,
  InterviewState,
  ActionSpec,
  ActionPermission,
  UserRole,
} from '@/types'

/* ── Role Permissions ── */

const INTENT_PERMISSIONS: Record<InterviewIntent, ActionPermission> = {
  // Staff-level (read + create)
  create_task: 'staff',
  schedule_event: 'staff',
  send_communication: 'staff',
  create_paperclip_issue: 'staff',
  check_agent_status: 'staff',
  view_runs: 'staff',
  // Admin-level (manage)
  assign_issue: 'admin',
  update_issue_state: 'admin',
  create_agent: 'admin',
  launch_campaign: 'admin',
  restart_agent: 'admin',
  run_audit: 'admin',
  // Superadmin-level (destructive)
  create_workspace: 'superadmin',
  delete_workspace: 'superadmin',
  delete_agent: 'superadmin',
}

const ROLE_HIERARCHY: Record<string, number> = {
  onboarding: 0,
  staff: 1,
  admin: 2,
  superadmin: 3,
}

/**
 * Check if a user role has permission to execute an intent.
 */
export function hasPermission(role: string, intent: InterviewIntent): boolean {
  const required = INTENT_PERMISSIONS[intent]
  return (ROLE_HIERARCHY[role] ?? 0) >= (ROLE_HIERARCHY[required] ?? 99)
}

/**
 * Get the required permission level for an intent.
 */
export function getRequiredPermission(intent: InterviewIntent): ActionPermission {
  return INTENT_PERMISSIONS[intent]
}

/* ── Intent Detection ── */

const INTENT_PATTERNS: Array<{ intent: InterviewIntent; patterns: RegExp[] }> = [
  {
    intent: 'create_task',
    patterns: [
      /\b(create|add|make|need to|let'?s|we should|i want to)\b.*\b(task|todo|item|ticket)\b/i,
      /\b(assign|delegate)\b.*\b(to|for)\b/i,
      /\badd a task\b/i,
    ],
  },
  {
    intent: 'schedule_event',
    patterns: [
      /\b(schedule|book|set up|plan|arrange)\b.*\b(meeting|event|call|session|appointment|sync)\b/i,
      /\b(block|reserve)\b.*\b(time|slot|calendar)\b/i,
      /\bput.*on.*calendar\b/i,
    ],
  },
  {
    intent: 'send_communication',
    patterns: [
      /\b(send|draft|write|compose)\b.*\b(email|message|slack|notification|memo|update)\b/i,
      /\b(notify|alert|inform|reach out)\b/i,
      /\blet.*know\b/i,
    ],
  },
  {
    intent: 'create_paperclip_issue',
    patterns: [
      /\b(run|start|trigger|ask)\b.*\b(agent|paperclip|ai|bot)\b/i,
      /\b(audit|analyze|research)\b.*\b(codebase|metrics|data)\b/i,
      /\bcreate\b.*\b(issue)\b/i,
    ],
  },
  // Phase 3: Paperclip orchestrator intents
  {
    intent: 'check_agent_status',
    patterns: [
      /\b(check|show|what'?s|how'?s|status of|get)\b.*\b(agent|agents|bot|bots)\b/i,
      /\bagent.*(status|state|health|running|error)\b/i,
      /\b(who|which).*agents?.*\b(running|active|idle|error)\b/i,
    ],
  },
  {
    intent: 'view_runs',
    patterns: [
      /\b(show|list|view|get|recent)\b.*\b(runs|executions|history|logs)\b/i,
      /\b(what|which).*\b(ran|executed|completed|failed)\b/i,
      /\brun history\b/i,
    ],
  },
  {
    intent: 'assign_issue',
    patterns: [
      /\b(assign|reassign|give|hand off|transfer)\b.*\b(issue|task|ticket)\b.*\b(to|agent)\b/i,
      /\b(move|switch)\b.*\b(issue)\b.*\b(to)\b/i,
    ],
  },
  {
    intent: 'update_issue_state',
    patterns: [
      /\b(close|complete|resolve|reopen|start|begin)\b.*\b(issue|task|ticket)\b/i,
      /\b(mark|set)\b.*\b(issue|task)\b.*\b(as|to)\b.*\b(done|complete|closed|open|in.?progress)\b/i,
      /\b(update|change)\b.*\b(status|state)\b.*\b(issue|task)\b/i,
    ],
  },
  {
    intent: 'create_agent',
    patterns: [
      /\b(create|add|make|spin up|provision)\b.*\b(agent|bot)\b/i,
      /\bnew agent\b/i,
    ],
  },
  {
    intent: 'launch_campaign',
    patterns: [
      /\b(launch|start|create|build|run)\b.*\b(campaign|strategy|initiative|program)\b/i,
      /\b(content|blog|seo|marketing|social media|email)\b.*\b(campaign|strategy|plan|initiative)\b/i,
      /\b(need|want)\b.*\b(copywriter|keyword|seo|content writer|marketing team)\b/i,
      /\bmulti.?agent\b/i,
    ],
  },
  {
    intent: 'restart_agent',
    patterns: [
      /\b(restart|reboot|reset|wake up|kick)\b.*\b(agent|bot)\b/i,
      /\bagent.*(restart|reboot|reset)\b/i,
    ],
  },
  {
    intent: 'run_audit',
    patterns: [
      /\b(run|start|trigger|do)\b.*\b(audit|health.?check|diagnostic|scan)\b/i,
      /\baudit\b.*\b(project|workspace|company|agents?)\b/i,
    ],
  },
  {
    intent: 'create_workspace',
    patterns: [
      /\b(create|add|make|provision|set up)\b.*\b(workspace|company|organization|project)\b/i,
      /\bnew (workspace|company|org)\b/i,
    ],
  },
  {
    intent: 'delete_workspace',
    patterns: [
      /\b(delete|remove|destroy|tear down|decommission)\b.*\b(workspace|company|organization)\b/i,
    ],
  },
  {
    intent: 'delete_agent',
    patterns: [
      /\b(delete|remove|destroy|decommission|kill)\b.*\b(agent|bot)\b/i,
    ],
  },
]

/**
 * Detect whether a user message contains an actionable intent
 * that should trigger Interview Mode.
 */
export function detectIntent(message: string): InterviewIntent | null {
  for (const { intent, patterns } of INTENT_PATTERNS) {
    if (patterns.some((p) => p.test(message))) {
      return intent
    }
  }
  return null
}

/* ── Question Sequences ── */

const INTERVIEW_SEQUENCES: Record<InterviewIntent, InterviewStep[]> = {
  create_task: [
    {
      question: 'What exactly needs to be done? Provide the task description and any necessary context.',
      key: 'description',
    },
    {
      question: 'I\'ll create this task with the context provided. Confirm? (yes / edit / cancel)',
      key: '_confirm',
    },
  ],

  schedule_event: [
    {
      question: 'What is this event about? Please provide the title, attendees, date/time, and any context.',
      key: 'details',
    },
    {
      question: 'I\'ll schedule this event with the details above. Confirm? (yes / edit / cancel)',
      key: '_confirm',
    },
  ],

  send_communication: [
    {
      question: 'Who should receive this and what should the message say? Provide the recipient and the content.',
      key: 'details',
    },
    {
      question: 'I\'ll prepare this communication with the details above. Confirm? (yes / edit / cancel)',
      key: '_confirm',
    },
  ],

  create_paperclip_issue: [
    {
      question: 'What needs to be done? Provide the issue title and context for the agent.',
      key: 'description',
    },
    {
      question: 'I\'ll create this issue and assign it to the CEO Agent. Confirm? (yes / edit / cancel)',
      key: '_confirm',
    },
  ],

  // ── Phase 3: Paperclip Orchestrator Intents ──

  check_agent_status: [
    {
      question: 'Which project/workspace do you want to check? (or "all" for a full overview)',
      key: 'project',
      defaultValue: 'all',
    },
    {
      question: 'Any specific agent? (e.g., CEO, CMO, CTO — or "all")',
      key: 'agent',
      defaultValue: 'all',
    },
    {
      question: 'I\'ll pull the current status. Confirm? (yes / cancel)',
      key: '_confirm',
    },
  ],

  view_runs: [
    {
      question: 'Which project/workspace? (or "all")',
      key: 'project',
      defaultValue: 'all',
    },
    {
      question: 'Time range? (last hour / today / this week / all time)',
      key: 'timeRange',
      defaultValue: 'today',
    },
    {
      question: 'I\'ll fetch the run history. Confirm? (yes / cancel)',
      key: '_confirm',
    },
  ],

  assign_issue: [
    {
      question: 'Which issue? (issue ID, title, or describe it)',
      key: 'issueRef',
    },
    {
      question: 'Which agent should handle this? (name or role, e.g., "CEO", "CMO")',
      key: 'agent',
    },
    {
      question: 'I\'ll reassign this issue. Confirm? (yes / cancel)',
      key: '_confirm',
    },
  ],

  update_issue_state: [
    {
      question: 'Which issue? (issue ID, title, or describe it)',
      key: 'issueRef',
    },
    {
      question: 'New state? (open / in-progress / done / cancelled)',
      key: 'newState',
    },
    {
      question: 'I\'ll update the issue state. Confirm? (yes / cancel)',
      key: '_confirm',
    },
  ],

  create_agent: [
    {
      question: 'Which project/workspace should this agent belong to?',
      key: 'project',
    },
    {
      question: 'What should the agent be named? (e.g., "SEO Specialist", "Content Writer")',
      key: 'agentName',
    },
    {
      question: 'What role/instructions should the agent have? Describe what it does, what success looks like, and any constraints.',
      key: 'instructions',
    },
    {
      question: 'I\'ll brief the CEO Agent to provision this role. This requires admin privileges. Confirm? (yes / cancel)',
      key: '_confirm',
    },
  ],

  launch_campaign: [
    {
      question: 'What is the campaign about? Describe the goal, target audience, and desired outcome.',
      key: 'campaignGoal',
    },
    {
      question: 'Which project/workspace should this campaign run in?',
      key: 'project',
    },
    {
      question: 'What agent roles do you envision? (e.g., "Copywriter, SEO Auditor, Keyword Researcher" — or say "let the CEO decide")',
      key: 'suggestedRoles',
      defaultValue: 'Let the CEO decide',
    },
    {
      question: 'Any deadlines, budget constraints, or specific requirements the CEO should know about?',
      key: 'constraints',
      defaultValue: 'No specific constraints',
    },
    {
      question: 'I\'ll brief the CEO Agent with this campaign plan. The CEO will determine the agent structure and coordinate execution. Confirm? (yes / cancel)',
      key: '_confirm',
    },
  ],

  restart_agent: [
    {
      question: 'Which project/workspace?',
      key: 'project',
    },
    {
      question: 'Which agent do you want to restart?',
      key: 'agent',
    },
    {
      question: '⚠️ This will restart the agent and clear its current state. Confirm? (yes / cancel)',
      key: '_confirm',
    },
  ],

  run_audit: [
    {
      question: 'Which project/workspace do you want to audit? (or "all")',
      key: 'project',
      defaultValue: 'all',
    },
    {
      question: 'Audit scope? (agents / issues / full)',
      key: 'scope',
      defaultValue: 'full',
    },
    {
      question: 'I\'ll run the audit now. Confirm? (yes / cancel)',
      key: '_confirm',
    },
  ],

  create_workspace: [
    {
      question: 'What should the workspace be named?',
      key: 'name',
    },
    {
      question: 'Agent template? (csuite = CEO+CMO+CTO+CFO+COO / ceo-only = just CEO)',
      key: 'template',
      defaultValue: 'csuite',
    },
    {
      question: '🔒 This requires superadmin privileges. I\'ll create the workspace and seed the agents. Confirm? (yes / cancel)',
      key: '_confirm',
    },
  ],

  delete_workspace: [
    {
      question: 'Which workspace do you want to delete?',
      key: 'name',
    },
    {
      question: '🔴 **DESTRUCTIVE ACTION**: Type the exact workspace name to confirm deletion:',
      key: 'confirmName',
    },
    {
      question: '🔴 This will permanently delete the workspace and ALL its agents, issues, and data. Final confirmation? (yes / cancel)',
      key: '_confirm',
    },
  ],

  delete_agent: [
    {
      question: 'Which project/workspace?',
      key: 'project',
    },
    {
      question: 'Which agent do you want to delete?',
      key: 'agent',
    },
    {
      question: '🔴 **DESTRUCTIVE ACTION**: Type the agent name to confirm deletion:',
      key: 'confirmName',
    },
    {
      question: '🔴 This will permanently delete the agent and all its history. Final confirmation? (yes / cancel)',
      key: '_confirm',
    },
  ],
}

/**
 * Get the question sequence for a given intent.
 */
export function getInterviewSequence(intent: InterviewIntent): InterviewStep[] {
  return INTERVIEW_SEQUENCES[intent]
}

/**
 * Get the current question for an active interview.
 * Returns null if the interview is complete.
 */
export function getCurrentQuestion(
  state: InterviewState
): InterviewStep | null {
  if (!state.active || !state.intent) return null
  const steps = INTERVIEW_SEQUENCES[state.intent]
  if (state.step >= steps.length) return null
  return steps[state.step]
}

/**
 * Get the total number of questions for an interview intent.
 */
export function getTotalQuestions(intent: InterviewIntent): number {
  return INTERVIEW_SEQUENCES[intent].length
}

/* ── Interview State Management ── */

/**
 * Create a fresh InterviewState for a detected intent.
 */
export function startInterview(intent: InterviewIntent): InterviewState {
  return {
    active: true,
    intent,
    step: 0,
    questionsAsked: 0,
    context: {},
    spec: null,
  }
}

/**
 * Advance the interview by recording the user's answer and moving to the next step.
 */
export function advanceInterview(
  state: InterviewState,
  answer: string
): InterviewState {
  if (!state.active || !state.intent) return state

  const steps = INTERVIEW_SEQUENCES[state.intent]
  const currentStep = steps[state.step]
  if (!currentStep) return state

  const updatedContext = {
    ...state.context,
    [currentStep.key]: answer || currentStep.defaultValue || '',
  }

  const nextStep = state.step + 1
  const isComplete = nextStep >= steps.length

  return {
    ...state,
    step: nextStep,
    questionsAsked: state.questionsAsked + 1,
    context: updatedContext,
    spec: isComplete ? buildConfirmationSpec(state.intent, updatedContext) : null,
    active: !isComplete,
  }
}

/**
 * Cancel an active interview.
 */
export function cancelInterview(): InterviewState {
  return {
    active: false,
    intent: null,
    step: 0,
    questionsAsked: 0,
    context: {},
    spec: null,
  }
}

/* ── Action Spec Builder ── */

const INTENT_LABELS: Record<InterviewIntent, string> = {
  create_task: 'Create Task',
  schedule_event: 'Schedule Event',
  send_communication: 'Send Communication',
  create_paperclip_issue: 'Create Paperclip Issue',
  check_agent_status: 'Check Agent Status',
  view_runs: 'View Run History',
  assign_issue: 'Assign Issue',
  update_issue_state: 'Update Issue State',
  create_agent: 'Create Agent (via CEO)',
  launch_campaign: 'Launch Campaign (via CEO)',
  restart_agent: 'Restart Agent',
  run_audit: 'Run Audit',
  create_workspace: 'Create Workspace',
  delete_workspace: 'Delete Workspace',
  delete_agent: 'Delete Agent',
}

const INTENT_TARGET_SYSTEMS: Record<InterviewIntent, string[]> = {
  create_task: ['Google Tasks', 'Paperclip'],
  schedule_event: ['Google Calendar'],
  send_communication: ['Gmail', 'Slack'],
  create_paperclip_issue: ['Paperclip AI'],
  check_agent_status: ['Paperclip AI'],
  view_runs: ['Paperclip AI'],
  assign_issue: ['Paperclip AI'],
  update_issue_state: ['Paperclip AI'],
  create_agent: ['Paperclip AI — CEO Routed'],
  launch_campaign: ['Paperclip AI — CEO Routed'],
  restart_agent: ['Paperclip AI'],
  run_audit: ['Paperclip AI'],
  create_workspace: ['Paperclip AI'],
  delete_workspace: ['Paperclip AI'],
  delete_agent: ['Paperclip AI'],
}

/**
 * Build a structured ActionSpec from the completed interview context.
 */
export function buildConfirmationSpec(
  intent: InterviewIntent,
  context: Record<string, string>
): ActionSpec {
  // Filter out the _confirm key and empty values
  const details: Record<string, string> = {}
  for (const [key, value] of Object.entries(context)) {
    if (key !== '_confirm' && value) {
      details[key] = value
    }
  }

  // Build a human-readable summary
  const label = INTENT_LABELS[intent]
  const summaryParts = Object.entries(details)
    .map(([k, v]) => `${k}: ${v}`)
    .join(' | ')

  return {
    intent,
    details,
    targetSystems: INTENT_TARGET_SYSTEMS[intent],
    summary: `${label} — ${summaryParts}`,
    requiredPermission: INTENT_PERMISSIONS[intent],
  }
}

/**
 * Format an intent for display.
 */
export function formatIntentLabel(intent: InterviewIntent): string {
  return INTENT_LABELS[intent]
}

/**
 * Check if an intent is a destructive action (requires type-to-confirm).
 */
export function isDestructiveIntent(intent: InterviewIntent): boolean {
  return intent === 'delete_workspace' || intent === 'delete_agent'
}

/**
 * Check if an intent is a read-only query (no confirmation card needed, just fetch and display).
 */
export function isReadOnlyIntent(intent: InterviewIntent): boolean {
  return intent === 'check_agent_status' || intent === 'view_runs' || intent === 'run_audit'
}

/**
 * Check if an intent should be routed through the CEO Agent via an Issue
 * instead of executing directly.
 */
export function isCeoRoutedIntent(intent: InterviewIntent): boolean {
  return intent === 'create_agent' || intent === 'launch_campaign'
}
