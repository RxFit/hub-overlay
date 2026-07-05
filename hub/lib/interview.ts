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
  send_gmail: 'staff',
  post_chat_message: 'staff',
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
  // Admin-level (workspace lifecycle)
  create_workspace: 'admin',
  delete_workspace: 'admin',
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

/* ── Intent Definitions ── */

export const INTENT_DEFINITIONS: Array<{ id: InterviewIntent; description: string; expectedEntities: string[] }> = [
  {
    id: 'create_task',
    description: 'User wants to create, add, or delegate a new task, todo item, or ticket.',
    expectedEntities: ['description'],
  },
  {
    id: 'schedule_event',
    description: 'User wants to schedule, book, or set up a meeting or calendar event.',
    expectedEntities: ['details'],
  },
  {
    id: 'send_communication',
    description: 'User wants to delegate composing and sending a communication (memo, outreach, or multi-recipient message) to the COO agent. Do NOT use this for a direct email (use send_gmail) or a Google Chat post (use post_chat_message).',
    expectedEntities: ['details'],
  },
  {
    id: 'send_gmail',
    description: 'User wants to directly send an email via Gmail to a specific recipient, e.g. "email Maria that the invoice is paid".',
    expectedEntities: ['to', 'subject', 'body'],
  },
  {
    id: 'post_chat_message',
    description: 'User wants to post or send a message in a Google Chat space, e.g. "post in RxFit Ops that the demo moved to 3pm".',
    expectedEntities: ['space', 'message'],
  },
  {
    id: 'create_paperclip_issue',
    description: 'User wants to run an agent, audit the codebase, or trigger a Paperclip AI issue.',
    expectedEntities: ['description'],
  },
  {
    id: 'check_agent_status',
    description: 'User wants to check the status or health of one or more agents.',
    expectedEntities: ['project', 'agent'],
  },
  {
    id: 'view_runs',
    description: 'User wants to view recent execution history or runs for an agent.',
    expectedEntities: ['project', 'timeRange'],
  },
  {
    id: 'assign_issue',
    description: 'User wants to reassign an existing issue or task to a different agent or person.',
    expectedEntities: ['issueRef', 'agent'],
  },
  {
    id: 'update_issue_state',
    description: 'User wants to close, reopen, or change the status of an existing issue.',
    expectedEntities: ['issueRef', 'newState'],
  },
  {
    id: 'create_agent',
    description: 'User wants to spin up, provision, or create a new AI agent or bot role.',
    expectedEntities: ['project', 'agentName', 'instructions'],
  },
  {
    id: 'launch_campaign',
    description: 'User wants to launch a multi-agent campaign, marketing strategy, or initiative.',
    expectedEntities: ['campaignGoal', 'project', 'suggestedRoles', 'constraints'],
  },
  {
    id: 'restart_agent',
    description: 'User wants to restart, reboot, or reset an AI agent.',
    expectedEntities: ['project', 'agent'],
  },
  {
    id: 'run_audit',
    description: 'User wants to run a health check, scan, or full audit on a workspace or project.',
    expectedEntities: ['project', 'scope'],
  },
  {
    id: 'create_workspace',
    description: 'User wants to create or provision a new workspace, organization, or project.',
    expectedEntities: ['name', 'issuePrefix', 'brandColor', 'template'],
  },
  {
    id: 'delete_workspace',
    description: 'User wants to permanently delete or tear down a workspace.',
    expectedEntities: ['name'],
  },
  {
    id: 'delete_agent',
    description: 'User wants to permanently delete or decommission an agent.',
    expectedEntities: ['project', 'agent'],
  },
]

/**
 * Detect whether a user message contains an actionable intent
 * that should trigger Interview Mode via Semantic classification API.
 */
