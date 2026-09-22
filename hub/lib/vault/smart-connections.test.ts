import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CircuitBreaker } from '@/lib/circuit-breaker'
import {
  _resetSmartConnectionsForTests,
  createSmartConnectionsClient,
  createSmartConnectionsClientFromEnv,
  isSearchLikeTool,
  normalizeLivePath,
  normalizeToolResult,
  parseSseMessages,
  pickTool,
  readSmartConnectionsConfig,
  readSmartConnectionsTimeout,
  titleFromPath,
  toLiveHit,
  DEFAULT_SMART_CONNECTIONS_TIMEOUT_MS,
  DEFAULT_SMART_CONNECTIONS_TOOL,
  LIVE_SOURCE,
  SMART_CONNECTIONS_BREAKER_KEY,
  SMART_CONNECTIONS_TIMEOUT_CAP_MS,
  SMART_CONNECTIONS_TIMEOUT_FLOOR_MS,
} from './smart-connections'
import { VaultUnavailableError } from './errors'
import { createFakeMcp, FAKE_MCP_KEY, FAKE_MCP_URL, type FakeMcp } from '../../test/vault-fake-mcp'

/* ════════════════════════════════════════════════════════════════════════════
   Smart Connections MCP client — fully offline via an injected fetch (the
   fake endpoint in test/vault-fake-mcp.ts). Locks: deny-by-default config,
   the MCP handshake and request shape, tool discovery + argument binding,
   result normalization (never fabricated provenance), every failure class,
   SSE bodies, session expiry, the circuit (caller deadlines excluded), and
   that the key never leaks into a message. No real endpoint is contacted.
   ════════════════════════════════════════════════════════════════════════════ */

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))
vi.mock('@/lib/event-logger', () => ({ recordEvent: vi.fn(async () => {}) }))

const passthrough = <T,>(fn: () => Promise<T>) => fn()

function client(fake: FakeMcp, extra: Partial<Parameters<typeof createSmartConnectionsClient>[0]> = {}) {
  return createSmartConnectionsClient({ url: FAKE_MCP_URL, apiKey: FAKE_MCP_KEY, fetchImpl: fake.fetch, execute: passthrough, ...extra })
}

const failure = async (p: Promise<unknown>): Promise<VaultUnavailableError> => {
  const err = await p.catch((e: unknown) => e)
  expect(err).toBeInstanceOf(VaultUnavailableError)
  expect((err as VaultUnavailableError).stage).toBe('smart_connections')
  expect((err as Error).message).not.toContain(FAKE_MCP_KEY)
  return err as VaultUnavailableError
}

beforeEach(() => {
  _resetSmartConnectionsForTests()
})

