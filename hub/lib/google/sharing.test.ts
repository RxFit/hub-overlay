import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  normalizeShareRole,
  shareRoleLabel,
  parseRecipientRefs,
  findShareableFiles,
  listFileAccess,
  grantFileAccess,
  grantLinkAccess,
  revokeFileAccess,
  describeAccessEntry,
} from './sharing'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

interface Call {
  url: string
  method: string
  body?: Record<string, unknown>
}

/** Stub Drive, capturing every request for assertion. */
function stubDrive(responder: (url: string, method: string) => Response) {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      calls.push({
        url: String(url),
        method,
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      })
      return responder(String(url), method)
    }),
  )
  return calls
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status })

/**
 * URLSearchParams encodes spaces as `+`, which decodeURIComponent leaves alone —
 * a naive decode makes a correct Drive query look wrong.
 */
const readable = (url: string) => decodeURIComponent(url).replace(/\+/g, ' ')

describe('normalizeShareRole', () => {
  it('maps the phrasings people actually type', () => {
    expect(normalizeShareRole('can edit')).toBe('writer')
    expect(normalizeShareRole('Editor')).toBe('writer')
    expect(normalizeShareRole('comment')).toBe('commenter')
    expect(normalizeShareRole('view only')).toBe('reader')
  })

  it('collapses internal whitespace before matching', () => {
    expect(normalizeShareRole('  can   edit ')).toBe('writer')
  })

  /**
   * The single most important property in this file: an instruction the parser
   * does not understand must never widen access. Least privilege on ambiguity.
   */
  it('falls back to reader for anything unrecognised, including empty', () => {
    expect(normalizeShareRole(undefined)).toBe('reader')
    expect(normalizeShareRole('')).toBe('reader')
    expect(normalizeShareRole('full control')).toBe('reader')
    expect(normalizeShareRole('owner')).toBe('reader')
  })
})

describe('shareRoleLabel', () => {
  it('speaks Drive UI language, not API language', () => {
    expect(shareRoleLabel('writer')).toBe('editor')
    expect(shareRoleLabel('reader')).toBe('viewer')
    expect(shareRoleLabel('commenter')).toBe('commenter')
  })
})

describe('parseRecipientRefs', () => {
  it('splits on commas, semicolons, newlines and "and"', () => {
    expect(parseRecipientRefs('a@x.com, b@x.com; c@x.com\nDanny and Sam')).toEqual([
      'a@x.com', 'b@x.com', 'c@x.com', 'Danny', 'Sam',
    ])
  })

  it('strips angle brackets around an address', () => {
    expect(parseRecipientRefs('<maria@acme.com>')).toEqual(['maria@acme.com'])
  })

  it('returns [] for empty input rather than one blank entry', () => {
    expect(parseRecipientRefs('')).toEqual([])
    expect(parseRecipientRefs('  ,  ; ')).toEqual([])
  })
})

describe('findShareableFiles', () => {
  it('looks for Hub artifacts first, scoped to the tenant', async () => {
    const calls = stubDrive(() => json({ files: [{ id: 'f1', name: 'Q3 memo' }] }))

    const result = await findShareableFiles('tok', 'Q3 memo', { tenantId: 'rxfit' })

    const q = readable(calls[0].url)
    expect(q).toContain("appProperties has { key='hubOverlay' and value='artifact' }")
    expect(q).toContain("appProperties has { key='hubTenant' and value='rxfit' }")
    expect(q).toContain("name contains 'Q3 memo'")
    expect(q).toContain('trashed = false')
    expect(result.managed.map(f => f.id)).toEqual(['f1'])
    // A managed hit short-circuits — no second, broader search.
    expect(calls).toHaveLength(1)
    expect(result.unmanaged).toEqual([])
  })

  /**
   * The scope boundary made legible. Falling back to a plain name search is
   * what lets the caller say "I found it, but it isn't a Hub file" instead of
   * "not found" (wrong) or surfacing a raw Drive 403 (opaque).
   */
  it('falls back to a plain name search when no Hub artifact matches', async () => {
    const calls = stubDrive(url =>
      readable(url).includes('hubOverlay')
        ? json({ files: [] })
        : json({ files: [{ id: 'other', name: "Maria's plan" }] }),
    )

    const result = await findShareableFiles('tok', 'plan')

    expect(calls).toHaveLength(2)
    expect(result.managed).toEqual([])
    expect(result.unmanaged.map(f => f.name)).toEqual(["Maria's plan"])
  })

  it("escapes an apostrophe so the query literal isn't terminated early", async () => {
    const calls = stubDrive(() => json({ files: [{ id: 'f1', name: 'x' }] }))
    await findShareableFiles('tok', "Danny's plan")
    expect(readable(calls[0].url)).toContain("name contains 'Danny\\'s plan'")
  })

  it('returns empty for a blank term without calling Drive', async () => {
    const calls = stubDrive(() => json({ files: [] }))
    expect(await findShareableFiles('tok', '   ')).toEqual({ managed: [], unmanaged: [] })
    expect(calls).toHaveLength(0)
  })

  it('drops files Drive returned without an id', async () => {
    stubDrive(() => json({ files: [{ name: 'no id' }, { id: 'f2', name: 'ok' }] }))
    const result = await findShareableFiles('tok', 'x')
    expect(result.managed.map(f => f.id)).toEqual(['f2'])
  })
})

