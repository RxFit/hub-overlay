import { describe, it, expect } from 'vitest'
import { RecursiveCharacterTextSplitter, semanticChunk } from './chunker'

describe('RecursiveCharacterTextSplitter', () => {
  it('returns the whole text as one chunk when it fits within chunkSize', () => {
    const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 100, chunkOverlap: 10 })
    expect(splitter.splitText('short document')).toEqual(['short document'])
  })

  it('splits on paragraph boundaries first and keeps every chunk within chunkSize', () => {
    const paras = Array.from({ length: 6 }, (_, i) => `Paragraph ${i} ${'x'.repeat(40)}`)
    const text = paras.join('\n\n')
    const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 120, chunkOverlap: 0 })
    const chunks = splitter.splitText(text)

    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(120)
    }
    // No paragraph is torn apart when it fits — each appears intact in some chunk.
    for (const p of paras) {
      expect(chunks.some((c) => c.includes(p))).toBe(true)
    }
  })

  it('preserves all content — nothing is dropped between chunks (zero overlap)', () => {
    const words = Array.from({ length: 50 }, (_, i) => `word${i}`)
    const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 60, chunkOverlap: 0 })
    const chunks = splitter.splitText(words.join(' '))
    const rejoined = chunks.join(' ')
    for (const w of words) {
      expect(rejoined).toContain(w)
    }
  })

  it('carries overlap from the tail of the previous chunk into the next', () => {
    const words = Array.from({ length: 30 }, (_, i) => `w${String(i).padStart(2, '0')}`)
    const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 40, chunkOverlap: 15 })
    const chunks = splitter.splitText(words.join(' '))

    expect(chunks.length).toBeGreaterThan(1)
    // The first word of chunk N (an overlap word) must already appear in chunk N-1.
    for (let i = 1; i < chunks.length; i++) {
      const firstWord = chunks[i].split(' ')[0]
      expect(chunks[i - 1]).toContain(firstWord)
    }
  })

  it('recursively falls back to finer separators for an unbroken oversized run', () => {
    // No \n\n, \n, or spaces — must fall back to character-level splitting.
    const text = 'a'.repeat(250)
    const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 100, chunkOverlap: 0 })
    const chunks = splitter.splitText(text)

    expect(chunks.length).toBeGreaterThanOrEqual(3)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100)
    }
    expect(chunks.join('')).toBe(text)
  })

  it('flushes accumulated small splits before recursing into an oversized one', () => {
    const big = 'B'.repeat(150)
    const text = `intro paragraph\n\n${big}\n\noutro paragraph`
    const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 100, chunkOverlap: 0 })
    const chunks = splitter.splitText(text)

    expect(chunks[0]).toBe('intro paragraph')
    expect(chunks.join('')).toContain(big)
    expect(chunks[chunks.length - 1]).toBe('outro paragraph')
  })
})

describe('semanticChunk', () => {
  it('applies the given chunkSize/chunkOverlap', () => {
    const text = Array.from({ length: 20 }, (_, i) => `sentence ${i}`).join(' ')
    const chunks = semanticChunk(text, 50, 0)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(50)
    }
  })

  it('defaults to a single chunk for typical short documents', () => {
    expect(semanticChunk('hello world')).toEqual(['hello world'])
  })
})
