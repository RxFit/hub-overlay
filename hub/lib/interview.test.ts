import { describe, it, expect } from 'vitest'
import {
  hasPermission,
  startInterview,
  advanceInterview,
  buildConfirmationSpec,
  isDestructiveIntent,
  isReadOnlyIntent,
  isHighStakesIntent,
  isPaperclipIntent,
  isPersonalActionIntent,
  isSkipContextAnswer,
  getTotalQuestions,
  INTENT_DEFINITIONS,
} from '@/lib/interview'

describe('hasPermission', () => {
  it('grants personal-productivity intents (own Google account) to every role, onboarding included', () => {
    // The Carol-Jean case: pending users must be able to create Google Tasks /
    // calendar events on THEIR OWN account.
    for (const role of ['onboarding', 'staff', 'admin', 'superadmin']) {
      expect(hasPermission(role, 'create_task')).toBe(true)
      expect(hasPermission(role, 'schedule_event')).toBe(true)
    }
  })

  it('grants staff-level intents to staff and above', () => {
    expect(hasPermission('staff', 'send_gmail')).toBe(true)
    expect(hasPermission('admin', 'send_gmail')).toBe(true)
    expect(hasPermission('superadmin', 'send_gmail')).toBe(true)
  })

  it('denies org-level (staff+) intents to onboarding', () => {
    expect(hasPermission('onboarding', 'send_gmail')).toBe(false)
    expect(hasPermission('onboarding', 'post_chat_message')).toBe(false)
    expect(hasPermission('onboarding', 'create_paperclip_issue')).toBe(false)
    expect(hasPermission('onboarding', 'send_communication')).toBe(false)
  })

  it('gates admin and superadmin intents correctly', () => {
    expect(hasPermission('staff', 'create_workspace')).toBe(false)
    expect(hasPermission('admin', 'create_workspace')).toBe(true)
    expect(hasPermission('staff', 'delete_agent')).toBe(false)
    expect(hasPermission('admin', 'delete_agent')).toBe(false)
    expect(hasPermission('superadmin', 'delete_agent')).toBe(true)
  })
})

describe('interview flow (personal lightweight single-question flow)', () => {
  it('create_task is a single "add context?" question that completes to a spec', () => {
    // Personal actions (task/event/email/chat) no longer run the multi-step
    // interview — one optional context question, then the Confirm Card.
    expect(getTotalQuestions('create_task')).toBe(1)

    // Extracted description is prefilled; the one context question still shows.
    let state = startInterview('create_task', { description: 'Email the onboarding pack' })
    expect(state.active).toBe(true)
    expect(state.step).toBe(0)

    // Answering the single context question completes the flow with a spec.
    state = advanceInterview(state, 'go ahead')
    expect(state.active).toBe(false)
    expect(state.spec).not.toBeNull()
    expect(state.spec?.intent).toBe('create_task')
    expect(state.spec?.details.description).toBe('Email the onboarding pack')
    // "go ahead" is a skip phrase — it must not pollute the spec.
    expect(state.spec?.details.additionalContext).toBeUndefined()
  })

  it('keeps real added context in the spec', () => {
    let state = startInterview('create_task', { description: 'Email the onboarding pack' })
    state = advanceInterview(state, 'due Friday, high priority')
    expect(state.active).toBe(false)
    expect(state.spec?.details.additionalContext).toBe('due Friday, high priority')
  })

  it('schedule_event completes to a spec through the single context question', () => {
    expect(getTotalQuestions('schedule_event')).toBe(1)
    let state = startInterview('schedule_event', { details: 'Kickoff with Acme Tuesday 2pm' })
    expect(state.active).toBe(true) // parked on the single context question
    state = advanceInterview(state, 'go ahead')
    expect(state.active).toBe(false)
    expect(state.spec?.intent).toBe('schedule_event')
    expect(state.spec?.details.details).toBe('Kickoff with Acme Tuesday 2pm')
    expect(state.spec?.targetSystems).toEqual(['Google Calendar'])
  })

  it('does not skip the context question just because fields were prefilled', () => {
    const state = startInterview('create_task', { description: 'prefilled task' })
    // The single step is `additionalContext` (never prefilled), so we park on it.
    expect(state.active).toBe(true)
    expect(state.step).toBe(0)
  })
})