describe('listFileAccess', () => {
  it('flags the owner and inherited grants', async () => {
    stubDrive(() =>
      json({
        permissions: [
          { id: 'p1', type: 'user', role: 'owner', emailAddress: 'danny@rxfitatx.com' },
          {
            id: 'p2',
            type: 'user',
            role: 'writer',
            emailAddress: 'maria@acme.com',
            permissionDetails: [{ inherited: true }],
          },
          { id: 'p3', type: 'anyone', role: 'reader' },
        ],
      }),
    )

    const access = await listFileAccess('tok', 'file-1')

    expect(access[0].isOwner).toBe(true)
    expect(access[1].isOwner).toBe(false)
    expect(access[1].inherited).toBe(true)
    expect(access[2].type).toBe('anyone')
  })

  it('returns [] when Drive omits the permissions array', async () => {
    stubDrive(() => json({}))
    expect(await listFileAccess('tok', 'file-1')).toEqual([])
  })
})

describe('grantFileAccess', () => {
  it('creates a user permission and notifies by default', async () => {
    const calls = stubDrive(() => json({ id: 'p9', role: 'writer', emailAddress: 'maria@acme.com' }))

    const result = await grantFileAccess('tok', 'file-1', {
      email: 'maria@acme.com',
      role: 'writer',
    })

    expect(calls[0].method).toBe('POST')
    expect(calls[0].body).toEqual({
      type: 'user',
      role: 'writer',
      emailAddress: 'maria@acme.com',
    })
    // The default notification is both Drive's default and what "share it with
    // Maria" means to a person — she gets the mail with the link.
    expect(calls[0].url).toContain('sendNotificationEmail=true')
    expect(result).toEqual({ permissionId: 'p9', grantee: 'maria@acme.com', role: 'writer' })
  })

  /** Drive rejects emailMessage when no notification is being sent. */
  it('omits emailMessage when notification is off', async () => {
    const calls = stubDrive(() => json({ id: 'p9' }))
    await grantFileAccess('tok', 'file-1', {
      email: 'm@x.com',
      role: 'reader',
      notify: false,
      message: 'have a look',
    })
    expect(calls[0].url).toContain('sendNotificationEmail=false')
    expect(calls[0].url).not.toContain('emailMessage')
  })

  it('passes a note through when notifying', async () => {
    const calls = stubDrive(() => json({ id: 'p9' }))
    await grantFileAccess('tok', 'file-1', {
      email: 'm@x.com',
      role: 'reader',
      message: 'have a look',
    })
    expect(readable(calls[0].url)).toContain('emailMessage=have a look')
  })
})

describe('grantLinkAccess', () => {
  it('creates an anyone permission with notification forced off', async () => {
    const calls = stubDrive(() => json({ id: 'pl', role: 'reader' }))

    const result = await grantLinkAccess('tok', 'file-1', 'reader')

    expect(calls[0].body).toEqual({ type: 'anyone', role: 'reader' })
    // Drive has nobody to notify for an `anyone` grant and errors if asked to.
    expect(calls[0].url).toContain('sendNotificationEmail=false')
    expect(result.grantee).toBe('anyone with the link')
  })
})

describe('revokeFileAccess', () => {
  it('DELETEs the permission and tolerates an empty 204 body', async () => {
    const calls = stubDrive(() => new Response(null, { status: 204 }))
    await expect(revokeFileAccess('tok', 'file-1', 'p2')).resolves.toBeUndefined()
    expect(calls[0].method).toBe('DELETE')
    expect(calls[0].url).toContain('/files/file-1/permissions/p2')
  })
})

describe('describeAccessEntry', () => {
  it('reads as a sentence for each grantee shape', () => {
    expect(
      describeAccessEntry({
        permissionId: 'p1', type: 'user', role: 'writer',
        displayName: 'Maria', emailAddress: 'maria@acme.com',
        isOwner: false, inherited: false,
      }),
    ).toBe('Maria (maria@acme.com) — editor')

    expect(
      describeAccessEntry({
        permissionId: 'p2', type: 'anyone', role: 'reader',
        isOwner: false, inherited: false,
      }),
    ).toBe('Anyone with the link — viewer')

    expect(
      describeAccessEntry({
        permissionId: 'p3', type: 'domain', role: 'reader',
        domain: 'rxfitatx.com', isOwner: false, inherited: true,
      }),
    ).toBe('Everyone at rxfitatx.com — viewer (inherited from folder)')

    expect(
      describeAccessEntry({
        permissionId: 'p4', type: 'user', role: 'owner',
        emailAddress: 'danny@rxfitatx.com', isOwner: true, inherited: false,
      }),
    ).toBe('danny@rxfitatx.com — owner')
  })
})
