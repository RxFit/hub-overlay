/**
 * An in-memory stand-in for the Smart Connections MCP endpoint (Lane 2),
 * exposed as a `fetch` implementation. Speaks enough MCP streamable HTTP for
 * the client's contract to be exercised for real — initialize with an
 * optional `Mcp-Session-Id`, the initialized notification (202), tools/list,
 * tools/call with JSON-in-text or structuredContent results, optional
 * `text/event-stream` bodies, session expiry — plus scripted failure modes.
 * No network, no real endpoint, no real vault, ever.
 */

export const FAKE_MCP_URL = 'https://desktop.example.test/mcp'
export const FAKE_MCP_KEY = 'sc-key-TEST-NOT-REAL-0123456789abcdef'

export type FakeMcpMode =
  | 'ok'          // normal behaviour
  | 'auth'        // 401 on every request (rotated/revoked key)
  | 'unreachable' // fetch throws (DNS/socket)
  | 'hang'        // never settles until the signal aborts (desktop asleep)
  | 'garbage'     // 200 text/html — not JSON-RPC at all
  | 'http_500'    // 500 with a JSON error body
  | 'rpc_error'   // JSON-RPC error object on tools/call
  | 'tool_error'  // tools/call result with isError: true
  | 'no_tools'    // tools/list answers with an empty list

export interface FakeMcpTool {
  name: string
  description?: string
  inputSchema?: unknown
}

export interface FakeMcpCall {
  method: string
  id: number | null
  params: unknown
  /** Lower-cased header names. */
  headers: Record<string, string>
  sessionId: string | null
  init: RequestInit
}

export interface FakeMcp {
  fetch: typeof fetch
  calls: FakeMcpCall[]
  mode: FakeMcpMode
  /** Payload the search tool answers with (array or object); a function sees the tool arguments. */
  results: unknown | ((args: Record<string, unknown>) => unknown)
  /** How tools/call wraps the payload. */
  resultStyle: 'text' | 'structured' | 'raw-text'
  tools: FakeMcpTool[]
  /** Session id issued by initialize; null = stateless server (no header, no checks). */
  sessionId: string | null
  /** Answer every request with a text/event-stream body. */
  sse: boolean
  /** Reject the next tools/call with 404 once (session gone), then issue a fresh session id. */
  expireSessionOnce: boolean
  /** Signals seen by hung requests (assert they were aborted). */
  hung: AbortSignal[]
  serverName: string
  methods(): string[]
}

export const DEFAULT_FAKE_TOOLS: FakeMcpTool[] = [
  {
    name: 'search_notes',
    description: 'Semantic search over the vault',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] },
  },
]

function abortError(): Error {
  const err = new Error('The operation was aborted')
  err.name = 'AbortError'
  return err
}

