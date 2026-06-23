import type { ChatMessage } from '@/types'

/* ══════════════════════════════════════════════════════════════════════════════
   CLAUDE FABLE 5 API CLIENT
   ──────────────────────────────────────────────────────────────────────────────
   Uses raw fetch against the Anthropic Messages API — zero npm dependencies.
   Two modes:
     • streamClaudeChat()  — SSE streaming for interactive chat
     • claudeChat()        — single-shot for structured scoring tasks
   ══════════════════════════════════════════════════════════════════════════════ */

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

/* Model rotation: Fable 5 is primary; Sonnet 4.6 is the backup it falls back to
   (e.g. while Fable 5 is unavailable). When Fable 5 recovers, the cooldown in
   the rotation layer (lib/gemini.ts) expires and it is tried first again. */
export const CLAUDE_PRIMARY_MODEL = 'claude-fable-5'
export const CLAUDE_BACKUP_MODEL = 'claude-sonnet-4-6'

function getApiKey(): string {
  // Accept the canonical name plus the casings the Cloud Run service mounts
  // (Anthropic_API_Key / anthropic_token) — env vars are case-sensitive on
  // Linux, so without these fallbacks Claude/Fable 5 is silently unavailable in
  // production and every request falls back to Gemini.
  const key =
    process.env.ANTHROPIC_API_KEY ||
    process.env.Anthropic_API_Key ||
    process.env.anthropic_token
  if (!key) {
    throw new Error('ANTHROPIC_API_KEY is not set. Claude Fable 5 is unavailable.')
  }
  return key
}

function buildAnthropicMessages(messages: ChatMessage[]): { role: string; content: string }[] {
  return messages
    .filter(m => m.role !== 'system')
    .map(m => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.content,
    }))
}

/* ── Error classification for W-2 (rate limit vs real failure) ── */

export interface ClaudeError {
  type: 'rate_limit' | 'auth' | 'server' | 'network' | 'unknown'
  message: string
  retryAfterMs?: number
}

function classifyError(status: number, body: string): ClaudeError {
  if (status === 429) {
    // W-2 FIX: Parse Retry-After and classify separately from real failures
    const retryMatch = body.match(/"retry_after":\s*(\d+)/)
    const retryAfterMs = retryMatch ? parseInt(retryMatch[1], 10) * 1000 : 30_000
    return { type: 'rate_limit', message: `Rate limited (429). Retry after ${retryAfterMs}ms`, retryAfterMs }
  }
  if (status === 401 || status === 403) {
    return { type: 'auth', message: `Auth error (${status}): ${body.slice(0, 200)}` }
  }
  if (status >= 500) {
    return { type: 'server', message: `Server error (${status}): ${body.slice(0, 200)}` }
  }
  return { type: 'unknown', message: `HTTP ${status}: ${body.slice(0, 200)}` }
}

/* ── Non-streaming: single-shot for structured tasks (score-context) ── */

export async function claudeChat(
  messages: ChatMessage[],
  systemPrompt: string,
  options: { model?: string; maxTokens?: number; temperature?: number } = {}
): Promise<string> {
  const { model = CLAUDE_PRIMARY_MODEL, maxTokens = 2048, temperature = 0.3 } = options
  const apiKey = getApiKey()

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 45_000)

  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature,
        system: systemPrompt,
        messages: buildAnthropicMessages(messages),
      }),
    })

    if (!res.ok) {
      const body = await res.text()
      const err = classifyError(res.status, body)
      throw Object.assign(new Error(err.message), { claudeError: err })
    }

    const data = await res.json()
    return data.content?.[0]?.text ?? ''
  } finally {
    clearTimeout(timeoutId)
  }
}

/* ── Streaming: SSE-based for interactive chat ── */

export async function* streamClaudeChat(
  messages: ChatMessage[],
  systemPrompt: string,
  options: { model?: string; maxTokens?: number; temperature?: number } = {}
): AsyncGenerator<string> {
  const { model = CLAUDE_PRIMARY_MODEL, maxTokens = 4096, temperature = 0.7 } = options
  const apiKey = getApiKey()

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 45_000)

  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature,
        stream: true,
        system: systemPrompt,
        messages: buildAnthropicMessages(messages),
      }),
    })

    if (!res.ok) {
      const body = await res.text()
      const err = classifyError(res.status, body)
      throw Object.assign(new Error(err.message), { claudeError: err })
    }

    if (!res.body) throw new Error('No response body from Claude')

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = '' // Buffer partial SSE lines across chunks

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? '' // Keep incomplete last line in buffer

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6)
        if (data === '[DONE]') return

        try {
          const parsed = JSON.parse(data)
          if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
            yield parsed.delta.text
          }
        } catch {
          // Skip malformed SSE lines
        }
      }
    }

    // Process any remaining buffer
    if (buffer.startsWith('data: ')) {
      const data = buffer.slice(6)
      try {
        const parsed = JSON.parse(data)
        if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
          yield parsed.delta.text
        }
      } catch {
        // Skip
      }
    }
  } finally {
    clearTimeout(timeoutId)
  }
}
