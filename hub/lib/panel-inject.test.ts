import { describe, it, expect } from 'vitest'
import {
  buildTaskInjectMessage,
  buildEventInjectMessage,
  buildDocumentInject,
  formatRelativeDate,
  formatShortDate,
  formatDueDate,
} from './panel-inject'

/* ════════════════════════════════════════════════════════════════════════════
   STRESS TEST — panel → chat inject payload builders
   These are the exact strings/attachments sent into the primary chat when a
   left-panel item is tapped. Hammered here with adversarial input: huge fields,
   whitespace/control chars, missing data, and high-volume loops.
   ════════════════════════════════════════════════════════════════════════════ */

describe('buildTaskInjectMessage', () => {
  it('carries list, title, status, due, and notes', () => {
    const msg = buildTaskInjectMessage(
      { title: 'Pay the toffee invoice', status: 'needsAction', due: new Date().toISOString(), notes: 'call vendor' },
      'Finance',
    )
    expect(msg).toContain('"Finance"')
    expect(msg).toContain('• Title: Pay the toffee invoice')
    expect(msg).toContain('• Status: Pending')
    expect(msg).toContain('• Due:')
    expect(msg).toContain('• Notes: call vendor')
  })

  it('maps completed status and omits missing due/notes', () => {
    const msg = buildTaskInjectMessage({ title: 'Done thing', status: 'completed' }, 'Personal')
    expect(msg).toContain('• Status: Completed')
    expect(msg).not.toContain('• Due:')
    expect(msg).not.toContain('• Notes:')
    // exactly 3 lines (header, title, status)
    expect(msg.split('\n')).toHaveLength(3)
  })

  it('clamps a pathological 50k-char note to 500 and collapses whitespace', () => {
    const note = 'a\n\t  b   '.repeat(10_000) // huge + messy whitespace
    const msg = buildTaskInjectMessage({ title: 'x', status: 'needsAction', notes: note }, 'L')
    const noteLine = msg.split('\n').find(l => l.startsWith('• Notes:'))!
    const content = noteLine.replace('• Notes: ', '')
    expect(content.length).toBeLessThanOrEqual(500)
    expect(content).not.toMatch(/[\n\t]/)       // no control whitespace
    expect(content).not.toMatch(/ {2,}/)        // no runs of spaces
  })

  it('does not throw on empty / unicode / emoji titles', () => {
    for (const title of ['', '🔥'.repeat(2_000), 'naïve café — 日本語', '"quotes" & <tags>']) {
      expect(() => buildTaskInjectMessage({ title, status: 'needsAction' }, 'L')).not.toThrow()
    }
  })

  it('stays deterministic and fast over 10k builds', () => {
    const start = Date.now()
    let last = ''
    for (let i = 0; i < 10_000; i++) {
      last = buildTaskInjectMessage({ title: `t${i}`, status: 'needsAction', notes: 'n' }, 'L')
    }
    expect(last).toContain('t9999')
    expect(Date.now() - start).toBeLessThan(2_000)
  })
})

describe('buildEventInjectMessage', () => {
  it('renders a timed event with location and details', () => {
    const msg = buildEventInjectMessage({
      summary: 'Client sync',
      start: { dateTime: new Date().toISOString() },
      location: 'Zoom',
      description: 'quarterly review',
    })
    expect(msg).toContain('• Title: Client sync')
    expect(msg).toContain(' at ')
    expect(msg).toContain('• Location: Zoom')
    expect(msg).toContain('• Details: quarterly review')
  })

  it('handles all-day events, missing summary, and no start', () => {
    const allDay = buildEventInjectMessage({ start: { date: '2026-06-20' } })
    expect(allDay).toContain('(all day)')
    expect(allDay).toContain('(untitled)')

    const noStart = buildEventInjectMessage({ summary: 'floating', start: {} })
    expect(noStart).toContain('• When: unscheduled')
  })

  it('clamps a giant description', () => {
    const msg = buildEventInjectMessage({
      summary: 's',
      start: { dateTime: new Date().toISOString() },
      description: 'x '.repeat(50_000),
    })
    const detail = msg.split('\n').find(l => l.startsWith('• Details:'))!.replace('• Details: ', '')
    expect(detail.length).toBeLessThanOrEqual(500)
  })
})

