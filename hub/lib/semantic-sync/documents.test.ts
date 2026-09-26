import { describe, it, expect } from 'vitest'
import { manifestLine, renderHtml, toDocumentId, type SyncDoc } from './documents'

const doc: SyncDoc = {
  id: 'gmail-abc',
  title: 'Email: Q3 <renewal> & pricing',
  updatedAt: new Date('2026-09-25T12:00:00Z'),
  facts: [
    ['From', 'Jane <jane@example.com>'],
    ['Cc', ''],
  ],
  body: 'Hi Danny,\nline two\n\n<script>alert(1)</script>',
  structData: { source: 'gmail', labels: ['INBOX'] },
}

describe('toDocumentId', () => {
  it('keeps the Discovery Engine id alphabet and prefixes the source', () => {
    expect(toDocumentId('stripe', 'cus_ABC123')).toBe('stripe-cus_ABC123')
    expect(toDocumentId('gmail', 'a.b/c')).toBe('gmail-a_b_c')
  })

  it('hashes ids that would exceed 63 chars — stably', () => {
    const long = 'x'.repeat(80)
    const id = toDocumentId('stripe', long)
    expect(id.length).toBeLessThanOrEqual(63)
    expect(id).toMatch(/^stripe-[0-9a-f]+$/)
    expect(toDocumentId('stripe', long)).toBe(id)
  })
})

describe('renderHtml', () => {
  const html = renderHtml(doc)

  it('puts the title in <title> (the engine uses it as the result title)', () => {
    expect(html).toContain('<title>Email: Q3 &lt;renewal&gt; &amp; pricing</title>')
  })

  it('escapes all record content — no markup from a synced email survives', () => {
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('Jane &lt;jane@example.com&gt;')
  })

  it('drops empty facts and keeps line breaks inside paragraphs', () => {
    expect(html).not.toContain('<dt>Cc</dt>')
    expect(html).toContain('<p>Hi Danny,<br>line two</p>')
  })
})

describe('manifestLine', () => {
  it('is one Discovery Engine "document" line pointing at the content object', () => {
    const line = JSON.parse(manifestLine(doc, 'gs://sb-email/gmail/docs/gmail-abc.html'))
    expect(line).toEqual({
      id: 'gmail-abc',
      structData: {
        source: 'gmail',
        labels: ['INBOX'],
        title: doc.title,
        updated_at: '2026-09-25T12:00:00.000Z',
      },
      content: { mimeType: 'text/html', uri: 'gs://sb-email/gmail/docs/gmail-abc.html' },
    })
  })
})
