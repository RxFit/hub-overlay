import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { gitBlobSha, type GitTreeEntry, type VaultGitHubClient, type VaultSnapshotHead } from '@/lib/vault/github'
import { VaultUnavailableError } from '@/lib/vault/errors'

/**
 * An in-memory stand-in for the vault repository, built from the fixture
 * mini-vault (test/fixtures/vault). Implements VaultGitHubClient exactly, with
 * real git blob SHAs, so the sync engine runs its true diff logic — and with
 * mutation helpers (write / delete / rename) so tests can advance "commits".
 * No network, no real repository, ever.
 */

export const FIXTURE_VAULT_DIR = join(__dirname, 'fixtures', 'vault')

export interface FakeVault extends VaultGitHubClient {
  files: Map<string, Buffer>
  /** Per-path last-commit dates returned by getLastCommitDate (null when unset). */
  commitDates: Map<string, Date>
  /** sha → replacement content, to simulate a blob that does not verify. */
  tamper: Map<string, Buffer>
  /** When set, every request rejects with this error (simulated outage). */
  outage: VaultUnavailableError | null
  /** Force the tree response to report truncation. */
  truncated: boolean
  calls: { head: number; tree: number; blob: number; lastCommit: number }
  head(): string
  shaOf(path: string): string
  write(path: string, content: string): void
  delete(path: string): void
  rename(from: string, to: string): void
}

function walk(dir: string, base: string, out: Map<string, Buffer>) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, base, out)
    else out.set(relative(base, p).split('\\').join('/'), readFileSync(p))
  }
}

export function loadFixtureVault(): Map<string, Buffer> {
  const files = new Map<string, Buffer>()
  walk(FIXTURE_VAULT_DIR, FIXTURE_VAULT_DIR, files)
  return files
}

export function createFakeVault(files: Map<string, Buffer> = loadFixtureVault()): FakeVault {
  const state: FakeVault = {
    files,
    commitDates: new Map(),
    tamper: new Map(),
    outage: null,
    truncated: false,
    calls: { head: 0, tree: 0, blob: 0, lastCommit: 0 },

    head() {
      const h = createHash('sha1')
      for (const [path, buf] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        h.update(`${path}\0${gitBlobSha(buf)}\n`)
      }
      return h.digest('hex')
    },
    shaOf(path) {
      const buf = files.get(path)
      if (!buf) throw new Error(`fixture has no ${path}`)
      return gitBlobSha(buf)
    },
    write(path, content) {
      files.set(path, Buffer.from(content, 'utf8'))
    },
    delete(path) {
      files.delete(path)
    },
    rename(from, to) {
      const buf = files.get(from)
      if (!buf) throw new Error(`fixture has no ${from}`)
      files.delete(from)
      files.set(to, buf)
    },

    async getHead(): Promise<VaultSnapshotHead> {
      state.calls.head++
      if (state.outage) throw state.outage
      const commitSha = state.head()
      return { commitSha, treeSha: `tree-${commitSha}`, committedAt: '2026-09-20T15:00:00Z' }
    },
    async getTree(): Promise<{ entries: GitTreeEntry[]; truncated: boolean }> {
      state.calls.tree++
      if (state.outage) throw state.outage
      const entries: GitTreeEntry[] = [...files.entries()].map(([path, buf]) => ({ path, sha: gitBlobSha(buf), type: 'blob', size: buf.length }))
      entries.push({ path: 'Projects', sha: 'dir-projects', type: 'tree' })
      return { entries, truncated: state.truncated }
    },
    async getBlob(sha: string): Promise<string> {
      state.calls.blob++
      if (state.outage) throw state.outage
      const tampered = state.tamper.get(sha)
      if (tampered) {
        // Mirror the real client: content that does not hash to `sha` is an integrity failure.
        throw new VaultUnavailableError('github', 'integrity', `blob ${sha.slice(0, 12)} content did not verify`)
      }
      for (const buf of files.values()) {
        if (gitBlobSha(buf) === sha) return buf.toString('utf8')
      }
      throw new VaultUnavailableError('github', 'not_found', `blob ${sha.slice(0, 12)} not found`, 404)
    },
    async getLastCommitDate(path: string): Promise<Date | null> {
      state.calls.lastCommit++
      if (state.outage) return null
      return state.commitDates.get(path) ?? null
    },
  }
  return state
}