export function createFakeMcp(overrides: Partial<Pick<FakeMcp, 'mode' | 'results' | 'resultStyle' | 'tools' | 'sessionId' | 'sse' | 'serverName'>> = {}): FakeMcp {
  const state = {
    mode: 'ok' as FakeMcpMode,
    results: [] as unknown,
    resultStyle: 'text' as FakeMcp['resultStyle'],
    tools: DEFAULT_FAKE_TOOLS.map((t) => ({ ...t })),
    sessionId: 'session-1' as string | null,
    sse: false,
    expireSessionOnce: false,
    serverName: 'fake-smart-connections',
    ...overrides,
  }
  const calls: FakeMcpCall[] = []
  const hung: AbortSignal[] = []
  let sessionGeneration = 1

  function respond(payload: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
    if (state.sse) {
      const body = `: keepalive\n\nevent: message\ndata: ${JSON.stringify(payload)}\n\n`
      return new Response(body, { status, headers: { 'content-type': 'text/event-stream', ...extraHeaders } })
    }
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json', ...extraHeaders } })
  }

  function rpcResult(id: number | null, result: unknown, extraHeaders: Record<string, string> = {}): Response {
    return respond({ jsonrpc: '2.0', id, result }, 200, extraHeaders)
  }

  function rpcError(id: number | null, code: number, message: string): Response {
    return respond({ jsonrpc: '2.0', id, error: { code, message } })
  }

  function wrapToolResult(payload: unknown): unknown {
    if (state.resultStyle === 'structured') return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload }
    if (state.resultStyle === 'raw-text') return { content: [{ type: 'text', text: String(payload) }] }
    return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
  }

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {}
    const rawHeaders = init?.headers
    if (rawHeaders instanceof Headers) rawHeaders.forEach((v, k) => { headers[k.toLowerCase()] = v })
    else if (Array.isArray(rawHeaders)) for (const [k, v] of rawHeaders) headers[k.toLowerCase()] = v
    else if (rawHeaders) for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = String(v)

    let message: { method?: string; id?: number; params?: unknown } = {}
    try {
      message = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as typeof message
    } catch {
      message = {}
    }
    const method = message.method ?? '?'
    const id = typeof message.id === 'number' ? message.id : null
    const sessionId = headers['mcp-session-id'] ?? null
    calls.push({ method, id, params: message.params, headers, sessionId, init: init ?? {} })

    if (state.mode === 'unreachable') throw new TypeError('fetch failed')
    if (state.mode === 'hang') {
      const signal = init?.signal
      if (signal) hung.push(signal)
      return new Promise<Response>((_, reject) => {
        if (!signal) return
        if (signal.aborted) reject(abortError())
        else signal.addEventListener('abort', () => reject(abortError()), { once: true })
      })
    }
    if (state.mode === 'auth' || headers.authorization !== `Bearer ${FAKE_MCP_KEY}`) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } })
    }
    if (state.mode === 'garbage') return new Response('<html><body>Sign in</body></html>', { status: 200, headers: { 'content-type': 'text/html' } })
    if (state.mode === 'http_500') return new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500, headers: { 'content-type': 'application/json' } })

    if (method === 'initialize') {
      const extra: Record<string, string> = {}
      if (state.sessionId) extra['Mcp-Session-Id'] = state.sessionId
      return rpcResult(id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: state.serverName, version: '1.0.0' } }, extra)
    }
    if (state.sessionId && sessionId !== state.sessionId) {
      return new Response(JSON.stringify({ error: 'session not found' }), { status: 404, headers: { 'content-type': 'application/json' } })
    }
    if (method === 'notifications/initialized') return new Response(null, { status: 202 })
    if (method === 'tools/list') return rpcResult(id, { tools: state.mode === 'no_tools' ? [] : state.tools })
    if (method === 'tools/call') {
      if (state.expireSessionOnce && state.sessionId) {
        state.expireSessionOnce = false
        sessionGeneration++
        state.sessionId = `session-${sessionGeneration}`
        return new Response(JSON.stringify({ error: 'session not found' }), { status: 404, headers: { 'content-type': 'application/json' } })
      }
      if (state.mode === 'rpc_error') return rpcError(id, -32602, 'invalid params')
      if (state.mode === 'tool_error') return rpcResult(id, { content: [{ type: 'text', text: 'model unavailable' }], isError: true })
      const params = (message.params ?? {}) as { name?: string; arguments?: Record<string, unknown> }
      const known = state.tools.some((t) => t.name === params.name)
      if (!known) return rpcError(id, -32602, `unknown tool ${String(params.name)}`)
      const payload = typeof state.results === 'function' ? (state.results as (a: Record<string, unknown>) => unknown)(params.arguments ?? {}) : state.results
      return rpcResult(id, wrapToolResult(payload))
    }
    return rpcError(id, -32601, `unknown method ${method}`)
  }

  const fake: FakeMcp = {
    fetch: fetchImpl as unknown as typeof fetch,
    calls,
    hung,
    methods: () => calls.map((c) => c.method),
    get mode() { return state.mode },
    set mode(v) { state.mode = v },
    get results() { return state.results },
    set results(v) { state.results = v },
    get resultStyle() { return state.resultStyle },
    set resultStyle(v) { state.resultStyle = v },
    get tools() { return state.tools },
    set tools(v) { state.tools = v },
    get sessionId() { return state.sessionId },
    set sessionId(v) { state.sessionId = v },
    get sse() { return state.sse },
    set sse(v) { state.sse = v },
    get expireSessionOnce() { return state.expireSessionOnce },
    set expireSessionOnce(v) { state.expireSessionOnce = v },
    get serverName() { return state.serverName },
    set serverName(v) { state.serverName = v },
  }
  return fake
}
