import { describe, it, expect } from 'vitest'
import { buildTranscript, mergeTranscript, resolveVoiceError } from './useVoiceInput'

/** Build a minimal SpeechRecognitionResultList-shaped fixture. */
function results(segments: Array<{ text: string; isFinal: boolean }>) {
  const list = segments.map(s => ({
    isFinal: s.isFinal,
    0: { transcript: s.text },
    length: 1,
  }))
  return Object.assign(list, { length: list.length })
}

describe('buildTranscript', () => {
  it('returns empty string for no results', () => {
    expect(buildTranscript(results([]))).toBe('')
  })

  it('concatenates finalized segments', () => {
    expect(buildTranscript(results([
      { text: 'create a task ', isFinal: true },
      { text: 'for tomorrow', isFinal: true },
    ]))).toBe('create a task for tomorrow')
  })

  it('appends interim text after finalized text', () => {
    expect(buildTranscript(results([
      { text: 'check the ', isFinal: true },
      { text: 'pipeline status', isFinal: false },
    ]))).toBe('check the pipeline status')
  })

  it('orders all finals before interims regardless of list order', () => {
    // Engines keep finals stable and re-emit interims; a rebuilt transcript
    // must never interleave a stale interim into finalized text.
    expect(buildTranscript(results([
      { text: 'draft an email ', isFinal: true },
      { text: 'to the ', isFinal: false },
      { text: 'team', isFinal: false },
    ]))).toBe('draft an email to the team')
  })

  it('trims surrounding whitespace', () => {
    expect(buildTranscript(results([{ text: '  hello  ', isFinal: true }]))).toBe('hello')
  })
})

describe('mergeTranscript', () => {
  it('returns base unchanged when transcript is empty', () => {
    expect(mergeTranscript('typed text', '')).toBe('typed text')
  })

  it('returns transcript alone when base is empty', () => {
    expect(mergeTranscript('', 'spoken text')).toBe('spoken text')
  })

  it('joins base and transcript with exactly one space', () => {
    expect(mergeTranscript('typed', 'spoken')).toBe('typed spoken')
    expect(mergeTranscript('typed   ', 'spoken')).toBe('typed spoken')
  })
})

describe('resolveVoiceError', () => {
  it('suppresses benign codes (silence, user abort)', () => {
    expect(resolveVoiceError('no-speech')).toBeNull()
    expect(resolveVoiceError('aborted')).toBeNull()
  })

  it('maps permission denial to actionable copy', () => {
    expect(resolveVoiceError('not-allowed')).toMatch(/microphone access/i)
    expect(resolveVoiceError('service-not-allowed')).toMatch(/microphone access/i)
  })

  it('maps missing microphone to actionable copy', () => {
    expect(resolveVoiceError('audio-capture')).toMatch(/no microphone/i)
  })

  it('maps network failures to actionable copy', () => {
    expect(resolveVoiceError('network')).toMatch(/network/i)
  })

  it('falls back to a generic message for unknown codes', () => {
    expect(resolveVoiceError('bad-grammar')).toMatch(/try again/i)
  })
})
