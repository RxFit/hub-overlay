import { describe, expect, it } from 'vitest'
import { lastAssistantContent } from './panel-artifact'

describe('lastAssistantContent (tool-panel parse trigger)', () => {
  it('returns the content of the last assistant message', () => {
    const msgs = [
      { role: 'user' as const, content: 'hi' },
      { role: 'assistant' as const, content: 'first' },
      { role: 'user' as const, content: 'more' },
      { role: 'assistant' as const, content: 'second' },
    ]
    expect(lastAssistantContent(msgs)).toBe('second')
  })

  it('CHANGES when the last assistant content changes even though length is constant (the streaming-staleness fix)', () => {
    const base = [
      { role: 'user' as const, content: 'q' },
      { role: 'assistant' as const, content: '' }, // empty bubble added, then streamed
    ]
    const streaming = [
      { role: 'user' as const, content: 'q' },
      { role: 'assistant' as const, content: 'Pro: it scales' }, // same length, filled content
    ]
    expect(base.length).toBe(streaming.length)
    expect(lastAssistantContent(base)).not.toBe(lastAssistantContent(streaming))
  })

  it('is stable once content stops changing (no infinite re-parse)', () => {
    const msgs = [{ role: 'assistant' as const, content: 'done' }]
    expect(lastAssistantContent(msgs)).toBe(lastAssistantContent([...msgs]))
  })

  it('ignores trailing user messages (a new user turn does not re-trigger a parse)', () => {
    const msgs = [
      { role: 'assistant' as const, content: 'artifact' },
      { role: 'user' as const, content: 'thanks' },
    ]
    expect(lastAssistantContent(msgs)).toBe('artifact')
  })

  it('returns empty string when there is no assistant message', () => {
    expect(lastAssistantContent([{ role: 'user' as const, content: 'hi' }])).toBe('')
    expect(lastAssistantContent([])).toBe('')
  })
})
