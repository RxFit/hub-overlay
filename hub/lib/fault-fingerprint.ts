import crypto from 'crypto'

/**
 * Fault fingerprinting (ERROR_REPORTING_2026-08-24.md §5).
 *
 * Pure, I/O-free, Date-free — the same shape as toRunRow (lib/runs.ts) and
 * toAuditRow (lib/ai-audit.ts), unit-tested in isolation
 * (lib/fault-fingerprint.test.ts).
 *
 * Cascade mirroring Sentry's documented precedence:
 *   explicit override > in-app stack frames > normalized message.
 * `route` is ALWAYS in the key so one generic `timeout_idle` does not swallow
 * every downstream dependency. `release` is deliberately NOT in the key —
 * otherwise every deploy forges brand-new issues and regression detection
 * dies.
 */

export type FingerprintStrategy = 'explicit' | 'frames' | 'message'

/**
 * Frames are `${fn}@${repoRelativeFile}` — NO LINE NUMBERS. Rollbar's
 * documented reason: line numbers churn on unrelated edits above the fault,
 * so a pre-existing bug that shifts from line 47 to 52 becomes a brand-new
 * group and the old one looks fixed. Both halves of that are wrong.
 */
const FRAME_RE = /^\s*at\s+(?:(.+?)\s+\()?(.+?):\d+:\d+\)?\s*$/

// The `.next` exemption is load-bearing. In the container (Dockerfile WORKDIR
// /app) EVERY server frame is /app/.next/server/..., so a blanket `.next`
// filter makes inAppFrames() return [] and drops every server fault to the
// WEAKEST rung. Exempt compiled app code explicitly.
const VENDOR_RE = /node_modules|[\\/]\.next[\\/](?!server[\\/]app[\\/])|[\\/]next[\\/]dist[\\/]|^node:|^internal[\\/]/

// Also strips the webpack prefixes `--enable-source-maps` actually produces
// under `next start`, which otherwise survive into the frame and churn per
// build.
const DEPLOY_ROOT_RE = /^(?:file:\/\/)?(?:webpack:\/\/_N_E\/\.\/|webpack-internal:\/\/\/\(rsc\)\/\.\/)?(?:\/app|\/workspace|[A-Za-z]:)?[\\/]*(?:home[\\/][^\\/]+[\\/])?(?:hub-overlay[\\/])?(?:hub[\\/])?/

/**
 * Tokens that ARE the grouping signal and must survive normalization: HTTP
 * status codes, Postgres SQLSTATEs, and known errno strings. A blanket digit
 * rule would shred exactly the discriminators you need.
 */
const PRESERVE_NUMERIC = /^(?:[1-5]\d{2}|23505|23503|23502|40001|57014|53300)$/

/**
 * ORDERED, most-specific-first. Order is load-bearing: a greedy `\d{3,}` rule
 * run first shreds the digits inside a UUID / IP / ISO timestamp and yields a
 * skeleton that never matches another occurrence of the same error again.
 */
const NORMALIZERS: Array<[RegExp, string]> = [
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>'],
  [/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<ts>'],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>'],
  [/\bhttps?:\/\/[^\s"'<>)]+/gi, '<url>'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<ip>'],
  [/\b[0-9a-f]{8,}\b/gi, '<hex>'],
  [/'[^']{1,120}'|"[^"]{1,120}"/g, '<str>'],
]

/** Normalize an operator message into a stable grouping skeleton. */
export function normalizeMessage(raw: string): string {
  let out = raw.replace(/\s+/g, ' ').trim()
  for (const [re, token] of NORMALIZERS) out = out.replace(re, token)
  // Bare digits LAST, and only when they are not a meaningful code. No \b
  // anchors: '30000ms' has no word boundary between digit and unit, and the
  // unit-glued run is exactly the case that must tokenize.
  out = out.replace(/\d{3,}/g, (m) => (PRESERVE_NUMERIC.test(m) ? m : '<n>'))
  return out.slice(0, 240)
}

/** Reduce a raw V8 stack to at most `max` normalized IN-APP frames. */
export function inAppFrames(stack: string | null | undefined, max = 3): string[] {
  if (!stack) return []
  const frames: string[] = []
  for (const line of stack.split('\n')) {
    const m = FRAME_RE.exec(line)
    if (!m) continue
    const fn = (m[1] ?? '<anon>').replace(/\s+/g, '')
    const file = m[2]
    if (VENDOR_RE.test(file)) continue
    // Strip the deploy root and any cache-busting query string. Both differ
    // per container and per build; neither identifies the bug.
    const rel = file.replace(DEPLOY_ROOT_RE, '').split('?')[0]
    frames.push(`${fn}@${rel}`)
    if (frames.length >= max) break
  }
  return frames
}

export interface FingerprintInput {
  code: string
  layer: string
  route?: string | null
  errName?: string | null
  message: string
  stack?: string | null
  /** Escape hatch for over-grouping: a call site that knows better wins. */
  explicit?: string | null
}

export interface FingerprintResult {
  fingerprint: string
  strategy: FingerprintStrategy
}

export function fingerprintFault(input: FingerprintInput): FingerprintResult {
  const base = [input.layer, input.code, input.route ?? '-', input.errName ?? '-']

  if (input.explicit) {
    return { fingerprint: hash([...base, `explicit:${input.explicit}`]), strategy: 'explicit' }
  }

  const frames = inAppFrames(input.stack, 3)
  if (frames.length > 0) {
    return { fingerprint: hash([...base, ...frames]), strategy: 'frames' }
  }

  return { fingerprint: hash([...base, normalizeMessage(input.message)]), strategy: 'message' }
}

function hash(parts: string[]): string {
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16)
}
