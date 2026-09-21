import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * Guard: every file the CONTAINER needs must survive the `.gcloudignore` upload.
 *
 * WHY THIS EXISTS — the same bug has now shipped twice.
 * `gcloud run deploy --source ./hub` uploads a filtered copy of hub/ to Cloud
 * Build, and `.gcloudignore` decides what is in it. Nothing else in the repo
 * applies that filter: CI checks out the whole tree, so `npm run build` passes
 * locally, passes in CI, and fails ONLY inside Cloud Build — the one place that
 * produces the image. The blue-green gate in deploy.yml then holds traffic on
 * the last-good revision, so a broken deploy looks exactly like a working one
 * from outside.
 *
 *   2026-07-14  scripts/assert-dynamic-rendering.mjs was excluded → Cloud Build
 *               failure. Fixed by negating it, and a comment was added to
 *               .gcloudignore explaining the trap in detail.
 *   2026-09-02  scripts/assert-instrumentation.mjs entered `npm run build`
 *               (commit 1b1dd15) and nobody negated it. Deploy run 194 was the
 *               last success; runs 195-208 all failed with
 *               `Cannot find module '/app/scripts/assert-instrumentation.mjs'`.
 *               Production stayed pinned to the 2026-09-02 revision for 13 days
 *               across 14 merges before anyone noticed.
 *
 * The comment did not prevent the recurrence, because a comment is not a check.
 * This is the check. Add a third build gate under scripts/ without negating it
 * and this test fails in CI, where it is cheap, instead of in Cloud Build, where
 * it is invisible.
 *
 * FAILS CLOSED, deliberately. Following tests/no-200-errors.test.ts: a guard
 * that answers "I cannot tell" with "pass" is blind to exactly the case it
 * exists for. The matcher below implements the subset of gitignore semantics
 * this file actually uses; anything it cannot evaluate is reported as a failure
 * with the pattern named, not waved through.
 */

const hubRoot = dirname(dirname(fileURLToPath(import.meta.url)))

/* ── A minimal, last-match-wins .gcloudignore evaluator ─────────────────────
 * gcloud applies gitignore semantics to the --source directory. We model the
 * subset present in this file: directory rules (`orchestration/`), single-level
 * globs (`scripts/*`), basename globs (`*.md`), deep globs (`skills/**\/SKILL.md`),
 * literal paths, and `!` negations. */

interface Rule {
  raw: string
  pattern: string
  negated: boolean
  dirOnly: boolean
}

function parseRules(text: string): Rule[] {
  return text
    .split('\n')
    .map(l => l.trim())
    // `#` comments — which includes gcloud's own `#!include:.gitignore`
    // directive, inert for our purposes since .gitignore excludes build
    // OUTPUT (node_modules, .next), never build INPUT.
    .filter(l => l.length > 0 && !l.startsWith('#'))
    .map(raw => {
      const negated = raw.startsWith('!')
      let pattern = negated ? raw.slice(1) : raw
      const dirOnly = pattern.endsWith('/')
      if (dirOnly) pattern = pattern.slice(0, -1)
      return { raw, pattern, negated, dirOnly }
    })
}

/** Translate one gitignore pattern to a RegExp over a repo-relative path. */
function toRegExp(pattern: string): RegExp {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*'
        i++
        if (pattern[i + 1] === '/') i++ // `**/` also matches zero directories
        continue
      }
      re += '[^/]*' // a single `*` never crosses a path separator
      continue
    }
    if (c === '?') { re += '[^/]'; continue }
    re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  // A pattern containing `/` is anchored to the ignore file's directory;
  // one without `/` matches a basename at any depth.
  return pattern.includes('/') ? new RegExp(`^${re}$`) : new RegExp(`(^|/)${re}$`)
}

function ancestorsOf(path: string): string[] {
  const parts = path.split('/')
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'))
}

interface Verdict {
  excluded: boolean
  /** The rule that decided it, for an actionable failure message. */
  decidedBy: string | null
  /** Set when a DIRECTORY rule excluded an ancestor — negations cannot undo that. */
  unreachableVia: string | null
}

