// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { sanitizeEmailHtml } from './sanitize-email'

describe('sanitizeEmailHtml', () => {
  it('strips <script> blocks', () => {
    const out = sanitizeEmailHtml('<p>hi</p><script>fetch("https://evil.example")</script>')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('fetch')
    expect(out).toContain('<p>hi</p>')
  })

  it('strips onerror/onclick event handlers', () => {
    const out = sanitizeEmailHtml(
      '<img src="https://example.com/a.png" onerror="alert(1)"><button onclick="alert(2)">go</button>'
    )
    expect(out).not.toContain('onerror')
    expect(out).not.toContain('onclick')
    expect(out).toContain('src="https://example.com/a.png"')
  })

  it('strips javascript: hrefs', () => {
    const out = sanitizeEmailHtml('<a href="javascript:alert(1)">click</a>')
    expect(out).not.toContain('javascript:')
    expect(out).toContain('click')
  })

  it('strips <iframe>', () => {
    const out = sanitizeEmailHtml('<iframe src="https://evil.example"></iframe><p>ok</p>')
    expect(out).not.toContain('<iframe')
    expect(out).toContain('<p>ok</p>')
  })

  it('strips <form>', () => {
    const out = sanitizeEmailHtml('<form action="https://evil.example"><input name="pw"></form>')
    expect(out).not.toContain('<form')
  })

  it('strips <meta http-equiv> and <link>', () => {
    const out = sanitizeEmailHtml(
      '<meta http-equiv="refresh" content="0;url=https://evil.example"><link rel="stylesheet" href="https://evil.example/x.css"><p>ok</p>'
    )
    expect(out).not.toContain('<meta')
    expect(out).not.toContain('<link')
    expect(out).toContain('<p>ok</p>')
  })

  it('keeps paragraphs, https links and images', () => {
    const html = '<p>Hello</p><a href="https://example.com/offer">Shop</a><img src="https://example.com/logo.png" alt="logo">'
    const out = sanitizeEmailHtml(html)
    expect(out).toContain('<p>Hello</p>')
    expect(out).toContain('href="https://example.com/offer"')
    expect(out).toContain('src="https://example.com/logo.png"')
  })

  it('keeps tables and inline styles', () => {
    const html = '<table style="width:100%"><tr><td style="color:#333">cell</td></tr></table>'
    const out = sanitizeEmailHtml(html)
    expect(out).toContain('<table')
    expect(out).toContain('<tr>')
    expect(out).toContain('<td')
    expect(out).toContain('style=')
    expect(out).toContain('cell')
  })

  it('fails closed (returns empty string) without a DOM', () => {
    // Simulate a no-DOM (SSR-like) environment; DOMPurify would otherwise
    // return its input unchanged.
    vi.stubGlobal('window', undefined)
    try {
      expect(sanitizeEmailHtml('<script>alert(1)</script><p>hi</p>')).toBe('')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('passes plain text through unchanged', () => {
    const text = 'Hi Danny,\n\nYour order shipped. Tracking: 1Z999 & more soon.\n\nThanks'
    expect(sanitizeEmailHtml(text)).toBe(text)
  })
})
