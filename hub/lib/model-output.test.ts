import { describe, it, expect } from 'vitest'
import {
  stripSuggestedTools,
  extractSuggestedToolsJson,
  stripDegradedBanner,
  stripTrailingPartialSuggestedTools,
  sanitizeAssistantHistoryContent,
} from './model-output'

describe('stripSuggestedTools', () => {
  it('strips the canonical single-line comment', () => {
    const text = 'Here is my answer.\n\n<!--suggestedTools:["prioritization","canary"]-->'
    expect(stripSuggestedTools(text)).toBe('Here is my answer.\n\n')
  })

  it('strips despite whitespace drift around the marker and array', () => {
    const text = 'Answer.\n<!-- suggestedTools : ["a","b"] -->'
    expect(stripSuggestedTools(text)).toBe('Answer.\n')
  })

  it('strips a comment whose array spans multiple lines', () => {
    const text = 'Answer.\n<!--suggestedTools:["prioritization",\n"document-release"]-->'
    expect(stripSuggestedTools(text)).toBe('Answer.\n')
  })

  it('strips every occurrence, not just the first', () => {
    const text = '<!--suggestedTools:["a"]-->middle<!--suggestedTools:["b"]-->'
    expect(stripSuggestedTools(text)).toBe('middle')
  })

  it('leaves text without the comment untouched', () => {
    expect(stripSuggestedTools('plain text')).toBe('plain text')
  })
})

describe('extractSuggestedToolsJson', () => {
  it('returns the raw array source of the first comment', () => {
    const text = 'Answer <!--suggestedTools:["scpr","investigate"]--> tail'
    expect(extractSuggestedToolsJson(text)).toBe('["scpr","investigate"]')
  })

  it('tolerates whitespace and newlines inside the comment', () => {
    const text = '<!-- suggestedTools: ["a",\n"b"] -->'
    expect(extractSuggestedToolsJson(text)).toBe('["a",\n"b"]')
  })

  it('returns null when no comment exists', () => {
    expect(extractSuggestedToolsJson('no metadata here')).toBeNull()
  })

  it('is stateless across calls (no /g lastIndex bleed)', () => {
    const text = '<!--suggestedTools:["a"]-->'
    expect(extractSuggestedToolsJson(text)).toBe('["a"]')
    expect(extractSuggestedToolsJson(text)).toBe('["a"]')
  })
})

describe('stripDegradedBanner', () => {
  it('strips the exact banner the rotation layer injects', () => {
    const text = '⚠️ *Primary model unavailable — using Claude Sonnet 4.6*\n\nThe real answer.'
    expect(stripDegradedBanner(text)).toBe('The real answer.')
  })

  it('strips a model-echoed duplicate as well (the doubled-banner bug)', () => {
    const text =
      '⚠️ *Primary model unavailable — using Claude Sonnet 4.6*\n\n' +
      '⚠️ *Primary model unavailable — using Claude Sonnet 4.6*\n\n' +
      'Locked in.'
    expect(stripDegradedBanner(text)).toBe('Locked in.')
  })

  it('strips the raw-model-id variant from the Gemini intra-chain banner', () => {
    const text = '⚠️ *Primary model unavailable — using gemini-2.5-pro*\n\nAnswer'
    expect(stripDegradedBanner(text)).toBe('Answer')
  })

  it('does not touch ordinary warning lines', () => {
    const text = '⚠️ Heads up: the deploy failed.'
    expect(stripDegradedBanner(text)).toBe(text)
  })
})

describe('stripTrailingPartialSuggestedTools', () => {
  it('hides an unterminated comment mid-stream', () => {
    const text = 'Answer.\n\n<!--suggestedTools:["priorit'
    expect(stripTrailingPartialSuggestedTools(text)).toBe('Answer.\n\n')
  })

  it('hides a bare "<!--" opener', () => {
    expect(stripTrailingPartialSuggestedTools('Answer <!--')).toBe('Answer ')
  })

  it('hides a partially-streamed marker', () => {
    expect(stripTrailingPartialSuggestedTools('Answer <!--suggestedTo')).toBe('Answer ')
  })

  it('leaves a COMPLETE comment for the full strip to handle', () => {
    const text = 'Answer <!--suggestedTools:["a"]-->'
    expect(stripTrailingPartialSuggestedTools(text)).toBe(text)
  })

  it('leaves an unterminated non-metadata comment alone', () => {
    const text = 'code sample: <!-- TODO fix this'
    expect(stripTrailingPartialSuggestedTools(text)).toBe(text)
  })

  it('leaves comment-free text alone', () => {
    expect(stripTrailingPartialSuggestedTools('hello')).toBe('hello')
  })
})

describe('sanitizeAssistantHistoryContent', () => {
  it('drops banner + metadata, keeping the real answer', () => {
    const stored =
      '⚠️ *Primary model unavailable — using Claude Sonnet 4.6*\n\n' +
      'Here is your action card.\n\n' +
      '<!--suggestedTools:["prioritization","canary"]-->'
    expect(sanitizeAssistantHistoryContent(stored)).toBe('Here is your action card.')
  })

  it('reduces a banner-only bubble to empty (caller drops it from history)', () => {
    const stored = '⚠️ *Primary model unavailable — using Claude Sonnet 4.6*\n\n'
    expect(sanitizeAssistantHistoryContent(stored)).toBe('')
  })

  it('passes ordinary content through unchanged apart from trimming', () => {
    expect(sanitizeAssistantHistoryContent('  Normal reply.  ')).toBe('Normal reply.')
  })
})
