import type { ChatMessage } from '@/types'
import { CONNECT_TIMEOUT_MS } from './timeout-config'
import { emit } from './observability'

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

/* Claude Fable 5 / Mythos, Opus 4.7+, and Sonnet 5 REJECT sampling parameters
 * (`temperature`/`top_p`/`top_k` → 400 invalid_request_error). Sending
 * temperature unconditionally therefore 400s EVERY Fable 5 request, cooldowns
 * the model, and silently demotes the whole "Claude-first" chain to Sonnet 4.6
 * — the primary model never actually serves. Omit temperature on these models. */
const NO_SAMPLING_PARAM_MODELS = [
  /^claude-fable-/, /^claude-mythos-/, /^claude-opus-4-(?:[7-9]|\d{2,})/, /^claude-sonnet-(?:[5-9]|\d{2,})(?:$|-)/,
]

export function modelSupportsSamplingParams(model: string): boolean {
  return !NO_SAMPLING_PARAM_MODELS.some(re => re.test(model))
}

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

/**
 * Non-throwing configuration probe: is ANY Anthropic API key present in the
 * runtime env? Mirrors getApiKey()'s exact fallback list (canonical name plus
 * the Cloud Run casings). Reports key PRESENCE only — never values, lengths,
 * or prefixes — so it is safe to surface on the admin AI-health endpoint.
 * Also consulted by the emergency cross-provider fallback in lib/gemini.ts to
 * decide whether walking the Claude chain can possibly succeed.
 */
export function isClaudeConfigured(): boolean {
  return Boolean(
    process.env.ANTHROPIC_API_KEY ||
    process.env.Anthropic_API_Key ||
    process.env.anthropic_token
  )
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

  // Per-request ceiling — shared with the Gemini connect race via timeout-config
  // so both providers stay at/under the client abort (see lib/timeout-config.ts).
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS)

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
        ...(modelSupportsSamplingParams(model) ? { temperature } : {}),
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

/**
 * Split system prompt for Anthropic prompt caching (P0, deep-research finding).
 *
 * `staticPrefix` must be BYTE-IDENTICAL across requests (persona + policies —
 * no dates, no injected results): it is sent as its own content block with a
 * `cache_control` breakpoint, so repeat requests read it from cache at 0.1x
 * input price. `dynamic` (current date, injected search results, workspace
 * context) follows in a separate uncached block. Anthropic requires the cached
 * prefix to be ≥512 tokens on Fable 5 — shorter prefixes silently skip caching
 * (no error), which is safe. Cache breakpoints survive thinking/effort changes
 * (system+tools cache is invalidated only by content changes).
 */
export interface SystemPromptParts {
  staticPrefix: string
  dynamic: string
}

/** Join either form into the single string the Gemini path (and logs) expect. */
export function systemPromptText(sp: string | SystemPromptParts): string {
  return typeof sp === 'string' ? sp : sp.staticPrefix + sp.dynamic
}

export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** `xhigh` arrived with the Opus 4.7 generation — pre-4.7 models (Sonnet 4.6,
 *  the chain's backup) reject it with a 400. Clamp instead of failing over. */
export function clampEffortForModel(model: string, effort: ClaudeEffort): ClaudeEffort {
  if (effort === 'xhigh' && modelSupportsSamplingParams(model)) return 'high'
  return effort
}

export async function* streamClaudeChat(
  messages: ChatMessage[],
  systemPrompt: string | SystemPromptParts,
  options: { model?: string; maxTokens?: number; temperature?: number; effort?: ClaudeEffort } = {}
): AsyncGenerator<string> {
  // maxTokens 16384 (was 4096): thinking-first models (Fable 5) spend their
  // reasoning tokens INSIDE max_tokens — a hard prompt could burn the whole
  // 4096 budget thinking and finish with ZERO visible text (the "silent empty
  // answer" bug: clean stream, no error, empty chat bubble).
  const { model = CLAUDE_PRIMARY_MODEL, maxTokens = 16384, temperature = 0.7, effort } = options
  const apiKey = getApiKey()

  // CONNECT-ONLY ceiling (see lib/timeout-config.ts): this timer guards opening
  // the stream and is cleared as soon as headers arrive. It previously stayed
  // armed for the LIFE of the stream, which silently truncated any answer
  // whose total time exceeded 45s — fatal for a thinking model. Mid-stream
  // stalls are the idle watchdog's job (withIdleWatchdog in lib/gemini.ts).
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS)

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
        ...(modelSupportsSamplingParams(model) ? { temperature } : {}),
        // Thinking-first models (Fable 5 etc.) are silent for 30-60s before
        // their first visible token. Request summarized thinking so the API
        // streams thinking deltas during that window — the parser below turns
        // them into empty-string heartbeats that keep the idle watchdog fed.
        // (The thinking text itself is never yielded to the user.)
        ...(modelSupportsSamplingParams(model) ? {} : { thinking: { type: 'adaptive', display: 'summarized' } }),
        ...(effort ? { output_config: { effort: clampEffortForModel(model, effort) } } : {}),
        stream: true,
        // Split prompts get a cache breakpoint on the static block: cache reads
        // bill at 0.1x input, and the breakpoint must sit on the last block
        // whose prefix is byte-identical across requests — never after the
        // dynamic (date/results) content, which would guarantee cache misses.
        system: typeof systemPrompt === 'string' || !systemPrompt.staticPrefix
          ? systemPromptText(systemPrompt)
          : [
              { type: 'text', text: systemPrompt.staticPrefix, cache_control: { type: 'ephemeral' } },
              ...(systemPrompt.dynamic ? [{ type: 'text', text: systemPrompt.dynamic }] : []),
            ],
        messages: buildAnthropicMessages(messages),
      }),
    })

    if (!res.ok) {
      const body = await res.text()
      const err = classifyError(res.status, body)
      throw Object.assign(new Error(err.message), { claudeError: err })
    }

    if (!res.body) throw new Error('No response body from Claude')

    // The CONNECT ceiling is for OPENING the stream. Leaving this timer armed
    // aborted every response at 45s TOTAL — which killed thinking-first models
    // (Fable 5) mid-answer on long turns and rotated the chain to the faster
    // backup. Mid-stream stalls are the idle watchdog's job, not this timer's.
    clearTimeout(timeoutId)

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
          } else if (
            parsed.type === 'ping' ||
            parsed.type === 'content_block_start' ||
            (parsed.type === 'content_block_delta' && parsed.delta?.thinking !== undefined)
          ) {
            // Liveness heartbeat: thinking deltas / pings prove the model is
            // working. Yield '' so withIdleWatchdog resets WITHOUT emitting
            // visible output (the rotation layer skips empty chunks).
            yield ''
          } else if (parsed.type === 'message_delta' && parsed.delta?.stop_reason === 'max_tokens') {
            // TRUNCATION TELEMETRY (P0): stop_reason "max_tokens" is Anthropic's
            // documented signature of a response cut off by the token budget —
            // on thinking-first models it can also mean the budget went to
            // reasoning. Surface it as a metric so max_tokens/effort can be
            // tuned from real data instead of user bug reports.
            emit({ type: 'ai_truncated', provider: 'claude', model })
            console.warn(`[claude] response TRUNCATED (stop_reason=max_tokens) model=${model} max_tokens=${maxTokens}`)
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
    // Safety net for early exits before/at the connect phase.
    clearTimeout(timeoutId)
  }
}
