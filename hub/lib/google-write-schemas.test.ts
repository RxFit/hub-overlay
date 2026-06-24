import { describe, it, expect } from 'vitest'
import {
  GoogleTaskCreateSchema,
  GoogleCalendarCreateSchema,
  GoogleGmailSendSchema,
  GoogleChatSendSchema,
} from './zod-schemas'

/* Bound user input on Google mutations (audit P1/P2). */
describe('Google write-request schemas', () => {
  it('accepts a valid task and rejects empty/oversized titles', () => {
    expect(GoogleTaskCreateSchema.safeParse({ title: 'Pay invoice' }).success).toBe(true)
    expect(GoogleTaskCreateSchema.safeParse({ title: '' }).success).toBe(false)
    expect(GoogleTaskCreateSchema.safeParse({ title: '   ' }).success).toBe(false)
    expect(GoogleTaskCreateSchema.safeParse({ title: 'x'.repeat(2000) }).success).toBe(false)
    expect(GoogleTaskCreateSchema.safeParse({ title: 'ok', notes: 'n'.repeat(9000) }).success).toBe(false)
  })

  it('requires summary/start/end and bounds attendees on calendar events', () => {
    const ok = GoogleCalendarCreateSchema.safeParse({ summary: 'Sync', start: '2026-06-20T09:00:00', end: '2026-06-20T10:00:00' })
    expect(ok.success).toBe(true)
    expect(GoogleCalendarCreateSchema.safeParse({ summary: 'x', start: '', end: '' }).success).toBe(false)
    expect(GoogleCalendarCreateSchema.safeParse({
      summary: 'x', start: 's', end: 'e', attendees: ['not-an-email'],
    }).success).toBe(false)
    expect(GoogleCalendarCreateSchema.safeParse({
      summary: 'x', start: 's', end: 'e', attendees: Array.from({ length: 101 }, (_, i) => `a${i}@x.com`),
    }).success).toBe(false)
  })

  it('requires recipient + message and caps message size on gmail send', () => {
    expect(GoogleGmailSendSchema.safeParse({ to: 'a@b.com', message: 'hi' }).success).toBe(true)
    expect(GoogleGmailSendSchema.safeParse({ to: '', message: 'hi' }).success).toBe(false)
    expect(GoogleGmailSendSchema.safeParse({ to: 'a@b.com', message: '' }).success).toBe(false)
    expect(GoogleGmailSendSchema.safeParse({ to: 'a@b.com', message: 'x'.repeat(1_000_001) }).success).toBe(false)
  })

  it('requires spaceId + text and caps chat message length', () => {
    expect(GoogleChatSendSchema.safeParse({ spaceId: 'spaces/x', text: 'hello' }).success).toBe(true)
    expect(GoogleChatSendSchema.safeParse({ spaceId: 'spaces/x', text: '   ' }).success).toBe(false)
    expect(GoogleChatSendSchema.safeParse({ spaceId: 'spaces/x', text: 'x'.repeat(5000) }).success).toBe(false)
  })
})
