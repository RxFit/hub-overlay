import { describe, it, expect } from 'vitest'
import {
  detectRecurrence,
  deriveSolutionSuggestion,
  topicHash,
} from '@/lib/solution-suggest'

describe('detectRecurrence', () => {
  it('parses "every day at 9am" → daily 9am cron', () => {
    const r = detectRecurrence('remind me to check token usage every day at 9am')
    expect(r.isRecurring).toBe(true)
    expect(r.cron).toBe('0 9 * * *')
  })

  it('parses weekdays and specific weekday', () => {
    expect(detectRecurrence('every weekday at 8:30').cron).toBe('30 8 * * 1-5')
    expect(detectRecurrence('every Monday at 9am').cron).toBe('0 9 * * 1')
  })

  it('parses hourly / weekly / monthly', () => {
    expect(detectRecurrence('check the queue hourly').cron).toBe('0 * * * *')
    expect(detectRecurrence('every week at 10am').cron).toBe('0 10 * * 1')
    expect(detectRecurrence('monthly at midnight').cron).toBe('0 0 1 * *')
  })

  it('handles pm and noon/midnight', () => {
    expect(detectRecurrence('every day at 5pm').cron).toBe('0 17 * * *')
    expect(detectRecurrence('daily at noon').cron).toBe('0 12 * * *')
  })

  it('defaults to 9am when a cadence has no clock', () => {
    expect(detectRecurrence('email me a summary every day').cron).toBe('0 9 * * *')
    expect(detectRecurrence('every morning').cron).toBe('0 9 * * *')
  })

  it('does not anchor the schedule on a stray count before the real time', () => {
    // "3 metrics" must not become 3am; the explicit "9am" wins.
    expect(detectRecurrence('check 3 metrics every day at 9am').cron).toBe('0 9 * * *')
  })

  it('recurring word but unclear cadence → recurring, null cron', () => {
    const r = detectRecurrence('do this on a recurring basis')
    expect(r.isRecurring).toBe(true)
    expect(r.cron).toBeNull()
  })

  it('non-recurring text → not recurring', () => {
    expect(detectRecurrence('remind me to call the vendor tomorrow').isRecurring).toBe(false)
    expect(detectRecurrence('book a meeting with Sarah').isRecurring).toBe(false)
  })
})

describe('topicHash', () => {
  it('collapses rephrasings of the same topic', () => {
    const a = topicHash('remind me to check token usage every day at 9am')
    const b = topicHash('check the token usage daily please')
    expect(a).toBe(b)
  })

  it('distinguishes different topics', () => {
    expect(topicHash('check token usage daily')).not.toBe(topicHash('check SEO rankings daily'))
  })
})

describe('deriveSolutionSuggestion', () => {
  it('offers a routine for the flagship recurring+agent-doable case', () => {
    const s = deriveSolutionSuggestion('create_task', 'remind me to check Anthropic token usage every day at 9am and send it to Google Chat')
    expect(s).not.toBeNull()
    expect(s!.primitive).toBe('routine')
    expect(s!.targetIntent).toBe('create_routine')
    expect(s!.prefill.schedule).toBe('0 9 * * *')
    expect(s!.prefill.description).toMatch(/Google Chat/)
    expect(s!.confidence).toBeGreaterThanOrEqual(0.85)
    expect(s!.dismissKey.startsWith('routine:')).toBe(true)
  })

  it('offers a lite routine for a recurring reminder that is not agent-doable', () => {
    const s = deriveSolutionSuggestion('create_task', 'remind me every day to stretch')
    expect(s?.primitive).toBe('routine')
    expect(s!.confidence).toBeLessThan(0.85)
  })

  it('offers agent delegation for one-off agent-doable work', () => {
    const s = deriveSolutionSuggestion('create_task', 'remind me to reconcile the Stripe payouts')
    expect(s?.primitive).toBe('issue')
    expect(s?.targetIntent).toBe('create_paperclip_issue')
  })

  it('offers a project for multi-step deliverables', () => {
    const s = deriveSolutionSuggestion('create_task', 'launch a referral marketing campaign end-to-end')
    expect(s?.primitive).toBe('project')
  })

  it('offers a goal for aspirational phrasing', () => {
    const s = deriveSolutionSuggestion('create_task', 'our goal is to reach $1M ARR by Q4')
    expect(s?.primitive).toBe('goal')
    expect(s?.targetIntent).toBe('create_goal')
  })

  it('returns null for non-upgradeable intents', () => {
    expect(deriveSolutionSuggestion('delete_agent', 'delete the QA agent every day')).toBeNull()
    expect(deriveSolutionSuggestion('check_agent_status', 'how is the CMO doing every day')).toBeNull()
    expect(deriveSolutionSuggestion(null, 'anything at all')).toBeNull()
  })

  it('returns null for a plain one-off task with no upgrade signal', () => {
    expect(deriveSolutionSuggestion('create_task', 'buy milk')).toBeNull()
  })
})
