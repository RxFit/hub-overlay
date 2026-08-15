import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createLogger } from '@/lib/logger'

/**
 * lib/agy.ts — the Antigravity CLI (agy) execution gateway (Phase 1).
 *
 * Runs a single headless prompt through the locally installed `agy` binary on
 * the SUBSCRIPTION ALLOTMENT (consumer OAuth), instead of metered API billing.
 * Phase 0 (scripts/agy/ at the repo root) proved the one load-bearing
 * assumption: a desktop-minted OAuth token replays on a fresh, keyring-less
 * Linux box. This module is the production form of that proof, and it keeps
 * Phase 0's paranoia because the failure modes are real:
 *
 *  - agy's worst bug is SILENT: `agy -p` can write nothing and exit 0 when
 *    stdout is not a real terminal (upstream #76/#408). Every run therefore
 *    executes under a real pseudo-terminal via `script -qec` (present in
 *    node:22-slim — bsdutils is Debian-Essential), and EMPTY OUTPUT IS ALWAYS
 *    FAILURE. Exit codes are never trusted in either direction.
 *  - Keyring/D-Bus don't exist on Cloud Run. The SSH_* env vars force agy's
 *    file-based token storage, and the token file is materialized lazily from
 *    the AGY_OAUTH_TOKEN env var (Secret-Manager-backed, same JSON-string
 *    pattern as GOOGLE_SERVICE_ACCOUNT_KEY). An already-present token file is
 *    never overwritten — agy refreshes it in place, and clobbering it with the
 *    (possibly staler) env copy could revoke a live session.
 *
 * Everything is lazy: no env reads, filesystem access, or binary resolution at
 * module scope — `next build` runs with zero env and CI has no agy binary.
 * Failures throw Error objects carrying a typed `agyError` field (mirroring
 * lib/claude.ts's `claudeError`) so callers and the admin health probe can
 * classify without string-matching.
 *
 * Phase 2 (lib/agy-chat.ts) wires this into the chat engine behind the
 * opt-in AGY_CHAT_ENABLED flag; /api/admin/agy-health remains the diagnostic
 * surface. See docs/runbooks/agy-gateway.md § Phase 2.
 */

const log = createLogger('agy')

export interface AgyUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  totalTokens?: number
}

export interface AgyResult {
  text: string
  model?: string
  usage?: AgyUsage
  /** The parsed JSON envelope exactly as agy emitted it (for the ledger). */
  raw: unknown
  latencyMs: number
}

export type AgyErrorType =
  | 'not_configured'
  | 'not_installed'
  | 'install'
  | 'auth'
  | 'empty'
  | 'timeout'
  | 'parse'
  | 'spawn'
  | 'unknown'

export interface AgyError {
  type: AgyErrorType
  message: string
}

export interface AgyOptions {
  /** Model slug to pin (default: agy's own default, or AGY_MODEL env). */
  model?: string
  effort?: 'low' | 'medium' | 'high'
  /** Hard wall-clock ceiling for the whole run. Default 120s (AGY_TIMEOUT_MS). */
  timeoutMs?: number
}

/** Where agy's file-based storage expects the OAuth token. */
export function agyTokenPath(): string {
  return join(homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
}

/**
 * Non-throwing presence probe (healthz-style pair to the throwing path below,
 * mirroring isClaudeConfigured/isGeminiConfigured).
 */
export function isAgyConfigured(): boolean {
  return Boolean(process.env.AGY_OAUTH_TOKEN) || existsSync(agyTokenPath())
}

/** Which credential source a run would use right now. */
export function agyTokenSource(): 'file' | 'env' | 'none' {
  if (existsSync(agyTokenPath())) return 'file'
  if (process.env.AGY_OAUTH_TOKEN) return 'env'
  return 'none'
}

/** Non-reversible identity of a credential: 12-hex sha256 prefix + byte
 *  length. Enough to prove two copies are the same bytes; useless to an
 *  attacker. Never returns any part of the token itself. */
export function credentialFingerprint(value: string | null | undefined): { sha256: string; bytes: number } | null {
  if (!value) return null
  return {
    sha256: createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12),
    bytes: Buffer.byteLength(value, 'utf8'),
  }
}

