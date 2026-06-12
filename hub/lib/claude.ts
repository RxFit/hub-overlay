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
const CLAUDE_MODEL = 'claude-sonnet-4-6'
const CLAUDE_TIMEOUT_MS = 45_000

function getAnthropicKey(): string {
  const key = process.env.ANTHROPIC_API_KEY || ''
  if (!key) {
    throw new Error(
      'No Anthropic API key found. Set ANTHROPIC_API_KEY in your environment.'
    )
  }
  return key
}

/**
 * Convert our ChatMessage[] format to Anthropic's messages array.
 * Anthropic requires alternating user/assistant roles.
 * System messages are extracted and passed as the top-level `system` param.
 */
function toAnthropicMessages(
  messages: ChatMessage[]
): { role: 'user' | 'assistant'; content: string }[] {
  return messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'user' ? ('user' as const) : ('assistant' as const),
      content: m.content,
    }))
}

/**
 * Streaming chat with Claude Fable 5.
 * Yields text chunks as they arrive via SSE.
 */
export async function* streamClaudeChat(
  messages: ChatMessage[],
  systemPrompt: string
): AsyncGenerator<string> {
  const anthropicMessages = toAnthropicMessages(messages)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), CLAUDE_TIMEOUT_MS)

  try {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': getAnthropicKey(),
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 8192,
        system: systemPrompt,
        messages: anthropicMessages,
        stream: true,
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error')
      throw new Error(
        `Anthropic API error ${response.status}: ${errorText.slice(0, 200)}`
      )
    }

    if (!response.body) {
      throw new Error('Anthropic API returned no response body')
    }

    // Parse SSE stream
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // Process complete SSE lines
      const lines = buffer.split('\n')
      buffer = lines.pop() || '' // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()

        if (data === '[DONE]') return

        try {
          const event = JSON.parse(data)

          // content_block_delta events carry the text
          if (
            event.type === 'content_block_delta' &&
            event.delta?.type === 'text_delta'
          ) {
            yield event.delta.text
          }

          // message_stop means we're done
          if (event.type === 'message_stop') {
            return
          }

          // Handle API errors in-stream
          if (event.type === 'error') {
            throw new Error(
              `Claude stream error: ${event.error?.message || 'Unknown'}`
            )
          }
        } catch (parseErr) {
          // Skip non-JSON SSE lines (e.g., event: type lines)
          if (parseErr instanceof SyntaxError) continue
          throw parseErr
        }
      }
    }
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Non-streaming Claude call for structured output (e.g., score-context).
 * Returns the full text response.
 */
export async function claudeChat(
  prompt: string,
  systemPrompt?: string,
  options?: { maxTokens?: number; temperature?: number }
): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), CLAUDE_TIMEOUT_MS)

  try {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': getAnthropicKey(),
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: options?.maxTokens ?? 512,
        temperature: options?.temperature ?? 0.1,
        ...(systemPrompt ? { system: systemPrompt } : {}),
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error')
      throw new Error(
        `Anthropic API error ${response.status}: ${errorText.slice(0, 200)}`
      )
    }

    const data = await response.json()

    // Extract text from content blocks
    const textBlocks = (data.content || []).filter(
      (block: { type: string }) => block.type === 'text'
    )
    return textBlocks.map((b: { text: string }) => b.text).join('')
  } finally {
    clearTimeout(timeout)
  }
}
