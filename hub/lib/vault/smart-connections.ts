import { breaker, CircuitOpenError } from '@/lib/circuit-breaker'
import { swallow } from '@/lib/swallow'
import { VaultUnavailableError, type VaultFailureReason } from './errors'

/**
 * Smart Connections live lane client (Lane 2) — OPTIONAL, READ-ONLY, DENY BY
 * DEFAULT, ADVISORY ONLY.
 *
 * Danny runs the Obsidian Smart Connections plugin on his desktop. It exposes
 * an MCP endpoint (streamable HTTP) that answers semantic searches against the
 * LIVE vault — fresher than the hourly git snapshot Lane 1 indexes, but only
 * while the desktop is online. This client is the only code that talks to it.
 *
 * What it is NOT: a second canonical corpus. lib/vault/live-evidence.ts folds
 * every result of this client into a `liveEvidence` block beside the canonical
 * hits; nothing here can re-rank, filter or replace a Lane 1 hit.
 *
 * Configuration (runtime env vars, bound from Secret Manager by the owner —
 * never created by code, never committed):
 *   SMART_CONNECTIONS_URL         the MCP endpoint (http(s) URL)
 *   SMART_CONNECTIONS_API_KEY     sent as `Authorization: Bearer …`
 *   SMART_CONNECTIONS_TOOL        semantic-search tool name (default
 *                                 'search_notes'; endpoint versions differ, and
 *                                 the name is verified against tools/list at
 *                                 runtime with a small candidate fallback list)
 *   SMART_CONNECTIONS_TIMEOUT_MS  whole-call budget (default 4000, cap 8000)
 * FAIL CLOSED: with the URL or the key unset the lane is `disabled` and no
 * request is ever made (readSmartConnectionsConfig().configured === false).
 *
 * Protocol (MCP streamable HTTP, JSON-RPC 2.0 over POST):
 *   initialize → notifications/initialized → tools/list (guard: the tool must
 *   exist) → tools/call. A server that hands back `Mcp-Session-Id` gets it on
 *   every later request; a stateless server simply never does. The handshake
 *   (session + resolved tool) is cached per process for HANDSHAKE_TTL_MS so a
 *   search is normally ONE round trip; a 404/400 on tools/call (session gone)
 *   re-handshakes once. Responses may be `application/json` or a
 *   `text/event-stream` carrying the JSON-RPC response — both are parsed.
 *
 * Failure contract — every failure REJECTS with VaultUnavailableError (stage
 * 'smart_connections'): auth (401/403) / network (unreachable) / timeout (our
 * budget or the caller's deadline) / http (other non-2xx) / protocol (not
 * JSON-RPC, JSON-RPC error, tool missing, tool error, unrecognized result
 * shape, non-semantic result mode) / breaker_open. Own circuit
 * `vault-smart-connections` (lib/circuit-breaker.ts): a failure caused by the
 * CALLER's deadline expiring is not counted against the endpoint.
 *
 * Normalization: each live hit is mapped to the Lane 1 hit shape as far as the
 * tool's payload allows — vaultPath, path-derived noteTitle, headingPath,
 * excerpt, similarity (only when reported in 0..1) — and everything the live
 * tool cannot vouch for is null: contentSha, indexedCommitSha, indexedAt,
 * charStart/charEnd. Provenance is never fabricated. Every hit carries
 * `source: 'smart_connections_live'` and `live: true`.
 *
 * SECURITY: the key appears only in the Authorization header — never in a
 * log, an error message or a health report. Logs carry the endpoint HOST
 * only. Note text returned by the tool is DATA: never logged, and rendered
 * downstream only as plain text (the Lane 1 untrusted-content rule applies
 * verbatim). `fetchImpl` is injectable so tests run fully offline.
 */

export const SMART_CONNECTIONS_BREAKER_KEY = 'vault-smart-connections'
export const DEFAULT_SMART_CONNECTIONS_TOOL = 'search_notes'
export const DEFAULT_SMART_CONNECTIONS_TIMEOUT_MS = 4_000
export const SMART_CONNECTIONS_TIMEOUT_CAP_MS = 8_000
export const SMART_CONNECTIONS_TIMEOUT_FLOOR_MS = 100
export const MCP_PROTOCOL_VERSION = '2025-06-18'
export const LIVE_SOURCE = 'smart_connections_live'