/**
 * Which credential bytes THIS instance would actually use, fingerprinted.
 *
 * The experiment this exists for: "is the token we pushed to Secret Manager
 * the token that just failed?" was unanswerable, because the health report
 * only exposed a boolean. Worse, `ensureTokenFile()` returns early when a
 * token file already exists, so a warm instance can serve from a stale
 * on-disk copy while the env var holds a newer one — invisibly. Comparing
 * `env.sha256` against the local file's hash proves delivery; `file` present
 * with a DIFFERENT hash proves the run under test used older bytes.
 */
export function agyCredentialReport(): {
  env: { sha256: string; bytes: number } | null
  file: { sha256: string; bytes: number; mtime: string } | null
} {
  const env = credentialFingerprint(process.env.AGY_OAUTH_TOKEN)
  let file: { sha256: string; bytes: number; mtime: string } | null = null
  try {
    const target = agyTokenPath()
    if (existsSync(target)) {
      const contents = readFileSync(target, 'utf8')
      const fp = credentialFingerprint(contents)
      if (fp) file = { ...fp, mtime: statSync(target).mtime.toISOString() }
    }
  } catch {
    // Unreadable token file is not worth failing a health report over.
  }
  return { env, file }
}

/**
 * Is the binary already on disk (no install needed)? The chat path gates on
 * this so an interactive turn NEVER pays the ~55MB download + ~206MB extract:
 * a cold instance answers from the metered chain while `warmAgyBinary()`
 * provisions in the background, and agy serves from the next turn on.
 */
export function isAgyBinaryReady(): boolean {
  return resolveBinary() !== null
}

/**
 * Fire-and-forget binary provisioning. Shares the install memo with real runs
 * (concurrent callers coalesce into one download); failures are logged and
 * swallowed — the next warm attempt or real run retries because a failed
 * install clears the memo.
 */
export function warmAgyBinary(): void {
  void ensureBinary().catch((err) => {
    log.warn({ err: truncateAgyError(err) }, 'background agy binary warm-up failed')
  })
}

function agyError(type: AgyErrorType, message: string): Error {
  return Object.assign(new Error(message), { agyError: { type, message } satisfies AgyError })
}

/** Extract the typed classification from any thrown value. */
export function agyErrorType(err: unknown): AgyErrorType {
  const e = err as { agyError?: AgyError } | null
  return e?.agyError?.type ?? 'unknown'
}