describe('readSmartConnectionsConfig — deny by default', () => {
  it('is unconfigured (with a reason naming the variables, never a value) unless BOTH url and key are set', () => {
    expect(readSmartConnectionsConfig({})).toMatchObject({ configured: false, url: null, apiKey: null, detail: 'SMART_CONNECTIONS_URL and SMART_CONNECTIONS_API_KEY are not set' })
    expect(readSmartConnectionsConfig({ SMART_CONNECTIONS_URL: FAKE_MCP_URL })).toMatchObject({ configured: false, detail: 'SMART_CONNECTIONS_API_KEY is not set' })
    expect(readSmartConnectionsConfig({ SMART_CONNECTIONS_API_KEY: FAKE_MCP_KEY })).toMatchObject({ configured: false, detail: 'SMART_CONNECTIONS_URL is not set' })
    expect(readSmartConnectionsConfig({ SMART_CONNECTIONS_URL: '   ', SMART_CONNECTIONS_API_KEY: FAKE_MCP_KEY }).configured).toBe(false)
    expect(createSmartConnectionsClientFromEnv({})).toBeNull()
  })

  it('rejects a URL that is not http(s)', () => {
    for (const bad of ['not a url', 'ftp://desktop.example.test/mcp', 'javascript:alert(1)', 'desktop.example.test/mcp']) {
      const cfg = readSmartConnectionsConfig({ SMART_CONNECTIONS_URL: bad, SMART_CONNECTIONS_API_KEY: FAKE_MCP_KEY })
      expect(cfg.configured).toBe(false)
      expect(cfg.detail).toContain('not a valid http(s) URL')
      expect(JSON.stringify(cfg)).not.toContain(FAKE_MCP_KEY)
    }
  })

  it('exposes the host (loggable), the tool and the clamped timeout when configured', () => {
    const cfg = readSmartConnectionsConfig({ SMART_CONNECTIONS_URL: FAKE_MCP_URL, SMART_CONNECTIONS_API_KEY: ` ${FAKE_MCP_KEY} ` })
    expect(cfg).toMatchObject({ configured: true, host: 'desktop.example.test', apiKey: FAKE_MCP_KEY, tool: DEFAULT_SMART_CONNECTIONS_TOOL, timeoutMs: DEFAULT_SMART_CONNECTIONS_TIMEOUT_MS, detail: null })
    expect(readSmartConnectionsConfig({ SMART_CONNECTIONS_URL: FAKE_MCP_URL, SMART_CONNECTIONS_API_KEY: FAKE_MCP_KEY, SMART_CONNECTIONS_TOOL: 'lookup' }).tool).toBe('lookup')
    // A tool name with shell-ish characters falls back to the default rather than being sent.
    expect(readSmartConnectionsConfig({ SMART_CONNECTIONS_URL: FAKE_MCP_URL, SMART_CONNECTIONS_API_KEY: FAKE_MCP_KEY, SMART_CONNECTIONS_TOOL: 'rm -rf /' }).tool).toBe(DEFAULT_SMART_CONNECTIONS_TOOL)
  })

  it('clamps SMART_CONNECTIONS_TIMEOUT_MS to [floor, cap] and defaults on junk', () => {
    expect(readSmartConnectionsTimeout({})).toBe(4_000)
    expect(readSmartConnectionsTimeout({ SMART_CONNECTIONS_TIMEOUT_MS: 'abc' })).toBe(4_000)
    expect(readSmartConnectionsTimeout({ SMART_CONNECTIONS_TIMEOUT_MS: '-5' })).toBe(4_000)
    expect(readSmartConnectionsTimeout({ SMART_CONNECTIONS_TIMEOUT_MS: '1' })).toBe(SMART_CONNECTIONS_TIMEOUT_FLOOR_MS)
    expect(readSmartConnectionsTimeout({ SMART_CONNECTIONS_TIMEOUT_MS: '2500' })).toBe(2_500)
    expect(readSmartConnectionsTimeout({ SMART_CONNECTIONS_TIMEOUT_MS: '99999' })).toBe(SMART_CONNECTIONS_TIMEOUT_CAP_MS)
    expect(SMART_CONNECTIONS_TIMEOUT_CAP_MS).toBe(8_000)
  })
})

