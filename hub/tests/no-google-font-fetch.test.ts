import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, extname } from 'node:path'

/**
 * Guard: `next build` must never fetch fonts over the network.
 *
 * WHY THIS EXISTS — a third party's uptime silently blocked a deploy.
 * `next/font/google` fetches from fonts.googleapis.com and fonts.gstatic.com
 * DURING the build. On 2026-09-21 that fetch failed mid-build and the loader
 * threw `TypeError: Cannot read properties of null (reading '1')` out of
 * @next/font/dist/google/loader.js. CI on master went red; because deploy.yml
 * gates on `workflow_run.conclusion == 'success'`, the deploy job was SKIPPED
 * rather than failed — so the pipeline reported nothing, production kept
 * serving the previous revision, and the merge simply never shipped.
 *
 * The identical tree built green on the PR branch minutes earlier and green on
 * a re-run. Nothing was wrong with the code. That is the whole point: a build
 * that depends on a network fetch fails for reasons unrelated to the change
 * being shipped, at a time nobody chose, in a repository where a skipped deploy
 * is invisible by design.
 *
 * The fonts are vendored in app/fonts (see its README). This test is what stops
 * the dependency creeping back — a comment would not have.
 */

const hubRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const FONT_DIR = join(hubRoot, 'app', 'fonts')

/** Source trees a Next build actually compiles. Only real ones — naming a
 *  directory that does not exist is how a scan quietly covers nothing. */
const SCANNED = ['app', 'lib', 'tests']
const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])

function sourceFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next') continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (CODE_EXT.has(extname(entry))) out.push(full)
    }
  }
  for (const d of SCANNED) walk(join(hubRoot, d))
  return out
}

/**
 * Match the MODULE SPECIFIER, not the mere mention of it.
 *
 * layout.tsx and app/fonts/README.md both discuss `next/font/google` at length
 * in prose explaining why it was removed; a naive substring scan would flag its
 * own documentation and teach the next person to delete the explanation. These
 * patterns only match a real import/require/dynamic-import of the module.
 */
const SPECIFIER = String.raw`@?next/font/google`  // @next/font/google is the pre-13.2 name
const IMPORT_PATTERNS = [
  new RegExp(String.raw`\bfrom\s*['"]${SPECIFIER}['"]`),
  new RegExp(String.raw`\brequire\(\s*['"]${SPECIFIER}['"]\s*\)`),
  new RegExp(String.raw`\bimport\(\s*['"]${SPECIFIER}['"]\s*\)`),
  new RegExp(String.raw`^\s*import\s*['"]${SPECIFIER}['"]`, 'm'),
]

describe('the production build does not fetch fonts over the network', () => {
  it('no source file imports next/font/google', () => {
    const files = sourceFiles()
    // A scan over zero files passes trivially. Its sibling guard in
    // gcloudignore-build-context.test.ts defends against exactly this; so does
    // this one now.
    expect(files.length, 'the source scan matched no files — has the tree moved?').toBeGreaterThan(50)

    const offenders: string[] = []
    for (const file of files) {
      const src = readFileSync(file, 'utf8')
      if (IMPORT_PATTERNS.some((re) => re.test(src))) offenders.push(relative(hubRoot, file))
    }
    expect(
      offenders,
      `next/font/google fetches from fonts.googleapis.com during \`next build\`, which makes every\n` +
        `production build depend on a third party being up. When that fetch failed on 2026-09-21 it\n` +
        `failed CI on master, and deploy.yml's success gate then SKIPPED the deploy — a silent\n` +
        `non-deploy, not a visible failure.\n\n` +
        `Vendor the font into hub/app/fonts and load it with next/font/local instead\n` +
        `(see hub/app/fonts/README.md). Offending file(s): ${offenders.join(', ')}`,
    ).toEqual([])
  })

  it('the vendored font files the layout references are present and are real woff2', () => {
    // Without this, "no google import" could be satisfied by a build that has
    // no usable fonts at all — passing the guard while breaking typography.
    const files = readdirSync(FONT_DIR).filter((f) => f.endsWith('.woff2'))
    expect(files.length, `no .woff2 files in ${relative(hubRoot, FONT_DIR)}`).toBeGreaterThan(0)

    for (const f of files) {
      const buf = readFileSync(join(FONT_DIR, f))
      // woff2 signature, then a big-endian uint32 of the total file length.
      expect(buf.subarray(0, 4).toString('latin1'), `${f} is not a woff2 file`).toBe('wOF2')
      expect(buf.readUInt32BE(8), `${f} is truncated or corrupt`).toBe(buf.length)
    }
  })

  it('every font the layout loads actually exists on disk', () => {
    // Catches a rename or a typo'd src path, which next/font/local would only
    // surface at build time.
    const layout = readFileSync(join(hubRoot, 'app', 'layout.tsx'), 'utf8')
    const refs = [...layout.matchAll(/src:\s*['"]\.\/fonts\/([^'"]+)['"]/g)].map((m) => m[1])
    expect(refs.length, 'layout.tsx references no local fonts — did the loader change?').toBeGreaterThan(0)
    for (const ref of refs) {
      expect(existsSync(join(FONT_DIR, ref)), `layout.tsx references missing font ${ref}`).toBe(true)
    }
  })

  it('ships the OFL licence text and every copyright notice beside the fonts', () => {
    // OFL-1.1 §2 requires the copyright notice AND the licence accompany every
    // copy, including bundled ones — a link is not compliance. OFL.txt is .txt
    // rather than .md on purpose: hub/.gcloudignore excludes *.md, so a
    // Markdown licence would never reach the image that serves these files.
    const ofl = readFileSync(join(FONT_DIR, 'OFL.txt'), 'utf8')
    expect(ofl).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/i)
    expect(ofl).toMatch(/PERMISSION & CONDITIONS/i)
    for (const f of readdirSync(FONT_DIR).filter((x) => x.endsWith('.woff2'))) {
      expect(ofl, `${f} has no copyright notice in app/fonts/OFL.txt`).toContain(f)
    }
    // One notice per bundled family.
    expect((ofl.match(/^\s*Copyright /gm) ?? []).length).toBeGreaterThanOrEqual(
      readdirSync(FONT_DIR).filter((x) => x.endsWith('.woff2')).length,
    )
  })

  it('the vendored fonts are documented', () => {
    const readme = readFileSync(join(FONT_DIR, 'README.md'), 'utf8')
    expect(readme).toMatch(/SIL Open Font License/i)
    for (const f of readdirSync(FONT_DIR).filter((x) => x.endsWith('.woff2'))) {
      expect(readme, `${f} is not listed in app/fonts/README.md`).toContain(f)
    }
  })
})