export async function detectIntent(message: string): Promise<{ intent: InterviewIntent | null; extractedEntities: Record<string, string> }> {
  try {
    const res = await fetch('/api/chat/detect-intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, availableIntents: INTENT_DEFINITIONS }),
    })
    if (!res.ok) return { intent: null, extractedEntities: {} }
    const data = await res.json()
    // Validate that the returned intent is one of the valid InterviewIntents
    const validIntent = INTENT_DEFINITIONS.find(d => d.id === data.intent)
    if (validIntent) {
      return { intent: data.intent as InterviewIntent, extractedEntities: data.extractedEntities || {} }
    }
    return { intent: null, extractedEntities: {} }
  } catch (err) {
    console.error('detectIntent error:', err)
    return { intent: null, extractedEntities: {} }
  }
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
      question: 'Who should receive this and what should the message say? Provide the recipient, channel (email/slack/etc.), and the content.',
      key: 'details',
    },
    {
      question: 'I\'ll brief the COO Agent to send this communication. Confirm? (yes / edit / cancel)',
      key: '_confirm',
    },
  ],

  send_gmail: [
    {
      question: 'Who should receive this email? (email address)',
      key: 'to',
    },
    {
      question: 'What should the subject line be?',
      key: 'subject',
      defaultValue: '(no subject)',
    },
    {
      question: 'What should the email say?',
      key: 'body',
    },
    {
      question: 'I\'ll send this email from your Gmail account. Confirm? (yes / edit / cancel)',
      key: '_confirm',
    },
  ],

  post_chat_message: [
    {
      question: 'Which Google Chat space should this be posted in?',
      key: 'space',
    },
    {
      question: 'What should the message say?',
      key: 'message',
    },
    {
      question: 'I\'ll post this message to Google Chat. Confirm? (yes / edit / cancel)',
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
      question: 'Issue prefix? This is a 2–5 letter abbreviation used for issue IDs (e.g., "RXF", "FSR", "JCS").',
      key: 'issuePrefix',
    },
    {
      question: 'Brand color? (hex code, e.g., "#C5A059" — or press Enter for default gold)',
      key: 'brandColor',
      defaultValue: '#C5A059',
    },
    {
      question: 'Agent template? (csuite = CEO+CMO+CTO+CFO+COO / ceo-only = just CEO)',
      key: 'template',
      defaultValue: 'csuite',
    },
    {
      question: '🔒 This requires admin privileges. I\'ll create the workspace and seed the agents. Confirm? (yes / cancel)',
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
 * Fast-forward the interview past any questions that already have answers in the context.
 */
function fastForwardInterview(state: InterviewState): InterviewState {
  if (!state.active || !state.intent) return state
  const steps = INTERVIEW_SEQUENCES[state.intent]
  let currentStepIndex = state.step

  while (currentStepIndex < steps.length) {
    const currentStep = steps[currentStepIndex]
    // If we have a non-empty answer for this step's key, skip it
    if (state.context[currentStep.key] && state.context[currentStep.key].trim() !== '') {
      currentStepIndex++
    } else {
      break
    }
  }

  const isComplete = currentStepIndex >= steps.length
  return {
    ...state,
    step: currentStepIndex,
    active: !isComplete,
    spec: isComplete ? buildConfirmationSpec(state.intent, state.context) : state.spec,
  }
}

/**
 * Create a fresh InterviewState for a detected intent.
 */
export function startInterview(intent: InterviewIntent, prefilledContext?: Record<string, string>): InterviewState {
  const initialState: InterviewState = {
    active: true,
    intent,
    step: 0,
    questionsAsked: 0,
    context: prefilledContext || {},
    spec: null,
  }
  return fastForwardInterview(initialState)
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

  const nextState: InterviewState = {
    ...state,
    step: state.step + 1,
    questionsAsked: state.questionsAsked + 1,
    context: updatedContext,
  }

  return fastForwardInterview(nextState)
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
  send_gmail: 'Send Gmail',
  post_chat_message: 'Post Chat Message',
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
  send_communication: ['Paperclip AI — COO Routed'],
  send_gmail: ['Gmail'],
  post_chat_message: ['Google Chat'],
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
 * Check if an intent is high-stakes (e.g., external comms, automations, or CEO handoffs).
 * These intents are routed through the AI Quality Gate for Pre-Cog validation.
 */
export function isHighStakesIntent(intent: InterviewIntent): boolean {
  return (
    intent === 'create_agent' ||
    intent === 'launch_campaign' ||
    intent === 'send_communication' ||
    intent === 'send_gmail' ||
    intent === 'post_chat_message' ||
    intent === 'create_paperclip_issue'
  )
}

/**
 * Re-enter a completed interview at step 0, preserving existing answers
 * as the new defaultValues for each question.
 */
export function restartInterview(
  intent: InterviewIntent,
  previousContext: Record<string, string>
): InterviewState {
  return {
    active: true,
    intent,
    step: 0,
    questionsAsked: 0,
    context: {},
    spec: null,
    _editDefaults: previousContext,
  } as InterviewState
}

/**
 * Get the current question for an active interview,
 * merging any edit defaults into the step's defaultValue.
 */
export function getCurrentQuestionWithDefaults(
  state: InterviewState
): InterviewStep | null {
  if (!state.active || !state.intent) return null
  const steps = INTERVIEW_SEQUENCES[state.intent]
  if (state.step >= steps.length) return null
  const step = steps[state.step]
  if (state._editDefaults && state._editDefaults[step.key]) {
    return { ...step, defaultValue: state._editDefaults[step.key] }
  }
  return step
}