describe('MCP handshake and request shape', () => {
  it('initialize → initialized → tools/list → tools/call, with the bearer, the session id and the protocol version', async () => {
    const fake = createFakeMcp({ results: [{ key: 'Projects/Hub Overlay.md#Deploy', score: 0.83, text: 'deploy notes' }] })
    const c = client(fake)
    const res = await c.search('deploy pipeline', { limit: 5 })
    expect(fake.methods()).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call'])

    const init = fake.calls[0]
    expect(init.headers.authorization).toBe(`Bearer ${FAKE_MCP_KEY}`)
    expect(init.headers.accept).toContain('application/json')
    expect(init.headers.accept).toContain('text/event-stream')
    expect(init.headers['content-type']).toBe('application/json')
    expect(init.headers['user-agent']).toBe('hub-vault-search')
    expect(init.sessionId).toBeNull()
    expect(init.params).toMatchObject({ protocolVersion: '2025-06-18', clientInfo: { name: 'hub-vault-search' } })
    expect(init.init.method).toBe('POST')
    expect(init.init.cache).toBe('no-store')
    expect(init.init.signal).toBeInstanceOf(AbortSignal)

    for (const call of fake.calls.slice(1)) {
      expect(call.sessionId).toBe('session-1')
      expect(call.headers['mcp-protocol-version']).toBe('2025-06-18')
    }
    expect(fake.calls[1].id).toBeNull() // a notification carries no id
    expect(fake.calls[3].params).toEqual({ name: 'search_notes', arguments: { query: 'deploy pipeline', limit: 5 } })

    expect(res.tool).toBe('search_notes')
    expect(res.unmapped).toBe(0)
    expect(res.hits).toEqual([
      {
        vaultPath: 'Projects/Hub Overlay.md',
        noteTitle: 'Hub Overlay',
        headingPath: 'Deploy',
        charStart: null,
        charEnd: null,
        excerpt: 'deploy notes',
        similarity: 0.83,
        contentSha: null,
        indexedCommitSha: null,
        sourceModifiedAt: null,
        indexedAt: null,
        source: LIVE_SOURCE,
        live: true,
      },
    ])
  })

  it('caches the handshake per process: the second search is one round trip; a reset re-handshakes', async () => {
    const fake = createFakeMcp()
    const c = client(fake)
    await c.search('a', { limit: 3 })
    await c.search('b', { limit: 3 })
    expect(fake.methods()).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'tools/call'])
    _resetSmartConnectionsForTests()
    await client(fake).search('c', { limit: 3 })
    expect(fake.methods().slice(5)).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call'])
  })

  it('a stateless server (no Mcp-Session-Id) works without ever sending one', async () => {
    const fake = createFakeMcp({ sessionId: null })
    await client(fake).search('a', { limit: 3 })
    expect(fake.calls.every((c) => c.sessionId === null)).toBe(true)
    expect(fake.methods()).toHaveLength(4)
  })

  it('re-handshakes ONCE when the server forgot the session (404 on tools/call)', async () => {
    const fake = createFakeMcp({ results: [{ path: 'Daily/2026-09-22.md', text: 'x' }] })
    const c = client(fake)
    await c.search('a', { limit: 3 })
    fake.expireSessionOnce = true
    const res = await c.search('b', { limit: 3 })
    expect(res.hits[0].vaultPath).toBe('Daily/2026-09-22.md')
    expect(fake.methods().slice(4)).toEqual(['tools/call', 'initialize', 'notifications/initialized', 'tools/list', 'tools/call'])
    expect(fake.calls[fake.calls.length - 1].sessionId).toBe('session-2')

    // A second consecutive loss is reported, not retried forever.
    fake.expireSessionOnce = true
    fake.sessionId = 'session-9' // nothing we hold matches
    const err = await failure(c.search('c', { limit: 3 }))
    expect(err.reason).toBe('http')
    expect(err.status).toBe(404)
  })

  it('parses text/event-stream bodies (with keepalive comments) as well as JSON', async () => {
    const fake = createFakeMcp({ sse: true, results: [{ key: 'Projects/A.md', text: 'alpha' }] })
    const res = await client(fake).search('alpha', { limit: 2 })
    expect(res.hits[0]).toMatchObject({ vaultPath: 'Projects/A.md', excerpt: 'alpha' })
    expect(parseSseMessages(': ping\n\nevent: message\ndata: {"a":1}\n\ndata: {"b":\ndata: 2}\n\ndata: not json\n\n')).toEqual([{ a: 1 }, { b: 2 }])
  })
})

