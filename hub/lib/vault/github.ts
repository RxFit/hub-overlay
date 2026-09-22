import { createHash } from 'crypto'
import { swallow } from '@/lib/swallow'
import { VaultUnavailableError } from './errors'

/**
 * Read-only GitHub client for the vault snapshot (Lane 1).
 *
 * The vault syncs hourly to a private repo; this client reads ONE commit's
 * recursive tree and the blobs the sync decides to (re)index. Three calls,
 * all GET, all against the REST API with a fine-grained read-only PAT:
 *
 *   GET /repos/{owner}/{repo}/commits/{ref}            → HEAD commit + tree sha
 *   GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1 → every blob's path + sha
 *   GET /repos/{owner}/{repo}/git/blobs/{sha}          → base64 content, sha-verified
 *   GET /repos/{owner}/{repo}/commits?path=…&per_page=1 → last commit date (best-effort)
 *
 * Failure contract: every failure REJECTS with VaultUnavailableError (stage
 * 'github'), classified auth / not_found / http / network / timeout /
 * integrity, so the sync ledger can say which, and nothing is ever mistaken
 * for "an empty vault". A decoded blob whose git SHA does not match the tree
 * entry is an integrity failure — the note is skipped, never indexed wrong.
 *
 * SECURITY: the token appears only in the Authorization header. It is never
 * logged, never part of an error message, never echoed. Error messages carry
 * the HTTP status and the first 200 chars of GitHub's own message.
 *
 * `fetchImpl` is injectable so tests run fully offline (see github.test.ts).
 */

export interface GitTreeEntry {
  path: string
  sha: string
  type: 'blob' | 'tree' | 'commit'
  size?: number
  mode?: string
}

export interface VaultSnapshotHead {
  commitSha: string
  treeSha: string
  /** Committer date of the HEAD commit (ISO), when GitHub reports one. */
  committedAt: string | null
}

export interface VaultGitHubClient {
  getHead(ref: string): Promise<VaultSnapshotHead>
  getTree(treeSha: string): Promise<{ entries: GitTreeEntry[]; truncated: boolean }>
  /** Decoded UTF-8 content, verified against the expected git blob SHA. */
  getBlob(sha: string): Promise<string>
  /** Last commit touching `path` on `ref`. Best-effort: null on any failure. */
  getLastCommitDate(path: string, ref: string): Promise<Date | null>
}

export interface GitHubClientOptions {
  token: string
  owner: string
  repo: string
  fetchImpl?: typeof fetch
  apiBase?: string
  /** Per-request deadline. Default 15s. */
  timeoutMs?: number
  /** Optional outer deadline shared by every request (the sync run's budget). */
  signal?: AbortSignal
}

const DEFAULT_API_BASE = 'https://api.github.com'
const DEFAULT_TIMEOUT_MS = 15_000
const USER_AGENT = 'hub-vault-sync'

/** Git's blob object id: sha1("blob <bytes>\0" + content). */
export function gitBlobSha(content: string | Buffer): string {
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex')
}

function combineSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b
  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any
  if (typeof anyFn === 'function') return anyFn([a, b])
  return a.aborted ? a : b
}

function classifyStatus(status: number): 'auth' | 'not_found' | 'http' {
  if (status === 401 || status === 403) return 'auth'
  if (status === 404) return 'not_found'
  return 'http'
}