/** Admin-probe-safe error text: single line, bounded length. */
export function truncateAgyError(err: unknown, max = 300): string {
  const msg = err instanceof Error ? err.message : String(err)
  const flat = msg.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/* ── Internals (each lazy; exported pieces are pure helpers for tests) ───── */

function binaryCandidates(): string[] {
  return [
    process.env.AGY_CLI_PATH,
    '/usr/local/bin/agy',
    join(homedir(), '.local', 'bin', 'agy'),
    runtimeInstallPath(),
  ].filter((c): c is string => Boolean(c))
}

function resolveBinary(): string | null {
  for (const candidate of binaryCandidates()) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function runtimeInstallPath(): string {
  return join(tmpdir(), 'agy-cli', 'agy')
}

/**
 * Download + checksum-verify the agy binary at runtime (first use per
 * instance). This deliberately does NOT happen at image build time: the
 * release server is an undocumented third-party endpoint, and coupling
 * `gcloud run deploy` to it broke the deploy pipeline on 2026-08-14. A
 * runtime failure instead surfaces as a typed 'install' error in agy-health
 * while deploys stay independent. Cloud Run's /tmp is writable (in-memory).
 */
async function installBinary(): Promise<string> {
  const base = process.env.AGY_DOWNLOAD_BASE_URL || 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app'
  const archMap: Record<string, string> = { x64: 'amd64', arm64: 'arm64' }
  const arch = archMap[process.arch]
  if (!arch || process.platform !== 'linux') {
    throw agyError('install', `runtime install unsupported on ${process.platform}/${process.arch} — set AGY_CLI_PATH`)
  }

  let manifest: { version?: string; url?: string; sha512?: string }
  try {
    const res = await fetch(`${base}/manifests/linux_${arch}.json`)
    if (!res.ok) throw new Error(`manifest HTTP ${res.status}`)
    manifest = await res.json()
  } catch (err) {
    throw agyError('install', `agy manifest fetch failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!manifest.url || !manifest.sha512) {
    throw agyError('install', 'agy release manifest missing url/sha512')
  }

  let payload: Buffer
  try {
    const res = await fetch(manifest.url)
    if (!res.ok) throw new Error(`download HTTP ${res.status}`)
    payload = Buffer.from(await res.arrayBuffer())
  } catch (err) {
    throw agyError('install', `agy binary download failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  const actual = createHash('sha512').update(payload).digest('hex')
  if (actual !== manifest.sha512) {
    throw agyError('install', 'agy binary sha512 mismatch against release manifest — refusing to install')
  }

  const target = runtimeInstallPath()
  await mkdir(dirname(target), { recursive: true })
  if (/\.tar\.gz(\?|$)/.test(manifest.url)) {
    // Cloud Run's /tmp is tmpfs, so every byte left here is RAM held for the
    // life of the instance against a 1Gi limit. The extracted binary (~206MB
    // as of 1.1.13) has to stay; the ~55MB archive does not, so it is removed
    // as soon as extraction is done — and on the failure path too, so a broken
    // install doesn't strand the archive in memory until the instance recycles.
    const staging = join(dirname(target), 'agy.tar.gz')
    await writeFile(staging, payload)
    try {
      await new Promise<void>((resolve, reject) => {
        execFile('tar', ['-xzf', staging, '-C', dirname(target), 'antigravity'], (err) =>
          err ? reject(agyError('install', `agy archive extraction failed: ${err.message}`)) : resolve(),
        )
      })
      await new Promise<void>((resolve, reject) => {
        execFile('mv', [join(dirname(target), 'antigravity'), target], (err) =>
          err ? reject(agyError('install', `agy binary move failed: ${err.message}`)) : resolve(),
        )
      })
    } finally {
      await rm(staging, { force: true })
    }
  } else {
    await writeFile(target, payload)
  }
  await chmod(target, 0o755)
  log.info({ target, version: manifest.version }, 'agy binary installed at runtime (checksum verified)')
  return target
}

// Memoized so concurrent first calls share one download instead of racing.
let installInFlight: Promise<string> | null = null

/** Test-only: clear the install memo (mirrors gemini.ts __resetModelCooldownsForTest). */
export function __resetAgyInstallForTest(): void {
  installInFlight = null
}

async function ensureBinary(): Promise<string> {
  const found = resolveBinary()
  if (found) return found
  if (!installInFlight) {
    installInFlight = installBinary().catch((err) => {
      installInFlight = null // allow retry on the next call
      throw err
    })
  }
  return installInFlight
}

async function ensureTokenFile(): Promise<void> {
  const target = agyTokenPath()
  if (existsSync(target)) return
  const tokenJson = process.env.AGY_OAUTH_TOKEN
  if (!tokenJson) {
    throw agyError(
      'not_configured',
      `No agy credential: AGY_OAUTH_TOKEN is unset and no token file exists at ${target}. ` +
        'See docs/runbooks/agy-gateway.md.',
    )
  }
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, tokenJson, { mode: 0o600 })
  log.info({ target }, 'materialized agy token file from AGY_OAUTH_TOKEN')
}

/**
 * POSIX single-quote escaping. The prompt travels inside the `sh -c` string
 * that `script -qec` runs, so this is the injection boundary — everything is
 * wrapped in single quotes and embedded quotes become '\''.
 */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** Strip ANSI escapes, CR repaints, and TUI box/spinner glyphs. */
export function stripTui(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1B\][^\x07]*(\x07|\x1B\\)/g, '')
    .replace(/\r/g, '')
    .replace(/[│╭╮╰╯─⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, '')
}

const AUTH_FAILURE_RE = /authentication required|not logged into antigravity|authentication (failed|timed out|failed or timed out)/i

/** Find and parse the JSON object embedded in (possibly pty-wrapped) output. */
export function extractJsonEnvelope(cleaned: string): unknown | undefined {
  const end = cleaned.lastIndexOf('}')
  if (end === -1) return undefined
  let from = 0
  for (let attempt = 0; attempt < 20; attempt++) {
    const start = cleaned.indexOf('{', from)
    if (start === -1 || start > end) return undefined
    try {
      return JSON.parse(cleaned.slice(start, end + 1))
    } catch {
      from = start + 1
    }
  }
  return undefined
}

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim() !== '') return v
  }
  return undefined
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return undefined
}