describe('tool discovery and argument binding', () => {
  it('uses the configured tool when listed, else the first known candidate, adapting arguments to its inputSchema', async () => {
    const fake = createFakeMcp({
      tools: [
        { name: 'write_note', inputSchema: { properties: { path: {}, content: {} } } },
        { name: 'lookup', inputSchema: { type: 'object', properties: { hypotheticals: { type: 'array' }, limit: { type: 'integer' } } } },
      ],
      results: [],
    })
    await client(fake).search('what changed', { limit: 4 })
    expect(fake.calls[3].params).toEqual({ name: 'lookup', arguments: { hypotheticals: ['what changed'], limit: 4 } })
  })

  it('binds `q` / `top_k` style schemas, sends {query, limit} when no schema is published, and never a limit the schema lacks', () => {
    const q = pickTool([{ name: 'search_notes', inputSchema: { properties: { q: { type: 'string' }, top_k: { type: 'number' } } } }], 'search_notes')
    expect(q).toMatchObject({ name: 'search_notes', queryKey: 'q', limitKey: 'top_k', queryIsArray: false, declared: true })
    const bare = pickTool([{ name: 'search_notes' }], 'search_notes')
    expect(bare).toMatchObject({ queryKey: 'query', limitKey: 'limit', declared: false })
    const noLimit = pickTool([{ name: 'semantic_search', inputSchema: { properties: { query: {} } } }], 'search_notes')
    expect(noLimit).toMatchObject({ name: 'semantic_search', limitKey: null })
  })

  it('falls back to a search/lookup-named tool but never to a write-capable one; none → protocol failure naming the fix', async () => {
    expect(pickTool([{ name: 'vault_semantic_lookup' }, { name: 'append_to_note' }], 'search_notes').name).toBe('vault_semantic_lookup')
    expect(() => pickTool([{ name: 'search_and_replace' }, { name: 'create_note' }, { name: 'find_and_edit' }], 'search_notes')).toThrow(/not offered/)
    expect(isSearchLikeTool('smart-search')).toBe(true)
    expect(isSearchLikeTool('semanticSearch')).toBe(true)
    expect(isSearchLikeTool('searchAndReplace')).toBe(false) // camelCase splits into its verbs too
    expect(isSearchLikeTool('search_and_replace')).toBe(false)
    expect(isSearchLikeTool('update_index')).toBe(false)

    const fake = createFakeMcp({ tools: [{ name: 'write_note' }] })
    const err = await failure(client(fake).search('x', { limit: 1 }))
    expect(err.reason).toBe('protocol')
    expect(err.message).toContain('set SMART_CONNECTIONS_TOOL')
    expect(err.message).toContain('write_note')
    expect(fake.methods()).not.toContain('tools/call')

    const empty = createFakeMcp({ mode: 'no_tools' })
    expect((await failure(client(empty).search('x', { limit: 1 }))).message).toContain('listed: none')
  })
})

