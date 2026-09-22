import { describe, it, expect, vi } from 'vitest'
import { createGitHubClient, gitBlobSha } from './github'
import { VaultUnavailableError } from './errors'

/* ════════════════════════════════════════════════════════════════════════════
   GitHub snapshot client — fully offline via an injected fetch. Locks the
   request shape (auth header, API version, paths), the failure classes, and
   the blob SHA verification that keeps a corrupted/mismatched blob out of
   the index. No real repository is ever contacted.
   ════════════════════════════════════════════════════════════════════════════ */

const TOKEN = 'github_pat_TEST_NOT_REAL_0000000000'

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>

function fakeFetch(handler: Handler) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push({ url, init: init ?? {} })
    return handler(url, init ?? {})
  })
  return { impl: impl as unknown as typeof fetch, calls }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function client(handler: Handler, extra: Partial<Parameters<typeof createGitHubClient>[0]> = {}) {
  const f = fakeFetch(handler)
  const c = createGitHubClient({ token: TOKEN, owner: 'RxFit', repo: 'antigravityhq-vault', fetchImpl: f.impl, ...extra })
  return { c, calls: f.calls }
}

describe('gitBlobSha', () => {
  it('matches git hash-object for a known input', () => {
    // `printf 'hello\n' | git hash-object --stdin` → ce013625030ba8dba906f756967f9e9ca394464a
    expect(gitBlobSha('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a')
    // Byte length, not char length: multibyte content hashes by UTF-8 bytes.
    expect(gitBlobSha('東京')).toBe(gitBlobSha(Buffer.from('東京', 'utf8')))
  })
})

describe('createGitHubClient — request shape', () => {
  it('sends the bearer token, API version and user agent, never caching', async () => {
    const { c, calls } = client(() => json({ sha: 'c'.repeat(40), commit: { tree: { sha: 't'.repeat(40) }, committer: { date: '2026-09-20T10:00:00Z' } } }))
    const head = await c.getHead('HEAD')
    expect(head).toEqual({ commitSha: 'c'.repeat(40), treeSha: 't'.repeat(40), committedAt: '2026-09-20T10:00:00Z' })
    expect(calls[0].url).toBe('https://api.github.com/repos/RxFit/antigravityhq-vault/commits/HEAD')
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28')
    expect(headers['User-Agent']).toBe('hub-vault-sync')
    expect(calls[0].init.cache).toBe('no-store')
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal)
  })

  it('requests the recursive tree and reports truncation', async () => {
    const { c, calls } = client(() => json({ tree: [{ path: 'a.md', sha: 'x', type: 'blob' }, { path: 'bad' }], truncated: true }))
    const tree = await c.getTree('abc')
    expect(calls[0].url).toContain('/git/trees/abc?recursive=1')
    expect(tree.truncated).toBe(true)
    expect(tree.entries).toEqual([{ path: 'a.md', sha: 'x', type: 'blob' }]) // malformed entry dropped
  })

  it('honors a custom api base and encodes the ref', async () => {
    const { c, calls } = client(() => json({ sha: 's', commit: { tree: { sha: 't' } } }), { apiBase: 'http://ghe.local/api/v3/' })
    await c.getHead('feature/x')
    expect(calls[0].url).toBe('http://ghe.local/api/v3/repos/RxFit/antigravityhq-vault/commits/feature%2Fx')
  })
})

describe('createGitHubClient — blobs', () => {
  it('decodes base64 (with GitHub line wrapping) and verifies the git SHA', async () => {
    const content = '# Note\n\nUnicode: 東京 🚀\n'
    const sha = gitBlobSha(content)
    const b64 = Buffer.from(content, 'utf8').toString('base64').replace(/(.{60})/g, '$1\n')
    const { c } = client(() => json({ content: b64, encoding: 'base64', size: Buffer.byteLength(content) }))
    await expect(c.getBlob(sha)).resolves.toBe(content)
  })

  it('rejects with an integrity failure when the content does not hash to the requested SHA', async () => {
    const { c } = client(() => json({ content: Buffer.from('tampered').toString('base64'), encoding: 'base64' }))
    const err = await c.getBlob(gitBlobSha('original')).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(VaultUnavailableError)
    expect((err as VaultUnavailableError).reason).toBe('integrity')
    expect((err as VaultUnavailableError).stage).toBe('github')
  })

  it('rejects an unsupported encoding or a missing content field', async () => {
    const { c } = client(() => json({ content: 'x', encoding: 'rot13' }))
    await expect(c.getBlob('abc')).rejects.toMatchObject({ reason: 'integrity' })
    const { c: c2 } = client(() => json({ encoding: 'base64' }))
    await expect(c2.getBlob('abc')).rejects.toMatchObject({ reason: 'integrity' })
  })
})

describe('createGitHubClient — failure classes (never an empty result)', () => {
  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [404, 'not_found'],
    [429, 'http'],
    [502, 'http'],
  ])('HTTP %s → reason %s, carrying the status and GitHub message but never the token', async (status, reason) => {
    const { c } = client(() => json({ message: 'Upstream says no' }, status))
    const err = await c.getHead('HEAD').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(VaultUnavailableError)
    const e = err as VaultUnavailableError
    expect(e.reason).toBe(reason)
    expect(e.status).toBe(status)
    expect(e.message).toContain('Upstream says no')
    expect(e.message).not.toContain(TOKEN)
  })

  it('a thrown fetch is a network failure; an abort is a timeout', async () => {
    const { c } = client(() => { throw new TypeError('fetch failed') })
    await expect(c.getHead('HEAD')).rejects.toMatchObject({ reason: 'network' })
    const abort = new Error('aborted')
    abort.name = 'AbortError'
    const { c: c2 } = client(() => { throw abort })
    await expect(c2.getHead('HEAD')).rejects.toMatchObject({ reason: 'timeout' })
  })

  it('an already-aborted outer signal short-circuits every request', async () => {
    const controller = new AbortController()
    controller.abort()
    const { c, calls } = client((_url, init) => {
      if (init.signal?.aborted) {
        const err = new Error('aborted')
        err.name = 'AbortError'
        throw err
      }
      return json({})
    }, { signal: controller.signal })
    await expect(c.getTree('t')).rejects.toMatchObject({ reason: 'timeout' })
    expect(calls).toHaveLength(1)
  })

  it('unparseable JSON and a commit without a tree are integrity failures', async () => {
    const { c } = client(() => new Response('<html>', { status: 200 }))
    await expect(c.getHead('HEAD')).rejects.toMatchObject({ reason: 'integrity' })
    const { c: c2 } = client(() => json({ sha: 'x', commit: {} }))
    await expect(c2.getHead('HEAD')).rejects.toMatchObject({ reason: 'integrity' })
  })
})

describe('createGitHubClient — last commit date is best-effort', () => {
  it('returns the committer date for the path, and null on any failure', async () => {
    const { c, calls } = client(() => json([{ commit: { committer: { date: '2026-09-19T08:00:00Z' } } }]))
    const d = await c.getLastCommitDate('Projects/Hub Overlay.md', 'HEAD')
    expect(d?.toISOString()).toBe('2026-09-19T08:00:00.000Z')
    expect(calls[0].url).toContain('/commits?path=Projects%2FHub%20Overlay.md&sha=HEAD&per_page=1')

    const { c: failing } = client(() => json({ message: 'nope' }, 500))
    await expect(failing.getLastCommitDate('x.md', 'HEAD')).resolves.toBeNull()
    const { c: empty } = client(() => json([]))
    await expect(empty.getLastCommitDate('x.md', 'HEAD')).resolves.toBeNull()
  })
})