/** Tool names tried, in order, when the configured one is not listed. */
export const TOOL_CANDIDATES = ['search_notes', 'semantic_search', 'search', 'lookup', 'smart_search', 'search_vault', 'vault_search', 'find_notes'] as const

const HANDSHAKE_TTL_MS = 5 * 60_000
const MAX_BODY_CHARS = 1_000_000
const MAX_EXCERPT_CHARS = 8_000
const MAX_HITS = 20
const MAX_PATH_CHARS = 512
const USER_AGENT = 'hub-vault-search'
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/

type Env = Record<string, string | undefined>

export interface SmartConnectionsConfig {
  configured: boolean
  url: string | null
  /** Host part of the URL — the only identifying value that may be logged. */
  host: string | null
  apiKey: string | null
  tool: string
  timeoutMs: number
  /** Why `configured` is false (operator-facing, names variables only). */
  detail: string | null
}

export function readSmartConnectionsTimeout(env: Env = process.env): number {
  const raw = Number(env.SMART_CONNECTIONS_TIMEOUT_MS)
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_SMART_CONNECTIONS_TIMEOUT_MS
  return Math.min(SMART_CONNECTIONS_TIMEOUT_CAP_MS, Math.max(SMART_CONNECTIONS_TIMEOUT_FLOOR_MS, Math.round(raw)))
}

/**
 * Deny by default: `configured` is true only when BOTH the URL (a valid
 * http(s) URL) and the key are set. Nothing read here is ever logged.
 */
export function readSmartConnectionsConfig(env: Env = process.env): SmartConnectionsConfig {
  const url = (env.SMART_CONNECTIONS_URL ?? '').trim()
  const apiKey = (env.SMART_CONNECTIONS_API_KEY ?? '').trim()
  const toolRaw = (env.SMART_CONNECTIONS_TOOL ?? '').trim()
  const tool = TOOL_NAME.test(toolRaw) ? toolRaw : DEFAULT_SMART_CONNECTIONS_TOOL
  const timeoutMs = readSmartConnectionsTimeout(env)
  const base = { url: null, host: null, apiKey: null, tool, timeoutMs }

  if (!url && !apiKey) return { ...base, configured: false, detail: 'SMART_CONNECTIONS_URL and SMART_CONNECTIONS_API_KEY are not set' }
  if (!url) return { ...base, configured: false, detail: 'SMART_CONNECTIONS_URL is not set' }
  if (!apiKey) return { ...base, configured: false, detail: 'SMART_CONNECTIONS_API_KEY is not set' }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ...base, configured: false, detail: 'SMART_CONNECTIONS_URL is not a valid http(s) URL' }
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ...base, configured: false, detail: 'SMART_CONNECTIONS_URL is not a valid http(s) URL' }
  }
  return { configured: true, url: parsed.toString(), host: parsed.host, apiKey, tool, timeoutMs, detail: null }
}

export function isSmartConnectionsConfigured(env: Env = process.env): boolean {
  return readSmartConnectionsConfig(env).configured
}

/* ── Result shape ────────────────────────────────────────────────────────── */

export interface LiveVaultHit {
  vaultPath: string
  /** Derived from the path (basename without .md) — never from tool-supplied text. */
  noteTitle: string | null
  headingPath: string | null
  charStart: null
  charEnd: null
  excerpt: string
  /** The tool's score, only when it reported one in 0..1; otherwise null. */
  similarity: number | null
  contentSha: null
  indexedCommitSha: null
  /** Only when the tool reports a modification time; never inferred. */
  sourceModifiedAt: string | null
  indexedAt: null
  source: typeof LIVE_SOURCE
  live: true
}

export interface SmartConnectionsSearchResult {
  hits: LiveVaultHit[]
  /** The tool that answered (may differ from the configured name after discovery). */
  tool: string
  /** Items the tool returned that carried no usable vault path (dropped, counted). */
  unmapped: number
}

export interface SmartConnectionsProbe {
  reachable: boolean
  latencyMs: number
  /** Operator-facing: server name, tool resolved, tool count — or the failure class + message. */
  detail: string
}