describe('intent classification helpers', () => {
  it('flags destructive intents', () => {
    expect(isDestructiveIntent('delete_workspace')).toBe(true)
    expect(isDestructiveIntent('delete_agent')).toBe(true)
    expect(isDestructiveIntent('create_task')).toBe(false)
  })

  it('flags read-only intents', () => {
    expect(isReadOnlyIntent('check_agent_status')).toBe(true)
    expect(isReadOnlyIntent('view_runs')).toBe(true)
    expect(isReadOnlyIntent('create_task')).toBe(false)
  })

  it('builds a confirmation spec from collected context', () => {
    const spec = buildConfirmationSpec('create_task', { description: 'Do X', _confirm: 'yes' })
    expect(spec.intent).toBe('create_task')
    expect(spec.details.description).toBe('Do X')
    expect(spec.details._confirm).toBeUndefined() // _confirm is stripped
    expect(spec.requiredPermission).toBe('onboarding') // create_task is a personal-productivity intent
    expect(getTotalQuestions('create_task')).toBe(1) // single lightweight context question
  })

  it('drops a skip-phrase additionalContext but keeps real added context', () => {
    const skipped = buildConfirmationSpec('send_gmail', {
      to: 'maria@rxfitatx.com', body: 'Invoice paid', additionalContext: 'go ahead',
    })
    expect(skipped.details.additionalContext).toBeUndefined()
    expect(skipped.details.body).toBe('Invoice paid')

    const kept = buildConfirmationSpec('send_gmail', {
      to: 'maria@rxfitatx.com', body: 'Invoice paid', additionalContext: 'keep it formal',
    })
    expect(kept.details.additionalContext).toBe('keep it formal')
  })
})

describe('intent category helpers (Paperclip vs personal)', () => {
  it('classifies personal / Google Workspace actions as non-Paperclip', () => {
    for (const intent of ['create_task', 'update_task', 'schedule_event', 'send_gmail', 'post_chat_message', 'create_google_doc', 'create_google_sheet'] as const) {
      expect(isPersonalActionIntent(intent)).toBe(true)
      expect(isPaperclipIntent(intent)).toBe(false)
      expect(getTotalQuestions(intent)).toBe(1) // lightweight single-question flow
    }
  })

  it('classifies platform actions (issues, agents, routines, COO comms) as Paperclip', () => {
    for (const intent of ['create_paperclip_issue', 'send_communication', 'create_agent', 'launch_campaign', 'create_routine', 'create_goal', 'run_audit'] as const) {
      expect(isPaperclipIntent(intent)).toBe(true)
      expect(isPersonalActionIntent(intent)).toBe(false)
    }
  })

  it('treats "just proceed" answers as context skips, real detail as content', () => {
    for (const phrase of ['go ahead', 'no', 'nope', 'proceed', 'send it', 'yes', 'ok', 'that\'s all', '  Go Ahead.  ']) {
      expect(isSkipContextAnswer(phrase)).toBe(true)
    }
    for (const phrase of ['due Friday', 'CC the CFO', 'make it formal']) {
      expect(isSkipContextAnswer(phrase)).toBe(false)
    }
  })
})