describe('buildDocumentInject', () => {
  it('produces a transcript-summary message + a document attachment with the real fileId', () => {
    const { message, attachment } = buildDocumentInject(
      { id: 'file-123', name: 'Standup 6/17', mimeType: 'application/vnd.google-apps.document' },
      true,
    )
    expect(message).toMatch(/Summarize the meeting transcript "Standup 6\/17"/)
    expect(attachment).toMatchObject({
      id: 'file-123',
      type: 'document',
      label: 'Standup 6/17',
      fileId: 'file-123',
      mimeType: 'application/vnd.google-apps.document',
    })
  })

  it('produces a document message for non-transcripts and always carries the fileId', () => {
    const { message, attachment } = buildDocumentInject({ id: 'f', name: 'Plan.pdf', mimeType: 'application/pdf' }, false)
    expect(message).toMatch(/Tell me about the document "Plan\.pdf"/)
    expect(attachment.fileId).toBe('f')
  })
})

describe('date formatters are crash-proof on bad input', () => {
  it('never throws on garbage / empty / huge strings', () => {
    for (const v of ['', 'not-a-date', '💥', '9'.repeat(1000)]) {
      expect(() => formatRelativeDate(v)).not.toThrow()
      expect(() => formatShortDate(v)).not.toThrow()
      expect(typeof formatRelativeDate(v)).toBe('string')
    }
  })

  it('formatRelativeDate buckets recent timestamps correctly', () => {
    const now = Date.now()
    expect(formatRelativeDate(new Date(now - 10_000).toISOString())).toBe('just now')
    expect(formatRelativeDate(new Date(now - 5 * 60_000).toISOString())).toBe('5m ago')
    expect(formatRelativeDate(new Date(now - 3 * 3_600_000).toISOString())).toBe('3h ago')
  })
})

describe('formatDueDate (Google Tasks due, date-only UTC midnight)', () => {
  // Build a UTC-midnight `due` string for a local calendar day offset by `days`.
  // This mirrors exactly what Google Tasks returns (e.g. 2026-06-25T00:00:00.000Z).
  function dueForLocalOffset(days: number): string {
    const now = new Date()
    const local = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days)
    const y = local.getFullYear()
    const m = String(local.getMonth() + 1).padStart(2, '0')
    const d = String(local.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}T00:00:00.000Z`
  }

  it('labels today / tomorrow / future / overdue from a signed day delta', () => {
    expect(formatDueDate(dueForLocalOffset(0))).toBe('Today')
    expect(formatDueDate(dueForLocalOffset(1))).toBe('Tomorrow')
    expect(formatDueDate(dueForLocalOffset(3))).toBe('in 3d')
    expect(formatDueDate(dueForLocalOffset(-1))).toBe('Yesterday (overdue)')
    expect(formatDueDate(dueForLocalOffset(-3))).toBe('3d overdue')
  })

  it('does NOT regress a future UTC-midnight due to "just now" and does not shift the day', () => {
    const tomorrow = dueForLocalOffset(1)
    expect(formatDueDate(tomorrow)).toBe('Tomorrow')
    expect(formatDueDate(tomorrow)).not.toBe('just now')
    // Today's UTC-midnight value must read "Today", not "Yesterday" (no backward shift).
    expect(formatDueDate(dueForLocalOffset(0))).toBe('Today')
  })

  it('falls back to the raw string on garbage and never throws', () => {
    for (const v of ['', 'not-a-date', '💥', '9'.repeat(1000)]) {
      expect(() => formatDueDate(v)).not.toThrow()
      expect(typeof formatDueDate(v)).toBe('string')
    }
  })

  it('formatRelativeDate remains past-only for genuinely past instants (unchanged)', () => {
    const now = Date.now()
    expect(formatRelativeDate(new Date(now - 10_000).toISOString())).toBe('just now')
    expect(formatRelativeDate(new Date(now - 5 * 60_000).toISOString())).toBe('5m ago')
  })
})