export interface SmartConnectionsClient {
  readonly host: string
  readonly timeoutMs: number
  readonly configuredTool: string
  search(query: string, opts: { limit: number; signal?: AbortSignal }): Promise<SmartConnectionsSearchResult>
  /** initialize + tools/list only (no search); bounded by timeoutMs; never throws. */
  probe(opts?: { signal?: AbortSignal }): Promise<SmartConnectionsProbe>
}

export interface SmartConnectionsClientOptions {
  url: string
  apiKey: string
  tool?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
  /** Breaker seam; default = the global breaker under SMART_CONNECTIONS_BREAKER_KEY. */
  execute?: <T>(fn: () => Promise<T>) => Promise<T>
  now?: () => number
}

/* ── Handshake cache (per process) ───────────────────────────────────────── */

interface ToolBinding {
  name: string
  /** Argument key the tool's inputSchema declares for the query text. */
  queryKey: string
  /** True when the schema wants an array of query strings (Smart Connections' `hypotheticals`). */
  queryIsArray: boolean
  /** Argument key for the result limit, when the schema declares one. */
  limitKey: string | null
  /** False when the tool published no inputSchema (then `{query, limit}` is sent). */
  declared: boolean
}

interface Handshake {
  sessionId: string | null
  protocolVersion: string
  tool: ToolBinding
  serverName: string | null
  toolCount: number
  expiresAt: number
}

const handshakes = new Map<string, Handshake>()

/** Test hook: forget every cached session/tool binding. */
export function _resetSmartConnectionsForTests(): void {
  handshakes.clear()
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function combineSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b
  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any
  if (typeof anyFn === 'function') return anyFn([a, b])
  return a.aborted ? a : b
}

function unavailable(reason: VaultFailureReason, message: string, status?: number): VaultUnavailableError {
  return new VaultUnavailableError('smart_connections', reason, message, status)
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
}

const QUERY_KEYS = ['query', 'q', 'text', 'search', 'prompt', 'hypotheticals'] as const
const LIMIT_KEYS = ['limit', 'top_k', 'topK', 'k', 'max_results', 'maxResults', 'n', 'count'] as const

function bindTool(tool: { name: string; inputSchema?: unknown }): ToolBinding {
  const schema = tool.inputSchema as { properties?: Record<string, { type?: unknown }> } | undefined
  const props = schema && typeof schema === 'object' && schema.properties && typeof schema.properties === 'object' ? schema.properties : null
  if (!props) return { name: tool.name, queryKey: 'query', queryIsArray: false, limitKey: 'limit', declared: false }
  const queryKey = QUERY_KEYS.find((k) => k in props) ?? 'query'
  const queryIsArray = props[queryKey]?.type === 'array'
  const limitKey = LIMIT_KEYS.find((k) => k in props) ?? null
  return { name: tool.name, queryKey, queryIsArray, limitKey, declared: true }
}

const SEARCH_VERBS = new Set(['search', 'lookup', 'find', 'query', 'retrieve', 'similar'])
const MUTATION_VERBS = new Set(['write', 'create', 'update', 'delete', 'append', 'move', 'rename', 'replace', 'insert', 'patch', 'remove', 'edit', 'put', 'set', 'add', 'modify', 'upsert', 'save'])

/** snake_case, kebab-case and camelCase all split into their verbs. */
const nameTokens = (name: string): string[] => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)

/** A read-only search-shaped name: has a search verb and no mutation verb anywhere in it. */
export function isSearchLikeTool(name: string): boolean {
  const tokens = nameTokens(name)
  return tokens.some((t) => SEARCH_VERBS.has(t)) && !tokens.some((t) => MUTATION_VERBS.has(t))
}

/**
 * The configured tool wins when listed; otherwise the first listed candidate;
 * otherwise the first tool whose name is search-shaped (isSearchLikeTool).
 * Nothing else is ever called — a write-capable tool is never a fallback.
 */