describe('update_task intent', () => {
  it('registers the intent in the classifier definitions', () => {
    const def = INTENT_DEFINITIONS.find(d => d.id === 'update_task')
    expect(def).toBeDefined()
    expect(def?.expectedEntities).toEqual(['taskRef', 'change'])
  })

  it('is a personal-productivity intent available to every role', () => {
    for (const role of ['onboarding', 'staff', 'admin', 'superadmin']) {
      expect(hasPermission(role, 'update_task')).toBe(true)
    }
  })

  it('builds a spec from extracted taskRef + change via the single context question', () => {
    // Personal lightweight flow: extraction prefills taskRef + change; the one
    // context question then completes the spec.
    expect(getTotalQuestions('update_task')).toBe(1)
    let state = startInterview('update_task', { taskRef: 'invoice follow-up', change: 'mark done' })
    expect(state.active).toBe(true) // parked on the single context question

    state = advanceInterview(state, 'go ahead')
    expect(state.active).toBe(false)
    expect(state.spec?.intent).toBe('update_task')
    expect(state.spec?.details.taskRef).toBe('invoice follow-up')
    expect(state.spec?.details.change).toBe('mark done')
    expect(state.spec?.targetSystems).toEqual(['Google Tasks'])
  })

  it('is neither destructive, read-only, nor high-stakes', () => {
    expect(isDestructiveIntent('update_task')).toBe(false)
    expect(isReadOnlyIntent('update_task')).toBe(false)
    expect(isHighStakesIntent('update_task')).toBe(false)
  })
})

describe('Google authoring intents (create_google_doc / create_google_sheet)', () => {
  it('registers all three intents in the classifier definitions', () => {
    const ids = INTENT_DEFINITIONS.map(d => d.id)
    expect(ids).toContain('create_google_doc')
    expect(ids).toContain('create_google_sheet')
    expect(ids).toContain('create_google_presentation')
    expect(INTENT_DEFINITIONS.find(d => d.id === 'create_google_doc')?.expectedEntities).toEqual(['title', 'content'])
    expect(INTENT_DEFINITIONS.find(d => d.id === 'create_google_sheet')?.expectedEntities).toEqual(['title', 'content'])
    expect(INTENT_DEFINITIONS.find(d => d.id === 'create_google_presentation')?.expectedEntities).toEqual(['title', 'content'])
  })

  it('requires staff permission (own-Drive authoring), denies onboarding', () => {
    expect(hasPermission('staff', 'create_google_doc')).toBe(true)
    expect(hasPermission('admin', 'create_google_sheet')).toBe(true)
    expect(hasPermission('staff', 'create_google_presentation')).toBe(true)
    expect(hasPermission('onboarding', 'create_google_doc')).toBe(false)
    expect(hasPermission('onboarding', 'create_google_sheet')).toBe(false)
    expect(hasPermission('onboarding', 'create_google_presentation')).toBe(false)
  })

  it('advances a presentation through title + content to a spec', () => {
    let state = startInterview('create_google_presentation')
    expect(getTotalQuestions('create_google_presentation')).toBe(3)
    state = advanceInterview(state, 'Series A Pitch')
    state = advanceInterview(state, 'Problem. Solution. Traction.')
    expect(state.active).toBe(true) // parked on _confirm
    state = advanceInterview(state, 'yes')
    expect(state.spec?.intent).toBe('create_google_presentation')
    expect(state.spec?.details.title).toBe('Series A Pitch')
    expect(state.spec?.targetSystems).toEqual(['Google Slides'])
  })

  it('builds a doc spec from extracted title + content via the single context question', () => {
    // Docs/Sheets are Google Workspace (non-Paperclip) actions → the lightweight
    // single "add context?" question, not a multi-step interview.
    expect(getTotalQuestions('create_google_doc')).toBe(1)
    let state = startInterview('create_google_doc', { title: 'Q3 Decision Memo', content: 'Recommendation: proceed.' })
    expect(state.active).toBe(true) // parked on the single context question
    state = advanceInterview(state, 'go ahead')
    expect(state.active).toBe(false)
    expect(state.spec?.intent).toBe('create_google_doc')
    expect(state.spec?.details.title).toBe('Q3 Decision Memo')
    expect(state.spec?.details.content).toBe('Recommendation: proceed.')
    expect(state.spec?.targetSystems).toEqual(['Google Docs'])
  })

  it('builds a sheet spec from an extracted title (content optional)', () => {
    expect(getTotalQuestions('create_google_sheet')).toBe(1)
    let state = startInterview('create_google_sheet', { title: 'KPI Snapshot' })
    expect(state.active).toBe(true) // parked on the single context question
    state = advanceInterview(state, 'go ahead')
    expect(state.active).toBe(false)
    expect(state.spec?.intent).toBe('create_google_sheet')
    expect(state.spec?.details.title).toBe('KPI Snapshot')
    expect(state.spec?.targetSystems).toEqual(['Google Sheets'])
  })

  it('are not high-stakes (no gate token) and not destructive/read-only', () => {
    for (const intent of ['create_google_doc', 'create_google_sheet', 'create_google_presentation'] as const) {
      expect(isHighStakesIntent(intent)).toBe(false)
      expect(isDestructiveIntent(intent)).toBe(false)
      expect(isReadOnlyIntent(intent)).toBe(false)
    }
  })
})