describe('normalization — the Lane 1 hit shape, provenance never fabricated', () => {
  it('maps tolerant field names, derives the title from the path, splits the block key fragment into a heading path', () => {
    const hit = toLiveHit({ key: 'Areas/Ops/Runbook.md#Deploy#Rollback', score: 0.5, content: 'roll back with …', title: 'IGNORED tool title', mtime: 1_758_500_000 })
    expect(hit).toEqual({
      vaultPath: 'Areas/Ops/Runbook.md',
      noteTitle: 'Runbook',
      headingPath: 'Deploy > Rollback',
      charStart: null,
      charEnd: null,
      excerpt: 'roll back with …',
      similarity: 0.5,
      contentSha: null,
      indexedCommitSha: null,
      sourceModifiedAt: new Date(1_758_500_000 * 1000).toISOString(),
      indexedAt: null,
      source: 'smart_connections_live',
      live: true,
    })
    expect(toLiveHit({ filePath: '.\\Projects\\X.md', heading: 'Intro', snippet: 's', similarity: 0.25 })).toMatchObject({ vaultPath: 'Projects/X.md', headingPath: 'Intro', excerpt: 's', similarity: 0.25 })
    expect(toLiveHit({ path: '/Projects/Y.md', modified: '2026-09-21T10:00:00Z' })).toMatchObject({ vaultPath: 'Projects/Y.md', excerpt: '', similarity: null, sourceModifiedAt: '2026-09-21T10:00:00.000Z' })
  })

  it('never invents a similarity or a date: out-of-range scores and junk timestamps are null', () => {
    expect(toLiveHit({ path: 'A.md', score: 12 })?.similarity).toBeNull()
    expect(toLiveHit({ path: 'A.md', score: -0.1 })?.similarity).toBeNull()
    expect(toLiveHit({ path: 'A.md', score: 'high' })?.similarity).toBeNull()
    expect(toLiveHit({ path: 'A.md', mtime: 'yesterday' })?.sourceModifiedAt).toBeNull()
    expect(toLiveHit({ path: 'A.md', mtime: 42 })?.sourceModifiedAt).toBeNull()
  })

  it('drops items without a usable vault-relative path (parent-escaping, empty, non-object)', () => {
    expect(toLiveHit({ path: '../outside.md', text: 'x' })).toBeNull()
    expect(toLiveHit({ path: 'Projects/./x.md' })).toBeNull()
    expect(toLiveHit({ text: 'no path at all' })).toBeNull()
    expect(toLiveHit('string')).toBeNull()
    expect(toLiveHit(null)).toBeNull()
    expect(normalizeLivePath('  ./Projects//Hub Overlay.md ')).toBe('Projects/Hub Overlay.md')
    expect(normalizeLivePath('x'.repeat(600))).toBeNull()
    expect(titleFromPath('Daily/2026-09-22.MD')).toBe('2026-09-22')
  })

  it('reads structuredContent, JSON text blocks (object with a result list or a bare array), and an empty content array', () => {
    expect(normalizeToolResult({ structuredContent: { results: [{ path: 'A.md', text: 'a' }] } }, 5).hits.map((h) => h.vaultPath)).toEqual(['A.md'])
    expect(normalizeToolResult({ content: [{ type: 'text', text: JSON.stringify({ hits: [{ path: 'B.md' }] }) }] }, 5).hits.map((h) => h.vaultPath)).toEqual(['B.md'])
    expect(normalizeToolResult({ content: [{ type: 'text', text: JSON.stringify([{ path: 'C.md' }, { nope: 1 }]) }] }, 5)).toMatchObject({ unmapped: 1 })
    expect(normalizeToolResult({ content: [] }, 5)).toEqual({ hits: [], unmapped: 0 })
    expect(normalizeToolResult({ content: [{ type: 'text', text: '[]' }] }, 5)).toEqual({ hits: [], unmapped: 0 })
  })

  it('caps the excerpt length and the hit count', () => {
    const r = normalizeToolResult({ structuredContent: Array.from({ length: 30 }, (_, i) => ({ path: `N${i}.md`, text: 'y'.repeat(9_000) })) }, 50)
    expect(r.hits).toHaveLength(20)
    expect(r.hits[0].excerpt).toHaveLength(8_001)
    expect(r.hits[0].excerpt.endsWith('…')).toBe(true)
    expect(normalizeToolResult({ structuredContent: [{ path: 'A.md' }, { path: 'B.md' }] }, 1).hits).toHaveLength(1)
  })

  it('is a protocol failure — never "no results" — for isError, non-JSON text, JSON without a list, or a non-semantic mode', () => {
    expect(() => normalizeToolResult({ content: [{ type: 'text', text: 'model unavailable' }], isError: true }, 5)).toThrow(/tool reported an error: model unavailable/)
    expect(() => normalizeToolResult({ content: [{ type: 'text', text: 'Here are your notes: …' }] }, 5)).toThrow(/not JSON/)
    expect(() => normalizeToolResult({ content: [{ type: 'text', text: '{"status":"ok"}' }] }, 5)).toThrow(/no result list/)
    expect(() => normalizeToolResult({ structuredContent: { status: 'ok' } }, 5)).toThrow(/no result list/)
    expect(() => normalizeToolResult({ structuredContent: { mode: 'keyword', results: [{ path: 'A.md' }] } }, 5)).toThrow(/non-semantic mode "keyword"/)
    expect(() => normalizeToolResult({ content: [{ type: 'text', text: '{"mode":"fallback","results":[]}' }] }, 5)).toThrow(/non-semantic/)
    expect(normalizeToolResult({ structuredContent: { mode: 'semantic', results: [{ path: 'A.md' }] } }, 5).hits).toHaveLength(1)
    expect(() => normalizeToolResult(null, 5)).toThrow(/no result object/)
    expect(() => normalizeToolResult({}, 5)).toThrow(/no content array/)
  })
})