export function pickTool(tools: Array<{ name: string; inputSchema?: unknown }>, configured: string): ToolBinding {
  const byName = new Map(tools.map((t) => [t.name, t] as const))
  const exact = byName.get(configured)
  if (exact) return bindTool(exact)
  for (const candidate of TOOL_CANDIDATES) {
    const t = byName.get(candidate)
    if (t) return bindTool(t)
  }
  const fuzzy = tools.find((t) => isSearchLikeTool(t.name))
  if (fuzzy) return bindTool(fuzzy)
  const listed = tools.map((t) => t.name).slice(0, 10).join(', ')
  throw unavailable('protocol', `tool "${configured}" is not offered by the endpoint (listed: ${listed || 'none'}); set SMART_CONNECTIONS_TOOL`)
}

function buildArguments(tool: ToolBinding, query: string, limit: number): Record<string, unknown> {
  const args: Record<string, unknown> = { [tool.queryKey]: tool.queryIsArray ? [query] : query }
  if (tool.limitKey) args[tool.limitKey] = limit
  return args
}

/** Parse a `text/event-stream` body into its JSON `data:` payloads (bounded, tolerant). */
export function parseSseMessages(body: string): unknown[] {
  const out: unknown[] = []
  for (const block of body.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n')
    if (!data.trim()) continue
    try {
      out.push(JSON.parse(data))
    } catch {
      // A non-JSON event (keepalive, comment) is not an error; the response we
      // need is a JSON-RPC message and is matched by id below.
    }
  }
  return out
}

function firstString(o: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'string' && v.trim()) return v
  }
  return null
}

function firstNumber(o: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return null
}

function toIso(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const ms = value > 1e12 ? value : value > 1e9 ? value * 1000 : NaN
    if (!Number.isFinite(ms)) return null
    const d = new Date(ms)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  if (typeof value === 'string' && value.trim()) {
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  return null
}

const PATH_KEYS = ['path', 'vaultPath', 'vault_path', 'file', 'filePath', 'file_path', 'notePath', 'note_path', 'key', 'source'] as const
const EXCERPT_KEYS = ['excerpt', 'text', 'content', 'snippet', 'body', 'chunk', 'preview', 'contents'] as const
const SCORE_KEYS = ['similarity', 'score', 'sim', 'relevance', 'cosine'] as const
const HEADING_KEYS = ['heading', 'headingPath', 'heading_path', 'section', 'breadcrumbs'] as const
const MODIFIED_KEYS = ['mtime', 'modified', 'modifiedAt', 'modified_at', 'lastModified', 'last_modified', 'updated', 'updatedAt'] as const

/** Vault-relative, forward-slashed, no leading ./ or /, never a parent-escaping path. */
export function normalizeLivePath(raw: string): string | null {
  const p = raw.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '').replace(/\/{2,}/g, '/')
  if (!p || p.length > MAX_PATH_CHARS) return null
  if (p.split('/').some((seg) => seg === '..' || seg === '.')) return null
  return p
}

export function titleFromPath(path: string): string {
  const base = path.split('/').pop() ?? path
  return base.replace(/\.md$/i, '')
}

/**
 * Map one raw tool item to a LiveVaultHit, or null when it carries no usable
 * vault path. A Smart Connections block key looks like
 * `Folder/Note.md#Heading#Sub` — the fragment becomes the heading path.
 */
export function toLiveHit(item: unknown): LiveVaultHit | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null
  const o = item as Record<string, unknown>
  const rawKey = firstString(o, PATH_KEYS)
  if (!rawKey) return null
  const hash = rawKey.indexOf('#')
  const rawPath = hash >= 0 ? rawKey.slice(0, hash) : rawKey
  const fragment = hash >= 0 ? rawKey.slice(hash + 1) : ''
  const vaultPath = normalizeLivePath(rawPath)
  if (!vaultPath) return null

  const explicitHeading = firstString(o, HEADING_KEYS)
  const fragmentHeading = fragment.split('#').map((s) => s.trim()).filter(Boolean).join(' > ')
  const headingPath = (explicitHeading ?? fragmentHeading).trim().slice(0, 300) || null

  const excerptRaw = firstString(o, EXCERPT_KEYS) ?? ''
  const excerpt = excerptRaw.length > MAX_EXCERPT_CHARS ? `${excerptRaw.slice(0, MAX_EXCERPT_CHARS)}…` : excerptRaw

  const score = firstNumber(o, SCORE_KEYS)
  const similarity = score !== null && score >= 0 && score <= 1 ? Number(score.toFixed(6)) : null

  let sourceModifiedAt: string | null = null
  for (const k of MODIFIED_KEYS) {
    sourceModifiedAt = toIso(o[k])
    if (sourceModifiedAt) break
  }

  return {
    vaultPath,
    noteTitle: titleFromPath(vaultPath),
    headingPath,
    charStart: null,
    charEnd: null,
    excerpt,
    similarity,
    contentSha: null,
    indexedCommitSha: null,
    sourceModifiedAt,
    indexedAt: null,
    source: LIVE_SOURCE,
    live: true,
  }
}

