import { describe, it, expect } from 'vitest'
import { isValidElement } from 'react'
import { parseInlineMarkdown } from './MessageContent'

/* ════════════════════════════════════════════════════════════════════════════
   parseInlineMarkdown — the chat bubble's inline renderer.

   Locks the link-rendering contract (markdown [text](url) + bare URLs become
   safe anchors; unsafe schemes never do) and guards the existing bold/italic/
   tool-ref behavior against regex group drift — the alternation's group
   indices shifted when links were added, so these are load-bearing.
   ════════════════════════════════════════════════════════════════════════════ */

type ElementNode = { type: unknown; props: Record<string, unknown> }

const elements = (nodes: React.ReactNode[]): ElementNode[] =>
  nodes.filter(isValidElement) as unknown as ElementNode[]

describe('parseInlineMarkdown — links', () => {
  it('renders a markdown link as a safe anchor (new tab + noopener)', () => {
    const nodes = parseInlineMarkdown('see [the paper](https://arxiv.org/abs/1234) for details')
    const [a] = elements(nodes).filter(n => n.type === 'a')
    expect(a).toBeDefined()
    expect(a.props.href).toBe('https://arxiv.org/abs/1234')
    expect(a.props.target).toBe('_blank')
    expect(a.props.rel).toBe('noopener noreferrer')
    expect(a.props.children).toBe('the paper')
    // Surrounding text is preserved
    expect(nodes[0]).toBe('see ')
    expect(nodes[nodes.length - 1]).toBe(' for details')
  })

  it('renders a bare URL as an anchor and keeps trailing punctuation as text', () => {
    const nodes = parseInlineMarkdown('source: https://example.com/report. Next line')
    const [a] = elements(nodes).filter(n => n.type === 'a')
    expect(a.props.href).toBe('https://example.com/report')
    expect(a.props.children).toBe('https://example.com/report')
    // The sentence period is NOT part of the href
    expect(nodes.join('')).not.toContain('report..')
    expect(nodes.some(n => typeof n === 'string' && (n as string).startsWith('.'))).toBe(true)
  })

  it('never renders non-http(s) schemes as anchors (XSS guard)', () => {
    const nodes = parseInlineMarkdown('click [here](javascript:alert(1)) or javascript:alert(2)')
    expect(elements(nodes).filter(n => n.type === 'a')).toHaveLength(0)
  })

  it('http URLs also link (not just https)', () => {
    const nodes = parseInlineMarkdown('legacy http://old.example.com works')
    const [a] = elements(nodes).filter(n => n.type === 'a')
    expect(a.props.href).toBe('http://old.example.com')
  })
})

describe('parseInlineMarkdown — pre-existing syntax still renders (group-shift guard)', () => {
  it('bold, italic, and tool references keep working alongside links', () => {
    const nodes = parseInlineMarkdown('**bold** and *ital* and [[prioritization]] and [x](https://x.com)')
    const els = elements(nodes)
    expect(els.find(n => n.type === 'strong')?.props.children).toBe('bold')
    expect(els.find(n => n.type === 'em')?.props.children).toBe('ital')
    const tool = els.find(n => n.type === 'button')
    expect(tool?.props.children).toBe('prioritization')
    expect(els.find(n => n.type === 'a')?.props.href).toBe('https://x.com')
  })

  it('plain text passes through untouched', () => {
    expect(parseInlineMarkdown('no formatting here')).toEqual(['no formatting here'])
  })
})