/**
 * Pull { text, model, usage } out of agy's --output-format json envelope.
 * The envelope shape is undocumented and has already changed across CLI
 * releases, so every field is looked up under its known aliases.
 */
export function interpretEnvelope(envelope: unknown): { text?: string; model?: string; usage?: AgyUsage } {
  const e = (envelope ?? {}) as Record<string, unknown>
  const inner = (typeof e.result === 'object' && e.result !== null ? e.result : {}) as Record<string, unknown>
  const usageSrc = ([e.usage, e.stats, inner.usage].find((u) => typeof u === 'object' && u !== null) ?? {}) as Record<
    string,
    unknown
  >
  const usage: AgyUsage = {
    inputTokens: firstNumber(usageSrc.input_tokens, usageSrc.inputTokens, usageSrc.prompt_tokens),
    outputTokens: firstNumber(usageSrc.output_tokens, usageSrc.outputTokens, usageSrc.completion_tokens),
    cacheReadTokens: firstNumber(
      usageSrc.cache_read_tokens,
      usageSrc.cacheReadTokens,
      usageSrc.cache_read_input_tokens,
    ),
    totalTokens: firstNumber(usageSrc.total_tokens, usageSrc.totalTokens),
  }
  const hasUsage = Object.values(usage).some((v) => v !== undefined)
  return {
    text: firstString(e.response, e.result, e.text, e.output, inner.response, inner.text, inner.output),
    model: firstString(e.model, e.modelUsed, inner.model),
    usage: hasUsage ? usage : undefined,
  }
}

interface RunOutcome {
  output: string
  exitCode: number | null
  timedOut: boolean
}

function runUnderPty(inner: string, timeoutMs: number): Promise<RunOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn('script', ['-qec', inner, '/dev/null'], {
      env: {
        ...process.env,
        // Force agy's file-based token storage (no keyring/D-Bus here).
        SSH_CONNECTION: process.env.SSH_CONNECTION ?? '127.0.0.1 0 127.0.0.1 22',
        SSH_CLIENT: process.env.SSH_CLIENT ?? '127.0.0.1 0 22',
        SSH_TTY: process.env.SSH_TTY ?? '/dev/pts/0',
        // The binary must not replace itself mid-request.
        AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let output = ''
    let timedOut = false
    let settled = false

    const termTimer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, timeoutMs)
    const killTimer = setTimeout(() => child.kill('SIGKILL'), timeoutMs + 10_000)

    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(termTimer)
      clearTimeout(killTimer)
      reject(agyError('spawn', `failed to spawn pty runner: ${err.message}`))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(termTimer)
      clearTimeout(killTimer)
      resolve({ output, exitCode: code, timedOut })
    })
  })
}

/* ── Public entry points ─────────────────────────────────────────────────── */

/**
 * `agy --version`, or null when no binary is present yet. Deliberately PASSIVE:
 * never triggers the runtime install, so the cheap health report stays cheap —
 * a null here just means the first real run will provision the binary.
 */
export function agyVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    const bin = resolveBinary()
    if (!bin) {
      resolve(null)
      return
    }
    execFile(bin, ['--version'], { timeout: 10_000 }, (err, stdout) => {
      resolve(err ? null : stdout.trim() || null)
    })
  })
}

