import { describe, it, expect, vi, beforeEach } from 'vitest'
import { extractDriveLinks, resolveDriveLinkContext } from './drive-links'

const { readDriveFileTextMock } = vi.hoisted(() => ({ readDriveFileTextMock: vi.fn() }))
vi.mock('@/lib/google', () => ({ readDriveFileText: readDriveFileTextMock }))

/* A pasted Drive link used to be invisible to the model — nothing extracted
   the file id, and generic URL fetches run WITHOUT the user's OAuth token, so
   private files came back as sign-in pages. Users experienced that as "the AI
   can't see my file even when I send it the link". */
describe('extractDriveLinks', () => {
  it('extracts a Google Docs link', () => {
    const links = extractDriveLinks(
      'summarize https://docs.google.com/document/d/1AbC_dEf-234567890/edit#heading=h.1 please',
    )
    expect(links).toEqual([
      { fileId: '1AbC_dEf-234567890', url: expect.stringContaining('docs.google.com/document/d/1AbC_dEf-234567890'), isFolder: false },
    ])
  })

  it('extracts Sheets, Slides and drive.google.com/file links', () => {
    const text = [
      'https://docs.google.com/spreadsheets/d/sheetIDsheetID123/edit',
      'https://docs.google.com/presentation/d/slideIDslideID123/present',
      'https://drive.google.com/file/d/fileIDfileID12345/view?usp=sharing',
    ].join('\n')
    expect(extractDriveLinks(text).map(l => l.fileId)).toEqual([
      'sheetIDsheetID123',
      'slideIDslideID123',
      'fileIDfileID12345',
    ])
  })

  it('extracts open?id= links and multi-account /u/1/ paths', () => {
    const text =
      'https://drive.google.com/open?id=openIDopenID1234 and https://docs.google.com/document/u/1/d/multiAcctID12345/edit'
    // Extraction groups by URL pattern, not text position — assert the set.
    expect(extractDriveLinks(text).map(l => l.fileId).sort()).toEqual([
      'multiAcctID12345',
      'openIDopenID1234',
    ])
  })

  it('flags folder links as folders', () => {
    const links = extractDriveLinks('see https://drive.google.com/drive/folders/folderIDfolder123')
    expect(links).toEqual([
      { fileId: 'folderIDfolder123', url: expect.stringContaining('folders/folderIDfolder123'), isFolder: true },
    ])
  })

  it('dedupes repeated links to the same file', () => {
    const url = 'https://docs.google.com/document/d/sameIDsameID1234/edit'
    expect(extractDriveLinks(`${url} and again ${url}`)).toHaveLength(1)
  })

  it('returns [] for text without Drive links', () => {
    expect(extractDriveLinks('no links here, just https://example.com/doc')).toEqual([])
  })
})

describe('resolveDriveLinkContext', () => {
  beforeEach(() => readDriveFileTextMock.mockReset())

  it('returns empty parts for a message without links (no Drive call)', async () => {
    expect(await resolveDriveLinkContext('just a question', 'tok')).toEqual({ content: '', advisory: '' })
    expect(readDriveFileTextMock).not.toHaveBeenCalled()
  })

  it('reads a linked file with the user token; content carries the text, no advisory needed', async () => {
    readDriveFileTextMock.mockResolvedValueOnce({
      id: 'docIDdocID123456',
      name: 'Q3 Plan',
      mimeType: 'application/vnd.google-apps.document',
      text: 'Revenue targets…',
      truncated: false,
    })
    const ctx = await resolveDriveLinkContext(
      'what does https://docs.google.com/document/d/docIDdocID123456/edit say?',
      'tok',
    )
    expect(readDriveFileTextMock).toHaveBeenCalledWith('tok', 'docIDdocID123456', { maxChars: 12_000 })
    expect(ctx.content).toContain('"Q3 Plan"')
    expect(ctx.content).toContain('Revenue targets…')
    expect(ctx.advisory).toBe('')
  })

  it('explains a missing token in the ADVISORY (outside-fence guidance), reauth wording by default', async () => {
    const ctx = await resolveDriveLinkContext(
      'https://docs.google.com/document/d/docIDdocID123456/edit',
      undefined,
    )
    expect(ctx.advisory).toContain('no valid access token')
    expect(ctx.advisory).toContain('sign out')
    expect(ctx.advisory).toContain("don't exist")
    expect(readDriveFileTextMock).not.toHaveBeenCalled()
  })

  it('uses retry wording — never sign-out advice — for a transient/expired token, matching googleAuthNotice', async () => {
    const ctx = await resolveDriveLinkContext(
      'https://docs.google.com/document/d/docIDdocID123456/edit',
      undefined,
      { unavailableReason: 'transient' },
    )
    expect(ctx.advisory).toContain('retry in a moment')
    expect(ctx.advisory).not.toContain('sign out')
  })

  it('degrades an unreadable link to a status note plus a sharing-hint advisory on 404', async () => {
    readDriveFileTextMock.mockRejectedValueOnce(new Error('Google API error 404: File not found'))
    const ctx = await resolveDriveLinkContext(
      'https://drive.google.com/file/d/goneIDgoneID1234/view',
      'tok',
    )
    expect(ctx.content).toContain('read failed')
    expect(ctx.advisory).toContain('may not be shared with the signed-in Google account')
    expect(ctx.advisory).toContain("do NOT claim the document doesn't exist")
  })

  it('routes the folder explanation through the advisory', async () => {
    const ctx = await resolveDriveLinkContext(
      'https://drive.google.com/drive/folders/folderIDfolder123',
      'tok',
    )
    expect(ctx.advisory).toContain('Drive FOLDER')
    expect(readDriveFileTextMock).not.toHaveBeenCalled()
  })

  it('caps resolution at 3 links per message', async () => {
    readDriveFileTextMock.mockResolvedValue({
      id: 'x', name: 'Doc', mimeType: 'application/vnd.google-apps.document', text: 't', truncated: false,
    })
    const text = [1, 2, 3, 4, 5]
      .map(n => `https://docs.google.com/document/d/uniqueDocID000${n}0/edit`)
      .join(' ')
    await resolveDriveLinkContext(text, 'tok')
    expect(readDriveFileTextMock).toHaveBeenCalledTimes(3)
  })
})
