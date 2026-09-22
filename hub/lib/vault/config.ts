/**
 * Runtime configuration for the AntigravityHQ vault corpus — DENY BY DEFAULT.
 *
 * Everything ships dark. The feature is `ready` only when BOTH:
 *   1. VAULT_GITHUB_TOKEN is set (a read-only fine-grained PAT scoped to the
 *      vault repo, bound from Secret Manager — never created by code), and
 *   2. VAULT_INCLUDE_GLOBS names at least one folder to index.
 * Until then every route answers 503 with `disabled` / `awaiting_scope_config`
 * and nothing is ever fetched or indexed.
 *
 * Scope: comma-separated globs. Include default is EMPTY (= index nothing);
 * excludes ALWAYS win over includes; only `.md` blobs are ever candidates;
 * `.git/` and `.obsidian/` are ignored unconditionally (they never hold notes).
 * Globs match the whole vault-relative path (`Projects/**`, `Daily/2026-*.md`,
 * or a double-star followed by `/*.md` for every note at any depth); a bare
 * folder name (`Projects`, `Projects/`) means everything under it. Matching
 * is case-sensitive, like git.
 *
 * No value read here is ever logged: only booleans and counts.
 */

export const VAULT_CORPUS = 'antigravityhq'
export const DEFAULT_VAULT_REPO = 'RxFit/antigravityhq-vault'
export const DEFAULT_VAULT_REF = 'HEAD'

export type VaultReadiness = 'ready' | 'disabled' | 'awaiting_scope_config'

export interface VaultScope {
  include: string[]
  exclude: string[]
}

export interface VaultRepo {
  owner: string
  repo: string
  slug: string
  ref: string
}

type Env = Record<string, string | undefined>

/** Comma- or newline-separated list → trimmed, de-duplicated, empties dropped. */
export function parseList(raw: string | undefined): string[] {
  if (!raw) return []
  const out: string[] = []
  for (const piece of raw.split(/[,\n]/)) {
    const v = piece.trim()
    if (v && !out.includes(v)) out.push(v)
  }
  return out
}

export function isVaultTokenConfigured(env: Env = process.env): boolean {
  return Boolean(env.VAULT_GITHUB_TOKEN && env.VAULT_GITHUB_TOKEN.trim())
}

export function readVaultScope(env: Env = process.env): VaultScope {
  return {
    include: parseList(env.VAULT_INCLUDE_GLOBS),
    exclude: parseList(env.VAULT_EXCLUDE_GLOBS),
  }
}

export function isScopeConfigured(scope: VaultScope): boolean {
  return scope.include.length > 0
}

/**
 * The gate every route consults first. Order matters: a missing token is
 * reported before a missing scope, so the owner sees the steps in the order
 * the runbook lists them.
 */
export function getVaultReadiness(env: Env = process.env): VaultReadiness {
  if (!isVaultTokenConfigured(env)) return 'disabled'
  if (!isScopeConfigured(readVaultScope(env))) return 'awaiting_scope_config'
  return 'ready'
}

const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/**
 * `VAULT_REPO` as owner/repo (default RxFit/antigravityhq-vault). An invalid
 * slug falls back to the default rather than letting a typo point the sync at
 * some other repository. `VAULT_REPO_REF` pins a branch/tag (default HEAD).
 */
export function getVaultRepo(env: Env = process.env): VaultRepo {
  const raw = (env.VAULT_REPO ?? '').trim()
  const slug = SLUG.test(raw) ? raw : DEFAULT_VAULT_REPO
  const [owner, repo] = slug.split('/')
  const ref = (env.VAULT_REPO_REF ?? '').trim() || DEFAULT_VAULT_REF
  return { owner, repo, slug, ref }
}

/* ── Glob matching ───────────────────────────────────────────────────────── */

const GLOB_SPECIALS = /[*?[{]/

function escapeRegex(s: string): string {
  return s.replace(/[.+^$()|\\]/g, '\\$&')
}

/**
 * Compile one glob to a full-path RegExp. Supports `**` (any depth, including
 * none), `*` (within a segment), `?`, `{a,b}` and `[...]` classes. A glob with
 * no wildcard names an exact path OR a directory prefix.
 */
export function compileGlob(glob: string): RegExp {
  let g = glob.trim().replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '')
  if (!g) return /^$/
  if (!GLOB_SPECIALS.test(g)) {
    const exact = escapeRegex(g)
    return new RegExp(`^${exact}(?:/.*)?$`)
  }
  let out = ''
  let i = 0
  while (i < g.length) {
    const c = g[i]
    if (c === '*') {
      if (g[i + 1] === '*') {
        // `**/` → any number of directories; trailing `**` → anything.
        if (g[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 3
        } else {
          out += '.*'
          i += 2
        }
      } else {
        out += '[^/]*'
        i++
      }
      continue
    }
    if (c === '?') {
      out += '[^/]'
      i++
      continue
    }
    if (c === '{') {
      const close = g.indexOf('}', i)
      if (close > i) {
        const alts = g.slice(i + 1, close).split(',').map((a) => escapeRegex(a.trim()).replace(/\*/g, '[^/]*'))
        out += `(?:${alts.join('|')})`
        i = close + 1
        continue
      }
    }
    if (c === '[') {
      const close = g.indexOf(']', i)
      if (close > i) {
        out += g.slice(i, close + 1)
        i = close + 1
        continue
      }
    }
    out += escapeRegex(c)
    i++
  }
  g = out
  return new RegExp(`^${g}$`)
}

const ALWAYS_IGNORED = [/^\.git(?:\/|$)/, /^\.obsidian(?:\/|$)/, /(?:^|\/)\.git(?:\/|$)/, /(?:^|\/)\.obsidian(?:\/|$)/]

export interface ScopeMatcher {
  /** True when the path is a markdown note inside the include set and outside every exclude. */
  matches(path: string): boolean
  readonly includeCount: number
  readonly excludeCount: number
}

/**
 * Deny by default: with no include globs NOTHING matches. Excludes always win.
 * Only `.md` files are ever candidates (the corpus is markdown notes).
 */
export function createScopeMatcher(scope: VaultScope): ScopeMatcher {
  const include = scope.include.map(compileGlob)
  const exclude = scope.exclude.map(compileGlob)
  return {
    includeCount: include.length,
    excludeCount: exclude.length,
    matches(path: string): boolean {
      if (include.length === 0) return false
      const p = path.replace(/^\.\//, '').replace(/^\/+/, '')
      if (!/\.md$/i.test(p)) return false
      if (ALWAYS_IGNORED.some((re) => re.test(p))) return false
      if (exclude.some((re) => re.test(p))) return false
      return include.some((re) => re.test(p))
    },
  }
}

/** Convenience: the in-scope subset of a list of vault paths, order preserved. */
export function filterVaultPaths(paths: string[], scope: VaultScope): string[] {
  const matcher = createScopeMatcher(scope)
  return paths.filter((p) => matcher.matches(p))
}
