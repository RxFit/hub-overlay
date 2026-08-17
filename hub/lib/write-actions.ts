/**
 * The write actions the app can actually run, in the words the system prompt
 * uses to advertise them.
 *
 * ── The failure this fixes ──
 * The action list in HUB_SYSTEM_PROMPT was hand-written and had drifted from
 * lib/interview.ts: 27 intents shipped, 11 were advertised, and one advertised
 * action — "edit a document" — had never existed at all. Both halves of that
 * drift hurt the user. Unadvertised intents produce the GA4 denial pattern
 * ("I can't create a Google Doc" — to a user whose next message would have
 * opened a Confirm Card for exactly that), and the phantom one produces its
 * mirror image: the model promises an edit flow, the app has no intent to
 * match, and nothing happens.
 *
 * ── Why a Record, not a list ──
 * `Record<InterviewIntent, …>` makes the compiler the enforcement. Adding an
 * intent to the union without giving it a prompt label is a TYPE ERROR, so the
 * advertised set cannot silently fall behind the shipped set again. The
 * required role comes from interview.ts's permission table, so the prompt's
 * role tiers can't drift from the ones actually enforced either.
 *
 * The rendered catalog is a module constant built from static data — no
 * per-request values — so it stays byte-identical across requests and is safe
 * inside the cached static prefix of the system prompt.
 */

import type { InterviewIntent, ActionPermission } from '@/types'
import { getRequiredPermission } from './interview'

/**
 * Which flow an intent runs through. The two surfaces behave differently and
 * the prompt must describe them differently: Paperclip actions run a short
 * guided interview, personal/Google actions ask once for extra context. Getting
 * that backwards is what made the model interrogate users field-by-field for a
 * one-line "email Maria".
 */
export type WriteActionSurface = 'google' | 'paperclip'

export interface WriteAction {
  /** Prompt-facing phrase — what the user would recognise asking for. */
  label: string
  surface: WriteActionSurface
}

export const WRITE_ACTION_CATALOG: Record<InterviewIntent, WriteAction> = {
  /* ── Personal / Google Workspace ── */
  create_task: { label: 'Create a Google Task', surface: 'google' },
  update_task: {
    label: 'Update an existing Google Task — retitle it, change its due date, mark it done, reopen or delete it',
    surface: 'google',
  },
  schedule_event: { label: 'Schedule a Google Calendar event', surface: 'google' },
  create_google_doc: { label: 'Author a NEW Google Doc from content you draft together', surface: 'google' },
  create_google_sheet: { label: 'Author a NEW Google Sheet (tables, KPI exports)', surface: 'google' },
  create_google_presentation: { label: 'Author a NEW Google Slides deck', surface: 'google' },
  share_google_file: {
    label: 'Share a Hub-created Doc/Sheet/Slides with someone, or change its access level',
    surface: 'google',
  },
  send_gmail: { label: 'Send an email via Gmail', surface: 'google' },
  post_chat_message: { label: 'Post a message in a Google Chat space', surface: 'google' },

  /* ── Paperclip orchestration ── */
  send_communication: {
    label: 'Delegate a memo / outreach / multi-recipient communication to the COO agent',
    surface: 'paperclip',
  },
  create_paperclip_issue: { label: 'Create a Paperclip issue → triggers agent investigation', surface: 'paperclip' },
  check_agent_status: { label: 'Check agent status — current health of all agents', surface: 'paperclip' },
  view_runs: { label: 'View run history — recent agent executions', surface: 'paperclip' },
  run_routine: { label: 'Run an existing routine right now, outside its schedule', surface: 'paperclip' },
  assign_issue: { label: 'Assign or reassign an issue to a specific agent', surface: 'paperclip' },
  update_issue_state: { label: 'Update an issue state (open, in-progress, done, cancelled)', surface: 'paperclip' },
  create_agent: { label: 'Create a new AI agent with custom instructions', surface: 'paperclip' },
  launch_campaign: { label: 'Launch a multi-agent campaign or initiative', surface: 'paperclip' },
  restart_agent: { label: 'Restart an agent that is in an error state', surface: 'paperclip' },
  run_audit: { label: 'Run a workspace audit', surface: 'paperclip' },
  create_workspace: { label: 'Create a workspace with agent templates', surface: 'paperclip' },
  delete_workspace: { label: 'Delete an entire workspace', surface: 'paperclip' },
  create_routine: { label: 'Create a recurring routine (scheduled agent work)', surface: 'paperclip' },
  update_routine: { label: 'Update a routine — pause, resume, rename or reschedule it', surface: 'paperclip' },
  create_goal: { label: 'Create a business goal for the company, a team, or an agent', surface: 'paperclip' },
  update_goal: { label: 'Update a goal — mark it achieved, activate, cancel, or edit it', surface: 'paperclip' },
  delete_agent: { label: 'Delete an agent permanently', surface: 'paperclip' },
}

const TIER_ORDER: readonly ActionPermission[] = ['onboarding', 'staff', 'admin', 'superadmin']

const TIER_HEADINGS: Record<ActionPermission, string> = {
  onboarding: 'Anyone signed in (writes only to the user\'s OWN Google account)',
  staff: 'Staff and above',
  admin: 'Admin and above',
  superadmin: 'Superadmin only',
}

/** Every intent on one surface, grouped by the role tier that gates it. */
export function writeActionsBySurface(surface: WriteActionSurface): Array<{
  tier: ActionPermission
  heading: string
  actions: string[]
}> {
  return TIER_ORDER.map(tier => ({
    tier,
    heading: TIER_HEADINGS[tier],
    actions: (Object.keys(WRITE_ACTION_CATALOG) as InterviewIntent[])
      .filter(intent => WRITE_ACTION_CATALOG[intent].surface === surface)
      .filter(intent => getRequiredPermission(intent) === tier)
      .map(intent => WRITE_ACTION_CATALOG[intent].label),
  })).filter(group => group.actions.length > 0)
}

/** Markdown block of one surface's actions, for the system prompt. */
export function renderWriteActions(surface: WriteActionSurface): string {
  return writeActionsBySurface(surface)
    .map(group => [`**${group.heading}:**`, ...group.actions.map(a => `- ${a}`)].join('\n'))
    .join('\n\n')
}