/**
 * Run one prompt headlessly on the allotment and return the parsed result.
 * Stateless one-shot by design: no --continue, no conversation state — every
 * call stands alone so prompt-cache reuse depends only on the prompt prefix.
 */
export async function agyGenerateText(prompt: string, opts: AgyOptions = {}): Promise<AgyResult> {
  const started = Date.now()
  await ensureTokenFile() // fail on missing credential before paying for a download
  const bin = await ensureBinary()

  const timeoutMs = opts.timeoutMs ?? Number(process.env.AGY_TIMEOUT_MS ?? 120_000)
  // agy's own print timeout fires first so we get its error text instead of a kill.
  const printTimeoutSec = Math.max(10, Math.floor((timeoutMs - 10_000) / 1000))
  const model = opts.model ?? process.env.AGY_MODEL

  const parts = [
    shQuote(bin),
    '-p',
    shQuote(prompt),
    '--output-format json',
    '--dangerously-skip-permissions',
    `--print-timeout ${printTimeoutSec}s`,
  ]
  if (model) parts.push(`--model ${shQuote(model)}`)
  if (opts.effort) parts.push(`--effort ${shQuote(opts.effort)}`)

  const { output, exitCode, timedOut } = await runUnderPty(parts.join(' '), timeoutMs)
  const cleaned = stripTui(output).trim()

  if (timedOut) {
    // A dead token can LOOK like a timeout: with stdin at EOF, agy's fallback
    // to interactive OAuth blocks at a prompt until the hard ceiling fires.
    // Classify on the captured text first — otherwise a permanent auth failure
    // is filed as transient upstream latency and the evidence is discarded.
    if (AUTH_FAILURE_RE.test(cleaned)) {
      throw agyError(
        'auth',
        'agy blocked on interactive OAuth until the hard ceiling — the token did not replay. ' +
          `Re-mint it on a desktop (see docs/runbooks/agy-gateway.md). Output tail: ${cleaned.slice(-200)}`,
      )
    }
    throw agyError(
      'timeout',
      `agy run exceeded ${timeoutMs}ms hard ceiling and was killed. Output tail: ${cleaned.slice(-300)}`,
    )
  }
  if (cleaned === '') {
    // The silent-failure mode. Empty is NEVER success, whatever the exit code.
    throw agyError('empty', `agy produced no output (exit ${exitCode}) — treating as failure, never success`)
  }

  // Classification order matters: a SUCCESSFUL answer that merely DISCUSSES
  // auth failures (this Hub's operator asks about auth a lot) must not match
  // AUTH_FAILURE_RE and read as a dead token — that would cool the gateway
  // for 30 minutes on a perfectly good run. So: parse the envelope first, and
  // treat auth-failure text as the verdict only when no usable answer exists.
  const envelope = extractJsonEnvelope(cleaned)
  const interpreted = envelope === undefined ? undefined : interpretEnvelope(envelope)
  if (interpreted?.text === undefined) {
    if (AUTH_FAILURE_RE.test(cleaned)) {
      throw agyError(
        'auth',
        'agy fell back to interactive OAuth — the token did not replay. Re-mint it on a desktop ' +
          `(see docs/runbooks/agy-gateway.md). Output tail: ${cleaned.slice(-200)}`,
      )
    }
    if (envelope === undefined) {
      throw agyError(
        'parse',
        `agy output contained no JSON envelope despite --output-format json (exit ${exitCode}). ` +
          `Output tail: ${cleaned.slice(-300)}`,
      )
    }
    const keys = typeof envelope === 'object' && envelope !== null ? Object.keys(envelope).join(', ') : typeof envelope
    throw agyError('parse', `agy JSON envelope had no recognizable text field (top-level keys: ${keys})`)
  }
  const { text, model: usedModel, usage } = interpreted

  const latencyMs = Date.now() - started
  log.info(
    {
      latencyMs,
      model: usedModel,
      exitCode,
      cacheReadTokens: usage?.cacheReadTokens,
      outputTokens: usage?.outputTokens,
    },
    'agy run complete',
  )
  return { text, model: usedModel, usage, raw: envelope, latencyMs }
}
