import { describe, it, expect } from 'vitest'
import {
  INTERVIEW_SCAFFOLD_KIND,
  isInterviewScaffold,
  type ChatMsgKind,
} from './interview-scaffold'

// Message-shaped stand-in mirroring the relevant fields of the app's ChatMsg.
type Msg = { id?: string; content?: string; kind?: ChatMsgKind }

describe('isInterviewScaffold', () => {
  it('returns true for a message tagged with the scaffold kind', () => {
    expect(
      isInterviewScaffold({ kind: INTERVIEW_SCAFFOLD_KIND }),
    ).toBe(true)
  })

  it('returns false for an untagged message', () => {
    expect(isInterviewScaffold({})).toBe(false)
  })

  it('does NOT delete a user message that merely contains scaffold text (the bug this fixes)', () => {
    // Previously cleanup matched on content substrings, so a real message
    // containing "Interview complete!" was wrongly stripped from history.
    const userMsg: Msg = {
      content: 'Interview complete! Great, the briefing looks perfect.',
    }
    expect(isInterviewScaffold(userMsg)).toBe(false)
  })

  it('keeps non-scaffold messages when used as a survival filter', () => {
    const messages: Msg[] = [
      { id: '1', content: 'Interview complete! Please review the action below.', kind: INTERVIEW_SCAFFOLD_KIND },
      { id: '2', content: 'Briefing approved by AI quality gate.', kind: INTERVIEW_SCAFFOLD_KIND },
      { id: '3', content: 'user says: is the interview complete!?' },
      { id: '4', content: 'assistant: here is your answer' },
    ]
    const survivors = messages.filter(m => !isInterviewScaffold(m))
    expect(survivors.map(m => m.id)).toEqual(['3', '4'])
  })
})
