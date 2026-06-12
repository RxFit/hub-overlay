import { describe, it, expect } from 'vitest'
import {
  hasPermission,
  startInterview,
  advanceInterview,
  buildConfirmationSpec,
  isDestructiveIntent,
  isReadOnlyIntent,
  getTotalQuestions,
} from '@/lib/interview'

describe('hasPermission', () => {
  it('grants staff-level intents to staff and above', () => {
    expect(hasPermission('staff', 'create_task')).toBe(true)
    expect(hasPermission('admin', 'create_task')).toBe(true)
    expect(hasPermission('superadmin', 'create_task')).toBe(true)
  })

  it('denies staff-level intents to onboarding', () => {
    expect(hasPermission('onboarding', 'create_task')).toBe(false)
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
    expect(spec.requiredPermission).toBe('staff')
    expect(getTotalQuestions('create_task')).toBe(2)
  })
})