describe('post-gate follow-up answers (context-score block recovery)', () => {
  it('folds an answer given past the last step into additionalContext and completes with a spec', () => {
    // Simulate the state the engine creates when the context gate blocks a
    // completed interview: active again, but step already past the sequence end.
    let state = startInterview('create_task', { description: 'Do X' })
    state = advanceInterview(state, 'yes') // completes (step == steps.length)
    const blocked = { ...state, active: true, spec: null }

    const recovered = advanceInterview(blocked, 'Deadline is Friday, success = client signs')
    expect(recovered.active).toBe(false)
    expect(recovered.spec).not.toBeNull()
    expect(recovered.spec?.intent).toBe('create_task')
    expect(recovered.context.additionalContext).toBe('Deadline is Friday, success = client signs')
    expect(recovered.spec?.details.additionalContext).toBe('Deadline is Friday, success = client signs')
  })

  it('accumulates across repeated blocks instead of overwriting', () => {
    let state = startInterview('create_task', { description: 'Do X' })
    state = advanceInterview(state, 'yes')
    let blocked = { ...state, active: true, spec: null }
    let next = advanceInterview(blocked, 'first detail')
    blocked = { ...next, active: true, spec: null }
    next = advanceInterview(blocked, 'second detail')
    expect(next.context.additionalContext).toBe('first detail\nsecond detail')
  })
})

