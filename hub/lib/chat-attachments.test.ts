import { describe, it, expect } from 'vitest'
import { renderableAttachments } from './chat-attachments'

/* ════════════════════════════════════════════════════════════════════════════
   lib/chat-attachments — reducing the Chat API's two attachment sources to a
   safe renderable chip. The href rules are the point: Drive refs become Drive
   viewer links, uploaded content uses its https downloadUri, and anything
   outside those shapes degrades to an UNLINKED chip rather than a bad href.
   ════════════════════════════════════════════════════════════════════════════ */

describe('renderableAttachments', () => {
  it('links a Drive attachment to the Drive viewer, preferring it over downloadUri', () => {
    const [a] = renderableAttachments([{
      name: 'spaces/S/messages/M/attachments/1',
      contentName: 'Q3 plan.pdf',
      contentType: 'application/pdf',
      source: 'DRIVE_FILE',
      driveDataRef: { driveFileId: 'abc_DEF-123' },
      downloadUri: 'https://chat.googleusercontent.com/dl/xyz',
    }])
    expect(a).toEqual({
      key: 'spaces/S/messages/M/attachments/1',
      label: 'Q3 plan.pdf',
      kind: 'pdf',
      href: 'https://drive.google.com/file/d/abc_DEF-123/view',
    })
  })

  it('links uploaded content via its https downloadUri and classifies by MIME prefix', () => {
    const out = renderableAttachments([
      { contentName: 'photo.png', contentType: 'image/png', downloadUri: 'https://x.googleusercontent.com/a' },
      { contentName: 'clip.mp4', contentType: 'video/mp4', downloadUri: 'https://x.googleusercontent.com/b' },
      { contentName: 'note.m4a', contentType: 'audio/mp4', downloadUri: 'https://x.googleusercontent.com/c' },
      { contentName: 'data.csv', contentType: 'text/csv', downloadUri: 'https://x.googleusercontent.com/d' },
    ])
    expect(out.map(a => a.kind)).toEqual(['image', 'video', 'audio', 'file'])
    expect(out.every(a => a.href?.startsWith('https://'))).toBe(true)
  })

  it('refuses non-https and malformed link material — chip renders unlinked', () => {
    const out = renderableAttachments([
      // eslint-disable-next-line no-script-url
      { contentName: 'evil', downloadUri: 'javascript:alert(1)' },
      { contentName: 'weird drive id', driveDataRef: { driveFileId: '../../etc' } },
      { contentName: 'no link at all' },
    ])
    expect(out.map(a => a.href)).toEqual([null, null, null])
  })

  it('never renders an empty label and keys positionally when unnamed', () => {
    const out = renderableAttachments([{ contentName: '   ' }, {}])
    expect(out.map(a => a.label)).toEqual(['Attachment', 'Attachment'])
    expect(out.map(a => a.key)).toEqual(['attachment-0', 'attachment-1'])
  })

  it('returns [] for a message with no attachments', () => {
    expect(renderableAttachments(undefined)).toEqual([])
  })
})
