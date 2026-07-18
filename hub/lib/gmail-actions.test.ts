import { describe, it, expect } from 'vitest'
import {
  GMAIL_THREAD_ID_RE,
  gmailThreadUrl,
  buildTaskNotes,
  buildDiscussPrompt,
} from './gmail-actions'

describe('GMAIL_THREAD_ID_RE', () => {
  it('accepts real Gmail thread ids and rejects path-traversal shapes', () => {
    expect(GMAIL_THREAD_ID_RE.test('18c2f4a9b0d3e571')).toBe(true)
    expect(GMAIL_THREAD_ID_RE.test('thread_abc-123')).toBe(true)
    expect(GMAIL_THREAD_ID_RE.test('../labels')).toBe(false)
    expect(GMAIL_THREAD_ID_RE.test('a/b')).toBe(false)
    expect(GMAIL_THREAD_ID_RE.test('a?x=1')).toBe(false)
    expect(GMAIL_THREAD_ID_RE.test('')).toBe(false)
    expect(GMAIL_THREAD_ID_RE.test('x'.repeat(129))).toBe(false)
  })
})

describe('buildTaskNotes', () => {
  it('includes sender, snippet, and the Gmail deep link', () => {
    const notes = buildTaskNotes({
      from: 'Sarah Allen <sarah@x.com>',
      snippet: 'Hey Danny, SBG helps small operators',
      threadId: 't123',
    })
    expect(notes).toContain('From: Sarah Allen <sarah@x.com>')
    expect(notes).toContain('Preview: Hey Danny, SBG helps small operators')
    expect(notes).toContain(gmailThreadUrl('t123'))
  })

  it('omits empty fields but always keeps the link', () => {
    const notes = buildTaskNotes({ threadId: 't1' })
    expect(notes).toBe(gmailThreadUrl('t1'))
  })

  it('clips oversized fields', () => {
    const notes = buildTaskNotes({ from: 'a'.repeat(500), snippet: 'b'.repeat(900), threadId: 't1' })
    expect(notes.length).toBeLessThan(700)
  })
})

describe('buildDiscussPrompt', () => {
  it('carries subject, sender, and preview into a direct request', () => {
    const p = buildDiscussPrompt({
      subject: 'Re: rx fit capital?',
      from: 'Sarah Allen <sarah@x.com>',
      snippet: 'SBG helps small operators',
    })
    expect(p).toContain('Subject: Re: rx fit capital?')
    expect(p).toContain('From: Sarah Allen')
    expect(p).toContain('Preview: SBG helps small operators')
    expect(p.toLowerCase()).toContain('discuss')
  })

  it('falls back gracefully when fields are missing', () => {
    const p = buildDiscussPrompt({})
    expect(p).toContain('<email_data>')
    expect(p).toContain('(no subject)')
    expect(p).toContain('unknown sender')
    expect(p).not.toContain('Preview:')
  })
})
