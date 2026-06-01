/**
 * Interview Mode Engine
 *
 * Detects task-creation intents and walks the user through a structured
 * question sequence before building an ActionSpec for confirmation.
 */

import type {
  InterviewIntent,
  InterviewStep,
  InterviewState,
  ActionSpec,
} from '@/types'

/* ── Intent Detection ── */

const INTENT_PATTERNS: Array<{ intent: InterviewIntent; patterns: RegExp[] }> = [
  {
    intent: 'create_task',
    patterns: [
      /\b(create|add|make|need to|let'?s|we should|i want to)\b.*\b(task|todo|item|ticket|issue)\b/i,
      /\b(assign|delegate)\b.*\b(to|for)\b/i,
      /\badd a task\b/i,
      /\bcreate.*for\b/i,
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
      question:
        'What exactly needs to be done? Be specific about the deliverable — not just the action, but what "done" looks like.',
      key: 'description',
    },
    {
      question: 'What priority should this be? (urgent / high / medium / low)',
      key: 'priority',
      defaultValue: 'medium',
    },
    {
      question: 'When does this need to be completed by?',
      key: 'deadline',
      defaultValue: 'End of this week',
    },
    {
      question: 'Who should this be assigned to? (name, role, or "me")',
      key: 'assignee',
      defaultValue: 'me',
    },
    {
      question:
        'Let me confirm: I\'ll create this task with the details above. Does everything look correct? (yes / edit / cancel)',
      key: '_confirm',
    },
  ],

  schedule_event: [
    {
      question: 'What is this event about? Give it a clear title and purpose.',
      key: 'title',
    },
    {
      question: 'When should this happen? (date and time)',
      key: 'when',
      defaultValue: 'Tomorrow at 10:00 AM',
    },
    {
      question: 'Who should be invited?',
      key: 'attendees',
    },
    {
      question:
        'Where will this take place? (conference room, Zoom, Google Meet, etc.)',
      key: 'location',
      defaultValue: 'Google Meet',
    },
    {
      question: 'How long should this be? (e.g., 30 min, 1 hour)',
      key: 'duration',
      defaultValue: '30 minutes',
    },
    {
      question:
        'Let me confirm: I\'ll schedule this event with the details above. Does everything look correct? (yes / edit / cancel)',
      key: '_confirm',
    },
  ],

  send_communication: [
    {
      question: 'Who should receive this? (name or email)',
      key: 'recipient',
    },
    {
      question:
        'What channel? (email, Slack, text, or notification)',
      key: 'channel',
      defaultValue: 'email',
    },
    {
      question: 'What should the message say? Give me the key points.',
      key: 'content',
    },
    {
      question:
        'What tone? (professional, casual, urgent, friendly)',
      key: 'tone',
      defaultValue: 'professional',
    },
    {
      question:
        'Let me confirm: I\'ll send this communication with the details above. Does everything look correct? (yes / edit / cancel)',
      key: '_confirm',
    },
  ],

  create_paperclip_issue: [
    {
      question: 'Give this task a clear, action-oriented title.',
      key: 'title',
    },
    {
      question: 'What needs to be done? Provide full context, constraints, and what success looks like.',
      key: 'description',
    },
    {
      question: 'What is the priority? (urgent / high / medium / low)',
      key: 'priority',
      defaultValue: 'medium',
    },
    {
      question: 'Let me confirm: I\'ll create this issue and assign it to the CEO Agent. Does everything look correct? (yes / edit / cancel)',
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
}

const INTENT_TARGET_SYSTEMS: Record<InterviewIntent, string[]> = {
  create_task: ['Google Tasks', 'Paperclip'],
  schedule_event: ['Google Calendar'],
  send_communication: ['Gmail', 'Slack'],
  create_paperclip_issue: ['Paperclip AI'],
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
  }
}

/**
 * Format an intent for display.
 */
export function formatIntentLabel(intent: InterviewIntent): string {
  return INTENT_LABELS[intent]
}