function evaluate(path: string, rules: Rule[]): Verdict {
  // gitignore: "It is not possible to re-include a file if a parent directory
  // of that file is excluded." So a directory-form exclusion over any ancestor
  // is final — a later `!path/to/file` is silently inert. This is the exact
  // trap .gcloudignore's own comment warns about, and it is why that file uses
  // `scripts/*` rather than `scripts/`.
  for (const rule of rules) {
    if (rule.negated || !rule.dirOnly) continue
    const rx = toRegExp(rule.pattern)
    if (ancestorsOf(path).some(a => rx.test(a))) {
      return { excluded: true, decidedBy: rule.raw, unreachableVia: rule.raw }
    }
  }

  let excluded = false
  let decidedBy: string | null = null
  for (const rule of rules) {
    const rx = toRegExp(rule.pattern)
    const hit = rule.dirOnly
      ? ancestorsOf(path).some(a => rx.test(a)) || rx.test(path)
      : rx.test(path)
    if (hit) {
      excluded = !rule.negated
      decidedBy = rule.raw
    }
  }
  return { excluded, decidedBy, unreachableVia: null }
}

/* ── What the container actually needs ─────────────────────────────────────── */

/** Local files a shell command invokes, e.g. `node scripts/x.mjs`. */
function localFilesIn(command: string): string[] {
  const found = new Set<string>()
  for (const m of command.matchAll(/\bnode\s+([^\s&|;<>"']+)/g)) found.add(m[1])
  // Also catch runners other than bare `node` (tsx, ts-node, …): any token that
  // looks like a relative path to a script file.
  for (const m of command.matchAll(/(?:^|\s)([\w.-]+(?:\/[\w.-]+)+\.(?:mjs|cjs|js|ts))(?=\s|$)/g)) {
    found.add(m[1])
  }
  return [...found].map(p => p.replace(/^\.\//, ''))
}

function buildInputs(): string[] {
  const pkg = JSON.parse(readFileSync(join(hubRoot, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>
  }
  return localFilesIn(pkg.scripts?.build ?? '')
}

function entrypointInputs(): string[] {
  // The image's ENTRYPOINT runs migrations before serving. A file it needs that
  // the upload drops builds a perfectly good container that dies on start —
  // same class of bug, later and louder.
  return localFilesIn(readFileSync(join(hubRoot, 'docker-entrypoint.sh'), 'utf8'))
}

describe('.gcloudignore keeps every file the container build needs', () => {
  const rules = parseRules(readFileSync(join(hubRoot, '.gcloudignore'), 'utf8'))

  it('finds the build gates in package.json (the scan itself must not silently match nothing)', () => {
    const inputs = buildInputs()
    // If this ever reads zero, the extractor has drifted from the build script's
    // shape and every assertion below would vacuously pass.
    expect(inputs.length).toBeGreaterThan(0)
    expect(inputs).toContain('scripts/assert-instrumentation.mjs')
    expect(inputs).toContain('scripts/assert-dynamic-rendering.mjs')
  })

  it('uploads every file `npm run build` invokes', () => {
    for (const path of buildInputs()) {
      const v = evaluate(path, rules)
      expect(
        v.excluded,
        v.unreachableVia
          ? `\`npm run build\` runs ${path}, but .gcloudignore excludes its parent directory via \`${v.unreachableVia}\`.\n` +
            'A directory exclusion CANNOT be undone by a later `!` negation — that is why this file uses `scripts/*`\n' +
            'rather than `scripts/`. Change the directory rule to its `/*` form, then negate the file.'
          : `\`npm run build\` runs ${path}, but .gcloudignore excludes it via \`${v.decidedBy}\`.\n` +
            `Cloud Build will fail with "Cannot find module '/app/${path}'" while CI stays green, because\n` +
            'only `gcloud run deploy --source` applies this filter. Add `!' + path + '` to hub/.gcloudignore.',
      ).toBe(false)
    }
  })

  it('uploads the vendored fonts that `next build` reads', () => {
    // A different shape of the same bug. The scans above find files the build
    // INVOKES; these are files it READS. app/fonts/*.woff2 are inputs to
    // next/font/local, and they exist precisely so the build stops depending on
    // fonts.googleapis.com (see app/fonts/README.md). Excluded from the upload,
    // `next build` fails inside Cloud Build while CI stays green — the exact
    // invisible-deploy failure this file was written for.
    const fontDir = join(hubRoot, 'app', 'fonts')
    const fonts = existsSync(fontDir) ? readdirSync(fontDir).filter(f => f.endsWith('.woff2')) : []
    expect(fonts.length, 'no vendored fonts found — has the local font setup been removed?').toBeGreaterThan(0)

    for (const font of fonts) {
      const path = `app/fonts/${font}`
      const v = evaluate(path, rules)
      expect(
        v.excluded,
        `next/font/local loads ${path}, but .gcloudignore excludes it via \`${v.decidedBy}\`.\n` +
          'Cloud Build would fail resolving the font while CI stays green. Add `!' + path + '`.',
      ).toBe(false)
    }
  })

  it('uploads every file the container ENTRYPOINT invokes', () => {
    for (const path of entrypointInputs()) {
      const v = evaluate(path, rules)
      expect(
        v.excluded,
        `docker-entrypoint.sh runs ${path}, but .gcloudignore excludes it via \`${v.decidedBy}\`.\n` +
          'The image would build and then die on start. Add `!' + path + '` to hub/.gcloudignore.',
      ).toBe(false)
    }
  })

  it('every extracted path actually exists (a typo must not read as "not excluded")', () => {
    for (const path of [...buildInputs(), ...entrypointInputs()]) {
      expect(existsSync(join(hubRoot, path)), `${path} is invoked but does not exist under hub/`).toBe(true)
    }
  })
})

/* ── The evaluator's own semantics, pinned ──────────────────────────────────
 * The guard is only as good as its matcher, and a matcher that quietly returns
 * "not excluded" for everything would pass every test above while catching
 * nothing. These lock the two behaviours the real bugs turned on. */
describe('gcloudignore evaluator semantics', () => {
  it('treats `dir/*` + negation as re-includable (the shape this repo relies on)', () => {
    const rules = parseRules('scripts/*\n!scripts/keep.mjs\n')
    expect(evaluate('scripts/keep.mjs', rules).excluded).toBe(false)
    expect(evaluate('scripts/other.mjs', rules).excluded).toBe(true)
  })

  it('treats `dir/` as final — a negation inside it is inert, as git specifies', () => {
    const rules = parseRules('scripts/\n!scripts/keep.mjs\n')
    const v = evaluate('scripts/keep.mjs', rules)
    expect(v.excluded).toBe(true)
    expect(v.unreachableVia).toBe('scripts/')
  })

  it('reproduces the 2026-09-02 outage: an un-negated build gate reads as excluded', () => {
    const rules = parseRules('scripts/*\n!scripts/assert-dynamic-rendering.mjs\n')
    expect(evaluate('scripts/assert-instrumentation.mjs', rules).excluded).toBe(true)
    // …and the one-line fix in PR #237 clears it.
    const fixed = parseRules('scripts/*\n!scripts/assert-dynamic-rendering.mjs\n!scripts/assert-instrumentation.mjs\n')
    expect(evaluate('scripts/assert-instrumentation.mjs', fixed).excluded).toBe(false)
  })

  it('keeps `*` from crossing separators and `**` from being stopped by them', () => {
    expect(evaluate('skills/a/SKILL.md', parseRules('*.md\n!skills/**/SKILL.md\n')).excluded).toBe(false)
    expect(evaluate('skills/a/README.md', parseRules('*.md\n!skills/**/SKILL.md\n')).excluded).toBe(true)
    // `scripts/*` is one level only — it must not reach into a subdirectory.
    expect(evaluate('scripts/nested/x.mjs', parseRules('scripts/*\n')).excluded).toBe(false)
  })

  it('extracts script paths from real command shapes', () => {
    expect(localFilesIn('node scripts/a.mjs && next build && node scripts/b.mjs')).toEqual([
      'scripts/a.mjs',
      'scripts/b.mjs',
    ])
    expect(localFilesIn('node drizzle/migrate.mjs')).toEqual(['drizzle/migrate.mjs'])
    expect(localFilesIn('npx tsx scripts/worker.ts')).toContain('scripts/worker.ts')
    expect(localFilesIn('next build')).toEqual([])
  })
})
