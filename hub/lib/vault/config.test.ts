import { describe, it, expect } from 'vitest'
import {
  compileGlob,
  createScopeMatcher,
  filterVaultPaths,
  getVaultReadiness,
  getVaultRepo,
  parseList,
  readVaultScope,
  DEFAULT_VAULT_REPO,
} from './config'

/* ════════════════════════════════════════════════════════════════════════════
   Deny-by-default scope + readiness. The posture the whole feature ships
   under: no token → disabled; no include globs → awaiting_scope_config; an
   empty include set matches NOTHING; excludes always win.
   ════════════════════════════════════════════════════════════════════════════ */

describe('getVaultReadiness', () => {
  it('is disabled without VAULT_GITHUB_TOKEN, even when scope is set', () => {
    expect(getVaultReadiness({})).toBe('disabled')
    expect(getVaultReadiness({ VAULT_GITHUB_TOKEN: '   ', VAULT_INCLUDE_GLOBS: 'Projects/**' })).toBe('disabled')
  })

  it('awaits scope config with a token but no include globs (exclude alone is not scope)', () => {
    expect(getVaultReadiness({ VAULT_GITHUB_TOKEN: 'x' })).toBe('awaiting_scope_config')
    expect(getVaultReadiness({ VAULT_GITHUB_TOKEN: 'x', VAULT_INCLUDE_GLOBS: '', VAULT_EXCLUDE_GLOBS: 'Private/**' })).toBe('awaiting_scope_config')
  })

  it('is ready only with both', () => {
    expect(getVaultReadiness({ VAULT_GITHUB_TOKEN: 'x', VAULT_INCLUDE_GLOBS: 'Projects/**' })).toBe('ready')
  })
})

describe('parseList / readVaultScope', () => {
  it('splits on commas and newlines, trims, drops empties and duplicates', () => {
    expect(parseList(' a, b ,,\n c,a ')).toEqual(['a', 'b', 'c'])
    expect(parseList(undefined)).toEqual([])
    expect(readVaultScope({ VAULT_INCLUDE_GLOBS: 'Projects/**, Daily/**', VAULT_EXCLUDE_GLOBS: 'Private/**' })).toEqual({
      include: ['Projects/**', 'Daily/**'],
      exclude: ['Private/**'],
    })
  })
})

describe('getVaultRepo', () => {
  it('defaults to the vault repo and HEAD; a malformed slug falls back rather than pointing elsewhere', () => {
    expect(getVaultRepo({})).toEqual({ owner: 'RxFit', repo: 'antigravityhq-vault', slug: DEFAULT_VAULT_REPO, ref: 'HEAD' })
    expect(getVaultRepo({ VAULT_REPO: 'not a slug' }).slug).toBe(DEFAULT_VAULT_REPO)
    expect(getVaultRepo({ VAULT_REPO: 'Org/other-vault', VAULT_REPO_REF: 'main' })).toEqual({ owner: 'Org', repo: 'other-vault', slug: 'Org/other-vault', ref: 'main' })
  })
})

describe('compileGlob', () => {
  const m = (glob: string, path: string) => compileGlob(glob).test(path)

  it('matches `**` at any depth including none, `*` within a segment, `?`, `{a,b}` and classes', () => {
    expect(m('Projects/**', 'Projects/a.md')).toBe(true)
    expect(m('Projects/**', 'Projects/deep/er/a.md')).toBe(true)
    expect(m('Projects/**', 'Other/a.md')).toBe(false)
    expect(m('**/*.md', 'a.md')).toBe(true)
    expect(m('**/*.md', 'x/y/a.md')).toBe(true)
    expect(m('*.md', 'a.md')).toBe(true)
    expect(m('*.md', 'x/a.md')).toBe(false)
    expect(m('Daily/2026-0?-*.md', 'Daily/2026-09-20.md')).toBe(true)
    expect(m('Daily/2026-0?-*.md', 'Daily/2026-10-20.md')).toBe(false)
    expect(m('{Projects,Daily}/**', 'Daily/x.md')).toBe(true)
    expect(m('{Projects,Daily}/**', 'Private/x.md')).toBe(false)
    expect(m('Daily/202[56]-*.md', 'Daily/2025-01-01.md')).toBe(true)
  })

  it('treats a bare folder (with or without trailing slash) as everything under it', () => {
    expect(m('Projects', 'Projects/a.md')).toBe(true)
    expect(m('Projects/', 'Projects/a/b.md')).toBe(true)
    expect(m('Projects', 'Projects.md')).toBe(false)
    expect(m('Projects', 'ProjectsX/a.md')).toBe(false)
  })

  it('escapes regex metacharacters in literal parts', () => {
    expect(m('Notes (2026)/**', 'Notes (2026)/a.md')).toBe(true)
    expect(m('a.b/**', 'aXb/c.md')).toBe(false)
  })
})

describe('createScopeMatcher — deny by default, excludes win, markdown only', () => {
  const paths = [
    'Projects/Hub Overlay.md',
    'Projects/Roadmap.md',
    'Daily/2026-09-20.md',
    'Private/Secrets.md',
    'Templates/Note Template.md',
    'attachments/diagram.png',
    'README.md',
    '.obsidian/workspace.md',
    'Projects/.git/HEAD.md',
  ]

  it('matches nothing when no include globs are configured', () => {
    expect(filterVaultPaths(paths, { include: [], exclude: [] })).toEqual([])
    expect(filterVaultPaths(paths, { include: [], exclude: ['nothing'] })).toEqual([])
  })

  it('includes only the named folders and never a non-markdown blob', () => {
    expect(filterVaultPaths(paths, { include: ['Projects/**', 'Daily/**'], exclude: [] })).toEqual([
      'Projects/Hub Overlay.md',
      'Projects/Roadmap.md',
      'Daily/2026-09-20.md',
    ])
    expect(filterVaultPaths(paths, { include: ['attachments/**'], exclude: [] })).toEqual([])
  })

  it('lets an exclude override an include that also matches', () => {
    expect(filterVaultPaths(paths, { include: ['**/*.md'], exclude: ['Private/**', 'Templates/**'] })).toEqual([
      'Projects/Hub Overlay.md',
      'Projects/Roadmap.md',
      'Daily/2026-09-20.md',
      'README.md',
    ])
    expect(filterVaultPaths(paths, { include: ['Projects/**'], exclude: ['Projects/Roadmap.md'] })).toEqual(['Projects/Hub Overlay.md'])
  })

  it('always ignores .git and .obsidian, whatever the includes say', () => {
    const out = filterVaultPaths(paths, { include: ['**'], exclude: [] })
    expect(out).not.toContain('.obsidian/workspace.md')
    expect(out).not.toContain('Projects/.git/HEAD.md')
  })

  it('reports include/exclude counts for the health route', () => {
    const matcher = createScopeMatcher({ include: ['a/**', 'b/**'], exclude: ['c/**'] })
    expect(matcher.includeCount).toBe(2)
    expect(matcher.excludeCount).toBe(1)
    expect(matcher.matches('./a/x.MD')).toBe(true)
  })
})