describe('failure classes (never an empty result, never the key)', () => {
  it('401 → auth with the status, and the message carries neither the key nor a stack', async () => {
    const fake = createFakeMcp({ mode: 'auth' })
    const err = await failure(client(fake).search('x', { limit: 1 }))
    expect(err.reason).toBe('auth')
    expect(err.status).toBe(401)
    expect(err.message).toContain('HTTP 401')
    expect(err.message).toContain('unauthorized')
  })

  it('a rotated key on the server side is an auth failure too', async () => {
    const fake = createFakeMcp()
    const err = await failure(client(fake, { apiKey: 'sc-key-STALE-not-the-one-the-server-knows' }).search('x', { limit: 1 }))
    expect(err.reason).toBe('auth')
  })

  it('HTTP 500 → http; a thrown fetch → network (unreachable)', async () => {
    const boom = await failure(client(createFakeMcp({ mode: 'http_500' })).search('x', { limit: 1 }))
    expect(boom).toMatchObject({ reason: 'http', status: 500 })
    expect(boom.message).toContain('boom')
    const down = await failure(client(createFakeMcp({ mode: 'unreachable' })).search('x', { limit: 1 }))
    expect(down.reason).toBe('network')
    expect(down.message).toContain('unreachable')
  })

  it('a hung endpoint → timeout after the client budget, and the request signal is aborted', async () => {
    const fake = createFakeMcp({ mode: 'hang' })
    const t0 = Date.now()
    const err = await failure(client(fake, { timeoutMs: 120 }).search('x', { limit: 1 }))
    expect(err.reason).toBe('timeout')
    expect(Date.now() - t0).toBeLessThan(2_000)
    expect(fake.hung).toHaveLength(1)
    expect(fake.hung[0].aborted).toBe(true)
  })

  it('an already-expired caller signal never dials the endpoint', async () => {
    const fake = createFakeMcp()
    const controller = new AbortController()
    controller.abort()
    const err = await failure(client(fake).search('x', { limit: 1, signal: controller.signal }))
    expect(err.reason).toBe('timeout')
    expect(fake.calls).toHaveLength(0)
  })

  it('garbage (HTML), a JSON-RPC error and a tool error are protocol failures', async () => {
    const html = await failure(client(createFakeMcp({ mode: 'garbage' })).search('x', { limit: 1 }))
    expect(html.reason).toBe('protocol')
    expect(html.message).toContain('non-JSON-RPC body')
    const rpc = await failure(client(createFakeMcp({ mode: 'rpc_error' })).search('x', { limit: 1 }))
    expect(rpc.reason).toBe('protocol')
    expect(rpc.message).toContain('-32602')
    expect(rpc.message).toContain('invalid params')
    const tool = await failure(client(createFakeMcp({ mode: 'tool_error' })).search('x', { limit: 1 }))
    expect(tool.reason).toBe('protocol')
    expect(tool.message).toContain('model unavailable')
    const prose = await failure(client(createFakeMcp({ resultStyle: 'raw-text', results: 'Sure! Here are the notes…' })).search('x', { limit: 1 }))
    expect(prose.reason).toBe('protocol')
  })

  it('a non-JSON-RPC reply whose id does not match is a protocol failure', async () => {
    const odd = vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 999, result: {} }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const err = await failure(createSmartConnectionsClient({ url: FAKE_MCP_URL, apiKey: FAKE_MCP_KEY, fetchImpl: odd as unknown as typeof fetch, execute: passthrough }).search('x', { limit: 1 }))
    expect(err.reason).toBe('protocol')
    expect(err.message).toContain('no JSON-RPC response for id')
  })
})