const ITEM_ARRAY_KEYS = ['results', 'items', 'hits', 'matches', 'notes', 'blocks', 'entries', 'data'] as const

/** Find the result list inside a tool payload: a bare array, or the first known list field of an object. */
function extractItems(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== 'object') return null
  const o = value as Record<string, unknown>
  for (const k of ITEM_ARRAY_KEYS) {
    if (Array.isArray(o[k])) return o[k] as unknown[]
  }
  return null
}

/** AGENTS.md rule: a keyword/fallback answer is not semantic evidence — refuse it rather than pass it off as such. */
function assertSemanticMode(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const mode = (value as Record<string, unknown>).mode
  if (typeof mode === 'string' && mode.trim() && mode.trim().toLowerCase() !== 'semantic') {
    throw unavailable('protocol', `tool answered in non-semantic mode "${mode.trim().slice(0, 40)}"; live evidence withheld`)
  }
}

/**
 * Normalize a tools/call result. Accepts `structuredContent` (object or list)
 * or JSON inside text content blocks. `isError` and a payload that cannot be
 * read are protocol failures — never silently "no results".
 */
export function normalizeToolResult(result: unknown, limit: number): { hits: LiveVaultHit[]; unmapped: number } {
  if (!result || typeof result !== 'object') throw unavailable('protocol', 'tools/call returned no result object')
  const r = result as { content?: unknown; structuredContent?: unknown; isError?: unknown }
  if (r.isError === true) {
    const blocks = Array.isArray(r.content) ? (r.content as Array<{ type?: unknown; text?: unknown }>) : []
    const text = blocks.find((b) => b && b.type === 'text' && typeof b.text === 'string')?.text as string | undefined
    throw unavailable('protocol', `tool reported an error${text ? `: ${text.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`)
  }

  let items: unknown[] | null = null
  if (r.structuredContent !== undefined && r.structuredContent !== null) {
    assertSemanticMode(r.structuredContent)
    items = extractItems(r.structuredContent)
  }
  if (!items && Array.isArray(r.content)) {
    let sawText = false
    let sawJson = false
    for (const block of r.content as Array<{ type?: unknown; text?: unknown }>) {
      if (!block || block.type !== 'text' || typeof block.text !== 'string') continue
      if (!block.text.trim()) continue
      sawText = true
      let parsed: unknown
      try {
        parsed = JSON.parse(block.text)
      } catch {
        continue
      }
      sawJson = true
      assertSemanticMode(parsed)
      const found = extractItems(parsed)
      if (found) {
        items = items ? items.concat(found) : found
      }
    }
    if (!items && sawText && !sawJson) throw unavailable('protocol', 'unrecognized result shape (text content is not JSON)')
    if (!items && sawJson) throw unavailable('protocol', 'unrecognized result shape (no result list in the JSON payload)')
  }
  if (!items) {
    // An empty content array is a legitimate "no matches".
    if (Array.isArray(r.content) && r.content.length === 0) return { hits: [], unmapped: 0 }
    if (r.structuredContent !== undefined) throw unavailable('protocol', 'unrecognized result shape (no result list in structuredContent)')
    if (!Array.isArray(r.content)) throw unavailable('protocol', 'unrecognized result shape (no content array)')
    return { hits: [], unmapped: 0 }
  }

  const hits: LiveVaultHit[] = []
  let unmapped = 0
  for (const item of items) {
    const hit = toLiveHit(item)
    if (hit) hits.push(hit)
    else unmapped++
  }
  return { hits: hits.slice(0, Math.min(MAX_HITS, Math.max(1, limit))), unmapped }
}

/* ── Client ──────────────────────────────────────────────────────────────── */

interface RpcReply {
  result?: unknown
  error?: { code?: number; message?: string }
  sessionId: string | null
}

export function createSmartConnectionsClient(options: SmartConnectionsClientOptions): SmartConnectionsClient {
  const fetchImpl = options.fetchImpl ?? fetch
  const url = options.url
  const host = new URL(url).host
  const apiKey = options.apiKey
  const configuredTool = options.tool && TOOL_NAME.test(options.tool) ? options.tool : DEFAULT_SMART_CONNECTIONS_TOOL
  const timeoutMs = Math.min(SMART_CONNECTIONS_TIMEOUT_CAP_MS, Math.max(SMART_CONNECTIONS_TIMEOUT_FLOOR_MS, options.timeoutMs ?? DEFAULT_SMART_CONNECTIONS_TIMEOUT_MS))
  const execute = options.execute ?? (<T>(fn: () => Promise<T>) => breaker.execute(SMART_CONNECTIONS_BREAKER_KEY, fn))
  const now = options.now ?? (() => Date.now())
  const cacheKey = `${url}\n${configuredTool}`
  let nextId = 1

  /** One JSON-RPC round trip. `id: null` sends a notification (no reply expected). */
  async function rpc(
    method: string,
    params: unknown,
    ctx: { id: number | null; sessionId: string | null; protocolVersion: string | null; signal: AbortSignal; what: string },
  ): Promise<RpcReply> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'User-Agent': USER_AGENT,
    }
    if (ctx.sessionId) headers['Mcp-Session-Id'] = ctx.sessionId
    if (ctx.protocolVersion) headers['MCP-Protocol-Version'] = ctx.protocolVersion
    const message: Record<string, unknown> = { jsonrpc: '2.0', method }
    if (params !== undefined) message.params = params
    if (ctx.id !== null) message.id = ctx.id

    let res: Response
    try {
      res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(message), signal: ctx.signal, cache: 'no-store', redirect: 'manual' })
    } catch (err) {
      if (isAbort(err) || ctx.signal.aborted) {
        throw unavailable('timeout', `Smart Connections ${ctx.what} aborted after ${timeoutMs}ms or by the caller's deadline`)
      }
      throw unavailable('network', `Smart Connections ${ctx.what} unreachable: ${err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)}`)
    }

    if (!res.ok) {
      const body = await res.text().catch((err: unknown) => {
        swallow(err, { module: 'vault-smart-connections', op: 'readErrorBody' })
        return ''
      })
      let upstream = ''
      try {
        const parsed = JSON.parse(body) as { error?: unknown; message?: unknown }
        const e = parsed.error
        upstream = typeof e === 'string' ? e : e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string' ? (e as { message: string }).message : typeof parsed.message === 'string' ? parsed.message : ''
      } catch {
        upstream = body
      }
      const reason: VaultFailureReason = res.status === 401 || res.status === 403 ? 'auth' : 'http'
      throw unavailable(reason, `Smart Connections ${ctx.what} failed with HTTP ${res.status}${upstream ? `: ${upstream.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`, res.status)
    }

    const sessionId = res.headers.get('mcp-session-id') ?? ctx.sessionId
    if (ctx.id === null || res.status === 202 || res.status === 204) {
      // A notification's reply carries nothing we read; release the body so
      // the connection is not held open until GC.
      void res.body?.cancel().catch((err: unknown) => swallow(err, { module: 'vault-smart-connections', op: 'cancelNotificationBody', severity: 'expected' }))
      return { sessionId }
    }

    const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
    const text = await res.text().catch((err: unknown) => {
      throw unavailable('protocol', `Smart Connections ${ctx.what} body unreadable: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`)
    })
    if (text.length > MAX_BODY_CHARS) throw unavailable('protocol', `Smart Connections ${ctx.what} response exceeds ${MAX_BODY_CHARS} chars`)

    let messages: unknown[]
    if (contentType.includes('text/event-stream')) {
      messages = parseSseMessages(text)
    } else {
      try {
        messages = [JSON.parse(text)]
      } catch {
        throw unavailable('protocol', `Smart Connections ${ctx.what} returned a non-JSON-RPC body (content-type ${contentType || 'unknown'})`)
      }
    }
    const reply = messages
      .flatMap((m) => (Array.isArray(m) ? m : [m]))
      .find((m): m is Record<string, unknown> => Boolean(m) && typeof m === 'object' && (m as Record<string, unknown>).id === ctx.id)
    if (!reply) throw unavailable('protocol', `Smart Connections ${ctx.what} returned no JSON-RPC response for id ${ctx.id}`)
    if (reply.error !== undefined && reply.error !== null) {
      const e = reply.error as { code?: unknown; message?: unknown }
      return { error: { code: typeof e.code === 'number' ? e.code : undefined, message: typeof e.message === 'string' ? e.message : undefined }, sessionId }
    }
    return { result: reply.result, sessionId }
  }

  function rpcErrorText(what: string, error: { code?: number; message?: string }): string {
    return `Smart Connections ${what} rejected (${error.code ?? 'no code'}${error.message ? `: ${error.message.replace(/\s+/g, ' ').slice(0, 200)}` : ''})`
  }

  /** initialize → initialized → tools/list; resolves the tool binding. */
  async function handshake(signal: AbortSignal): Promise<Handshake> {
    const init = await rpc(
      'initialize',
      { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: USER_AGENT, version: '1' } },
      { id: nextId++, sessionId: null, protocolVersion: null, signal, what: 'initialize' },
    )
    if (init.error) throw unavailable('protocol', rpcErrorText('initialize', init.error))
    const initResult = (init.result ?? {}) as { protocolVersion?: unknown; serverInfo?: { name?: unknown } }
    if (!init.result || typeof init.result !== 'object') throw unavailable('protocol', 'Smart Connections initialize returned no result')
    const protocolVersion = typeof initResult.protocolVersion === 'string' && initResult.protocolVersion ? initResult.protocolVersion : MCP_PROTOCOL_VERSION
    const serverName = typeof initResult.serverInfo?.name === 'string' ? initResult.serverInfo.name.slice(0, 80) : null
    const sessionId = init.sessionId

    // The spec wants this notification before any request; a server that
    // dislikes it (some stateless ones 405) is still usable.
    await rpc('notifications/initialized', {}, { id: null, sessionId, protocolVersion, signal, what: 'initialized notification' }).catch((err: unknown) => {
      if (err instanceof VaultUnavailableError && (err.reason === 'timeout' || err.reason === 'network' || err.reason === 'auth')) throw err
      swallow(err, { module: 'vault-smart-connections', op: 'initializedNotification', severity: 'expected' })
    })

    const list = await rpc('tools/list', {}, { id: nextId++, sessionId, protocolVersion, signal, what: 'tools/list' })
    if (list.error) throw unavailable('protocol', rpcErrorText('tools/list', list.error))
    const tools = (list.result as { tools?: unknown } | undefined)?.tools
    if (!Array.isArray(tools)) throw unavailable('protocol', 'Smart Connections tools/list returned no tools array')
    const named = tools.filter((t): t is { name: string; inputSchema?: unknown } => Boolean(t) && typeof t === 'object' && typeof (t as { name?: unknown }).name === 'string')
    const tool = pickTool(named, configuredTool)
    return { sessionId, protocolVersion, tool, serverName, toolCount: named.length, expiresAt: now() + HANDSHAKE_TTL_MS }
  }

  async function ensureHandshake(signal: AbortSignal, force = false): Promise<Handshake> {
    const cached = handshakes.get(cacheKey)
    if (!force && cached && cached.expiresAt > now()) return cached
    handshakes.delete(cacheKey)
    const fresh = await handshake(signal)
    handshakes.set(cacheKey, fresh)
    return fresh
  }

  async function callTool(hs: Handshake, query: string, limit: number, signal: AbortSignal): Promise<SmartConnectionsSearchResult> {
    const reply = await rpc(
      'tools/call',
      { name: hs.tool.name, arguments: buildArguments(hs.tool, query, limit) },
      { id: nextId++, sessionId: hs.sessionId, protocolVersion: hs.protocolVersion, signal, what: `tools/call ${hs.tool.name}` },
    )
    if (reply.error) throw unavailable('protocol', rpcErrorText(`tools/call ${hs.tool.name}`, reply.error))
    const normalized = normalizeToolResult(reply.result, limit)
    return { ...normalized, tool: hs.tool.name }
  }

  async function doSearch(query: string, limit: number, signal: AbortSignal): Promise<SmartConnectionsSearchResult> {
    const hadCache = handshakes.has(cacheKey)
    let hs = await ensureHandshake(signal)
    try {
      return await callTool(hs, query, limit, signal)
    } catch (err) {
      const sessionGone = err instanceof VaultUnavailableError && err.reason === 'http' && (err.status === 404 || err.status === 400)
      if (sessionGone && hadCache && !signal.aborted) {
        // The server forgot our session (restart, expiry): handshake again, once.
        hs = await ensureHandshake(signal, true)
        return await callTool(hs, query, limit, signal)
      }
      if (!(err instanceof VaultUnavailableError) || (err.reason !== 'timeout' && err.reason !== 'auth')) handshakes.delete(cacheKey)
      throw err
    }
  }

  return {
    host,
    timeoutMs,
    configuredTool,

    async search(query, opts) {
      const limit = Math.min(MAX_HITS, Math.max(1, Math.floor(opts.limit)))
      const callerSignal = opts.signal
      if (callerSignal?.aborted) throw unavailable('timeout', 'caller deadline already expired before the live search started')
      const own = new AbortController()
      const timer = setTimeout(() => own.abort(), timeoutMs)
      const signal = combineSignals(callerSignal, own.signal)
      type Outcome = { ok: true; value: SmartConnectionsSearchResult } | { ok: false; err: VaultUnavailableError }
      try {
        const outcome = await execute<Outcome>(async () => {
          try {
            return { ok: true, value: await doSearch(query, limit, signal) }
          } catch (err) {
            // The caller gave up first: not the endpoint's failure, so it must
            // not count toward opening the circuit. Everything else does.
            if (callerSignal?.aborted && !own.signal.aborted) {
              return { ok: false, err: err instanceof VaultUnavailableError ? err : unavailable('timeout', "live search abandoned by the caller's deadline") }
            }
            throw err
          }
        }).catch((err: unknown) => {
          if (err instanceof CircuitOpenError) throw unavailable('breaker_open', 'Smart Connections circuit is open after repeated failures')
          throw err
        })
        if (!outcome.ok) throw outcome.err
        return outcome.value
      } catch (err) {
        if (err instanceof VaultUnavailableError) throw err
        throw unavailable('internal', `Smart Connections search failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)}`)
      } finally {
        clearTimeout(timer)
      }
    },

    async probe(opts) {
      const t0 = now()
      const own = new AbortController()
      const timer = setTimeout(() => own.abort(), timeoutMs)
      const signal = combineSignals(opts?.signal, own.signal)
      try {
        const hs = await ensureHandshake(signal, true)
        const toolNote = hs.tool.name === configuredTool ? `tool "${hs.tool.name}"` : `tool "${hs.tool.name}" (configured "${configuredTool}" is not listed)`
        return { reachable: true, latencyMs: now() - t0, detail: `${hs.serverName ?? 'MCP server'} answered; ${toolNote}; ${hs.toolCount} tool(s) listed${hs.sessionId ? '; session issued' : '; stateless'}` }
      } catch (err) {
        const reason = err instanceof VaultUnavailableError ? err.reason : 'internal'
        const message = err instanceof Error ? err.message : String(err)
        return { reachable: false, latencyMs: now() - t0, detail: `${reason}: ${message.replace(/\s+/g, ' ').slice(0, 300)}` }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

/** Build the client from env, or null when the lane is not configured (fail closed). */
export function createSmartConnectionsClientFromEnv(env: Env = process.env, extra: Partial<SmartConnectionsClientOptions> = {}): SmartConnectionsClient | null {
  const cfg = readSmartConnectionsConfig(env)
  if (!cfg.configured || !cfg.url || !cfg.apiKey) return null
  return createSmartConnectionsClient({ url: cfg.url, apiKey: cfg.apiKey, tool: cfg.tool, timeoutMs: cfg.timeoutMs, ...extra })
}
