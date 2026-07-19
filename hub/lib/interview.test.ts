import { describe, it, expect } from 'vitest'
import {
  hasPermission,
  startInterview,
  advanceInterview,
  buildConfirmationSpec,
  isDestructiveIntent,
  isReadOnlyIntent,
  isHighStakesIntent,
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

describe('interview flow', () => {
  it('advances create_task through its question sequence to a spec', () => {
    let state = startInterview('create_task')
    expect(state.active).toBe(true)
    expect(state.step).toBe(0)

    // answer the description question
    state = advanceInterview(state, 'Email the new client onboarding pack')
    expect(state.active).toBe(true) // _confirm still pending

    // answer the confirm question -> interview completes with a spec
    state = advanceInterview(state, 'yes')
    expect(state.active).toBe(false)
    expect(state.spec).not.toBeNull()
    expect(state.spec?.intent).toBe('create_task')
  })

  it('fast-forwards past pre-filled answers', () => {
    const state = startInterview('create_task', { description: 'prefilled task' })
    // description was prefilled, so we should be parked on the _confirm step
    expect(state.active).toBe(true)
    expect(state.step).toBe(1)
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
    expect(getTotalQuestions('create_task')).toBe(2)
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

  it('advances through taskRef and change to a spec', () => {
    let state = startInterview('update_task')
    expect(getTotalQuestions('update_task')).toBe(3)

    state = advanceInterview(state, 'invoice follow-up')
    state = advanceInterview(state, 'mark done')
    expect(state.active).toBe(true) // parked on _confirm

    state = advanceInterview(state, 'yes')
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

  it('advances send_gmail through to _confirm and builds a spec', () => {
    let state = startInterview('send_gmail')
    expect(state.active).toBe(true)
    expect(getTotalQuestions('send_gmail')).toBe(4)

    state = advanceInterview(state, 'maria@rxfitatx.com')
    state = advanceInterview(state, '') // subject → default '(no subject)'
    state = advanceInterview(state, 'The invoice is paid')
    expect(state.active).toBe(true) // parked on _confirm

    state = advanceInterview(state, 'yes')
    expect(state.active).toBe(false)
    expect(state.spec?.intent).toBe('send_gmail')
    expect(state.spec?.details.to).toBe('maria@rxfitatx.com')
    expect(state.spec?.details.subject).toBe('(no subject)')
    expect(state.spec?.details.body).toBe('The invoice is paid')
    expect(state.spec?.targetSystems).toEqual(['Gmail'])
    expect(state.spec?.requiredPermission).toBe('staff')
  })

  it('advances post_chat_message through to _confirm and builds a spec', () => {
    let state = startInterview('post_chat_message')
    expect(getTotalQuestions('post_chat_message')).toBe(3)

    state = advanceInterview(state, 'RxFit Ops')
    state = advanceInterview(state, 'Demo moved to 3pm')
    expect(state.active).toBe(true) // parked on _confirm

    state = advanceInterview(state, 'yes')
    expect(state.active).toBe(false)
    expect(state.spec?.intent).toBe('post_chat_message')
    expect(state.spec?.details.space).toBe('RxFit Ops')
    expect(state.spec?.details.message).toBe('Demo moved to 3pm')
    expect(state.spec?.targetSystems).toEqual(['Google Chat'])
    expect(state.spec?.requiredPermission).toBe('staff')
  })

  it('fast-forwards past extracted entities to _confirm', () => {
    const state = startInterview('send_gmail', {
      to: 'maria@rxfitatx.com',
      subject: 'Invoice',
      body: 'The invoice is paid',
    })
    expect(state.active).toBe(true)
    expect(state.step).toBe(3) // parked on _confirm
  })
})
