import { describe, it, expect } from 'vitest'
import { tokenizeChatMarkup } from './chat-markup'

/* ════════════════════════════════════════════════════════════════════════════
   lib/chat-markup — Google Chat's OWN grammar, which is not markdown:
   *bold* is single-asterisk bold, _italic_, ~strike~, `code`, ```blocks```,
   <url|label> app links, bare-URL autolinking. Tokens only — the renderer maps
   them to elements, so nothing here can emit HTML.
   ════════════════════════════════════════════════════════════════════════════ */

describe('tokenizeChatMarkup', () => {
  it('reads Chat grammar, not markdown: *x* is BOLD', () => {
    expect(tokenizeChatMarkup('ship *today* please')).toEqual([
      { type: 'text', text: 'ship ' },
      { type: 'bold', text: 'today' },
      { type: 'text', text: ' please' },
    ])
  })

  it('handles italic, strike and code spans in one line', () => {
    expect(tokenizeChatMarkup('_soft_ ~dead~ `npm ci`')).toEqual([
      { type: 'italic', text: 'soft' },
      { type: 'text', text: ' ' },
      { type: 'strike', text: 'dead' },
      { type: 'text', text: ' ' },
      { type: 'code', text: 'npm ci' },
    ])
  })

  it('leaves snake_case and arithmetic literal (word-boundary rule)', () => {
    expect(tokenizeChatMarkup('use chat_space_prefs and 3*4*5')).toEqual([
      { type: 'text', text: 'use chat_space_prefs and 3*4*5' },
    ])
  })

  it('autolinks bare URLs without swallowing trailing punctuation', () => {
    expect(tokenizeChatMarkup('see https://rxfitatx.com/plans.')).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'link', href: 'https://rxfitatx.com/plans', text: 'https://rxfitatx.com/plans' },
      { type: 'text', text: '.' },
    ])
  })

  it('reads the app link markup <url|label> (what Hermes sends)', () => {
    expect(tokenizeChatMarkup('build <https://ci.example.com/run/9|is green>')).toEqual([
      { type: 'text', text: 'build ' },
      { type: 'link', href: 'https://ci.example.com/run/9', text: 'is green' },
    ])
  })

  it('treats a fenced block as opaque — inline markers inside stay literal', () => {
    expect(tokenizeChatMarkup('try\n```\nconst x = a * b_c\n```\nok?')).toEqual([
      { type: 'text', text: 'try\n' },
      { type: 'codeblock', text: 'const x = a * b_c' },
      { type: 'text', text: '\nok?' },
    ])
  })

  it('renders an unclosed fence literally instead of eating the rest of the message', () => {
    expect(tokenizeChatMarkup('oops ```half open *still bold*')).toEqual([
      { type: 'text', text: 'oops ```half open ' },
      { type: 'bold', text: 'still bold' },
    ])
  })

  it('passes plain text through untouched', () => {
    expect(tokenizeChatMarkup('just words')).toEqual([{ type: 'text', text: 'just words' }])
    expect(tokenizeChatMarkup('')).toEqual([])
  })
})