describe('F3 direct-send intents (send_gmail / post_chat_message)', () => {
  it('registers both intents in the classifier definitions', () => {
    const ids = INTENT_DEFINITIONS.map(d => d.id)
    expect(ids).toContain('send_gmail')
    expect(ids).toContain('post_chat_message')

    const gmail = INTENT_DEFINITIONS.find(d => d.id === 'send_gmail')
    expect(gmail?.expectedEntities).toEqual(['to', 'subject', 'body'])
    const chat = INTENT_DEFINITIONS.find(d => d.id === 'post_chat_message')
    expect(chat?.expectedEntities).toEqual(['space', 'message'])
  })

  it('requires staff permission for both intents', () => {
    expect(hasPermission('staff', 'send_gmail')).toBe(true)
    expect(hasPermission('onboarding', 'send_gmail')).toBe(false)
    expect(hasPermission('staff', 'post_chat_message')).toBe(true)
    expect(hasPermission('onboarding', 'post_chat_message')).toBe(false)
  })

  it('flags both intents as high-stakes (Pre-Cog + gate token + confirm card)', () => {
    expect(isHighStakesIntent('send_gmail')).toBe(true)
    expect(isHighStakesIntent('post_chat_message')).toBe(true)
  })

  it('is neither destructive nor read-only', () => {
    expect(isDestructiveIntent('send_gmail')).toBe(false)
    expect(isDestructiveIntent('post_chat_message')).toBe(false)
    expect(isReadOnlyIntent('send_gmail')).toBe(false)
    expect(isReadOnlyIntent('post_chat_message')).toBe(false)
  })

  it('builds a send_gmail spec from extracted fields via the single context question', () => {
    // Lightweight flow: one optional context question, then the Confirm Card.
    expect(getTotalQuestions('send_gmail')).toBe(1)
    let state = startInterview('send_gmail', {
      to: 'maria@rxfitatx.com', subject: '(no subject)', body: 'The invoice is paid',
    })
    expect(state.active).toBe(true) // parked on the single context question

    state = advanceInterview(state, 'go ahead')
    expect(state.active).toBe(false)
    expect(state.spec?.intent).toBe('send_gmail')
    expect(state.spec?.details.to).toBe('maria@rxfitatx.com')
    expect(state.spec?.details.subject).toBe('(no subject)')
    expect(state.spec?.details.body).toBe('The invoice is paid')
    expect(state.spec?.targetSystems).toEqual(['Gmail'])
    expect(state.spec?.requiredPermission).toBe('staff')
  })

  it('builds a post_chat_message spec from extracted fields via the single context question', () => {
    expect(getTotalQuestions('post_chat_message')).toBe(1)
    let state = startInterview('post_chat_message', { space: 'RxFit Ops', message: 'Demo moved to 3pm' })
    expect(state.active).toBe(true) // parked on the single context question

    state = advanceInterview(state, 'go ahead')
    expect(state.active).toBe(false)
    expect(state.spec?.intent).toBe('post_chat_message')
    expect(state.spec?.details.space).toBe('RxFit Ops')
    expect(state.spec?.details.message).toBe('Demo moved to 3pm')
    expect(state.spec?.targetSystems).toEqual(['Google Chat'])
    expect(state.spec?.requiredPermission).toBe('staff')
  })

  it('always asks the context question once, even with all fields extracted', () => {
    const state = startInterview('send_gmail', {
      to: 'maria@rxfitatx.com',
      subject: 'Invoice',
      body: 'The invoice is paid',
    })
    expect(state.active).toBe(true)
    expect(state.step).toBe(0) // parked on the single context question, not fast-forwarded past it
  })
})

describe('share_google_file (Drive access settings)', () => {
  it('is registered in the classifier definitions with file/recipients/access', () => {
    const def = INTENT_DEFINITIONS.find(d => d.id === 'share_google_file')
    expect(def).toBeDefined()
    expect(def?.expectedEntities).toEqual(['file', 'recipients', 'access'])
  })

  it('requires staff permission and denies onboarding guests', () => {
    expect(hasPermission('staff', 'share_google_file')).toBe(true)
    expect(hasPermission('admin', 'share_google_file')).toBe(true)
    expect(hasPermission('onboarding', 'share_google_file')).toBe(false)
  })

  it('uses the lightweight single-question flow and builds a spec', () => {
    expect(getTotalQuestions('share_google_file')).toBe(1)
    let state = startInterview('share_google_file', {
      file: 'Q3 Decision Memo',
      recipients: 'maria@acme.com',
    })
    expect(state.active).toBe(true) // parked on the single context question
    state = advanceInterview(state, 'go ahead')
    expect(state.active).toBe(false)
    expect(state.spec?.intent).toBe('share_google_file')
    expect(state.spec?.details.file).toBe('Q3 Decision Memo')
    expect(state.spec?.details.recipients).toBe('maria@acme.com')
    expect(state.spec?.targetSystems).toEqual(['Google Drive — Sharing'])
  })

  /**
   * The property that separates sharing from the other Workspace authoring
   * intents: a share discloses content to a third party and fires a Google
   * notification that cannot be recalled, so it carries a server-verified gate
   * token exactly like a Gmail send.
   */
  it('is high-stakes (gate-token guarded), unlike doc/sheet creation', () => {
    expect(isHighStakesIntent('share_google_file')).toBe(true)
    expect(isHighStakesIntent('create_google_doc')).toBe(false)
    expect(isDestructiveIntent('share_google_file')).toBe(false)
    expect(isReadOnlyIntent('share_google_file')).toBe(false)
  })
})