export function createGitHubClient(options: GitHubClientOptions): VaultGitHubClient {
  const fetchImpl = options.fetchImpl ?? fetch
  const apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/$/, '')
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const repoPath = `/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}`

  async function request<T>(path: string, what: string): Promise<T> {
    const url = `${apiBase}${repoPath}${path}`
    const signal = combineSignals(options.signal, AbortSignal.timeout(timeoutMs))
    let res: Response
    try {
      res = await fetchImpl(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${options.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': USER_AGENT,
        },
        signal,
        cache: 'no-store',
      })
    } catch (err) {
      const aborted = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
      throw new VaultUnavailableError(
        'github',
        aborted ? 'timeout' : 'network',
        aborted
          ? `GitHub ${what} aborted after ${timeoutMs}ms or by the caller's deadline`
          : `GitHub ${what} failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    if (!res.ok) {
      const body = await res.text().catch((err: unknown) => {
        swallow(err, { module: 'vault-github', op: 'readErrorBody' })
        return ''
      })
      let upstreamMessage = ''
      try {
        upstreamMessage = (JSON.parse(body) as { message?: string }).message ?? ''
      } catch {
        upstreamMessage = body
      }
      throw new VaultUnavailableError(
        'github',
        classifyStatus(res.status),
        `GitHub ${what} failed with HTTP ${res.status}${upstreamMessage ? `: ${upstreamMessage.slice(0, 200)}` : ''}`,
        res.status,
      )
    }

    try {
      return (await res.json()) as T
    } catch (err) {
      throw new VaultUnavailableError('github', 'integrity', `GitHub ${what} returned unparseable JSON: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return {
    async getHead(ref: string): Promise<VaultSnapshotHead> {
      const data = await request<{ sha?: string; commit?: { tree?: { sha?: string }; committer?: { date?: string } } }>(
        `/commits/${encodeURIComponent(ref)}`,
        `commit ${ref}`,
      )
      if (!data.sha || !data.commit?.tree?.sha) {
        throw new VaultUnavailableError('github', 'integrity', `GitHub commit ${ref} response is missing sha/tree`)
      }
      return { commitSha: data.sha, treeSha: data.commit.tree.sha, committedAt: data.commit.committer?.date ?? null }
    },

    async getTree(treeSha: string) {
      const data = await request<{ tree?: GitTreeEntry[]; truncated?: boolean }>(
        `/git/trees/${encodeURIComponent(treeSha)}?recursive=1`,
        `tree ${treeSha.slice(0, 12)}`,
      )
      if (!Array.isArray(data.tree)) {
        throw new VaultUnavailableError('github', 'integrity', 'GitHub tree response has no entries array')
      }
      const entries = data.tree.filter((e) => e && typeof e.path === 'string' && typeof e.sha === 'string')
      return { entries, truncated: Boolean(data.truncated) }
    },

    async getBlob(sha: string): Promise<string> {
      const data = await request<{ content?: string; encoding?: string }>(
        `/git/blobs/${encodeURIComponent(sha)}`,
        `blob ${sha.slice(0, 12)}`,
      )
      if (typeof data.content !== 'string') {
        throw new VaultUnavailableError('github', 'integrity', `GitHub blob ${sha.slice(0, 12)} has no content`)
      }
      let bytes: Buffer
      if (data.encoding === 'base64') bytes = Buffer.from(data.content.replace(/\s+/g, ''), 'base64')
      else if (data.encoding === 'utf-8' || data.encoding === 'utf8') bytes = Buffer.from(data.content, 'utf8')
      else throw new VaultUnavailableError('github', 'integrity', `GitHub blob ${sha.slice(0, 12)} uses unsupported encoding ${String(data.encoding)}`)
      const actual = gitBlobSha(bytes)
      if (actual !== sha) {
        throw new VaultUnavailableError('github', 'integrity', `GitHub blob ${sha.slice(0, 12)} content did not verify (got ${actual.slice(0, 12)})`)
      }
      return bytes.toString('utf8')
    },

    async getLastCommitDate(path: string, ref: string): Promise<Date | null> {
      try {
        const data = await request<Array<{ commit?: { committer?: { date?: string }; author?: { date?: string } } }>>(
          `/commits?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(ref)}&per_page=1`,
          `last commit for path`,
        )
        const iso = data?.[0]?.commit?.committer?.date ?? data?.[0]?.commit?.author?.date
        if (!iso) return null
        const d = new Date(iso)
        return Number.isNaN(d.getTime()) ? null : d
      } catch (err) {
        // Provenance nicety, not a correctness input: a failure here must not
        // fail the note. Counted, not thrown.
        swallow(err, { module: 'vault-github', op: 'getLastCommitDate' })
        return null
      }
    },
  }
}