describe('circuit — own key, caller deadlines do not count', () => {
  it('opens after repeated endpoint failures and then fails fast without dialling', async () => {
    const cb = new CircuitBreaker({ threshold: 3, resetMs: 60_000 })
    const fake = createFakeMcp({ mode: 'http_500' })
    const c = client(fake, { execute: (fn) => cb.execute(SMART_CONNECTIONS_BREAKER_KEY, fn) })
    for (let i = 0; i < 3; i++) expect((await failure(c.search('x', { limit: 1 }))).reason).toBe('http')
    expect(cb.getState(SMART_CONNECTIONS_BREAKER_KEY)).toBe('open')
    const before = fake.calls.length
    const err = await failure(c.search('x', { limit: 1 }))
    expect(err.reason).toBe('breaker_open')
    expect(fake.calls).toHaveLength(before)
  })

  it('the lane’s own timeout counts as an endpoint failure; a caller-deadline abort does not', async () => {
    const cb = new CircuitBreaker({ threshold: 2, resetMs: 60_000 })
    const execute = <T,>(fn: () => Promise<T>) => cb.execute(SMART_CONNECTIONS_BREAKER_KEY, fn)

    // Caller gives up first (tight request deadline) → not the endpoint's fault.
    const patient = client(createFakeMcp({ mode: 'hang' }), { execute, timeoutMs: 5_000 })
    for (let i = 0; i < 3; i++) {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 15)
      expect((await failure(patient.search('x', { limit: 1, signal: controller.signal }))).reason).toBe('timeout')
    }
    expect(cb.getState(SMART_CONNECTIONS_BREAKER_KEY)).toBe('closed')

    // The endpoint itself outlives our own budget → counts, and trips at the threshold.
    const impatient = client(createFakeMcp({ mode: 'hang' }), { execute, timeoutMs: 100 })
    expect((await failure(impatient.search('x', { limit: 1 }))).reason).toBe('timeout')
    expect((await failure(impatient.search('x', { limit: 1 }))).reason).toBe('timeout')
    expect(cb.getState(SMART_CONNECTIONS_BREAKER_KEY)).toBe('open')
  })
})

describe('probe — initialize + tools/list only, never a search, never throws', () => {
  it('reports the server, the resolved tool and the tool count when reachable', async () => {
    const fake = createFakeMcp()
    const execute = vi.fn(async () => { throw new Error('probe must not go through the breaker') })
    const p = await client(fake, { execute: execute as unknown as <T>(fn: () => Promise<T>) => Promise<T> }).probe()
    expect(p.reachable).toBe(true)
    expect(p.latencyMs).toBeGreaterThanOrEqual(0)
    expect(p.detail).toContain('fake-smart-connections answered')
    expect(p.detail).toContain('tool "search_notes"')
    expect(p.detail).toContain('1 tool(s) listed')
    expect(p.detail).toContain('session issued')
    expect(fake.methods()).toEqual(['initialize', 'notifications/initialized', 'tools/list'])
    expect(execute).not.toHaveBeenCalled()
  })

  it('says when the configured tool is not listed but a candidate is, and reports stateless servers', async () => {
    const fake = createFakeMcp({ sessionId: null, tools: [{ name: 'lookup' }] })
    const p = await client(fake).probe()
    expect(p.reachable).toBe(true)
    expect(p.detail).toContain('tool "lookup" (configured "search_notes" is not listed)')
    expect(p.detail).toContain('stateless')
  })

  it('carries the failure class in the detail on auth / network / timeout / protocol, never the key', async () => {
    expect((await client(createFakeMcp({ mode: 'auth' })).probe()).detail).toMatch(/^auth: /)
    expect((await client(createFakeMcp({ mode: 'unreachable' })).probe()).detail).toMatch(/^network: /)
    expect((await client(createFakeMcp({ mode: 'garbage' })).probe()).detail).toMatch(/^protocol: /)
    const slow = await client(createFakeMcp({ mode: 'hang' }), { timeoutMs: 100 }).probe()
    expect(slow.reachable).toBe(false)
    expect(slow.detail).toMatch(/^timeout: /)
    for (const fake of [createFakeMcp({ mode: 'auth' })]) {
      const p = await client(fake).probe()
      expect(p.detail).not.toContain(FAKE_MCP_KEY)
    }
  })
})
