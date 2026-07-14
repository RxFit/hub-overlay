#!/usr/bin/env node
/**
 * Build gate: fail the build if any HTML page was statically prerendered.
 *
 * WHY: middleware.ts serves a strict CSP (`script-src 'nonce-…' 'strict-dynamic'`)
 * with a fresh nonce per request. Next.js only stamps that nonce onto its
 * <script> tags during per-request (dynamic) rendering. A statically
 * prerendered page is served from the build-time cache with NO nonces, so the
 * browser blocks every script and the app ships as a dead shell — no
 * hydration, no session, no working buttons (production outage 2026-07-13).
 *
 * `next dev` always renders dynamically, so neither Playwright e2e nor manual
 * dev testing can catch a regression here; only the production build can.
 * app/layout.tsx exports `dynamic = 'force-dynamic'` to keep every page
 * dynamic — if a refactor drops that (or a route overrides it), this script
 * turns the silent dead-site failure into a loud build failure.
 *
 * Runs as part of `npm run build` (locally, in CI, and in the Docker image).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const hubRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const manifestPath = join(hubRoot, '.next', 'prerender-manifest.json')

let manifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch (err) {
  console.error(`[assert-dynamic-rendering] Cannot read ${manifestPath} — run this after \`next build\`. (${err.message})`)
  process.exit(1)
}

// Every route in the prerender manifest was rendered at build time. Error
// pages (/_not-found, /404, /500) never carry the app bundle and are fine;
// anything else means a real page would be served without CSP nonces.
const ALLOWED = new Set(['/_not-found', '/404', '/500'])
const offenders = Object.keys(manifest.routes ?? {}).filter(r => !ALLOWED.has(r))

if (offenders.length > 0) {
  console.error(
    '[assert-dynamic-rendering] FAIL — these routes were statically prerendered:\n' +
    offenders.map(r => `  - ${r}`).join('\n') +
    '\n\nStatic pages are served WITHOUT the per-request CSP nonce that ' +
    'middleware.ts requires, so browsers block all their scripts and the page ' +
    'is dead on arrival (no hydration, no session, no buttons).\n' +
    "Keep `export const dynamic = 'force-dynamic'` in app/layout.tsx and do " +
    'not override it in route segments.'
  )
  process.exit(1)
}

console.log('[assert-dynamic-rendering] OK — no statically prerendered pages; CSP nonces apply to every route.')
