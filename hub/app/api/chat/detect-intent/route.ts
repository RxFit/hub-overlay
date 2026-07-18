import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { GoogleGenerativeAI, SchemaType, type Schema } from '@google/generative-ai'
import { withTimeout } from '@/lib/timeout'
import { stripSuggestedTools } from '@/lib/model-output'

/* Lazy-initialized so the API key is read at runtime, not module-load time.
   Prevents an empty-key client if Railway injects env vars after import. */
let _genAI: GoogleGenerativeAI | null = null
function getGenAI(): GoogleGenerativeAI {
  if (!_genAI) {
    const key =
      process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_API_KEY ||
      process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
      ''
    if (!key) {
      throw new Error('No Gemini API key found. Set GEMINI_API_KEY, GOOGLE_API_KEY, or GOOGLE_GENERATIVE_AI_API_KEY.')
    }
    _genAI = new GoogleGenerativeAI(key)
  }
  return _genAI
}

export const runtime = 'nodejs'

const intentSchema: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    intent: {
      type: SchemaType.STRING,
      description: 'The classified intent. If no intent matches perfectly, return an empty string.',
      nullable: true,
    },
    extractedEntities: {
      type: SchemaType.OBJECT,
      description: 'Any entities extracted from the message that match the intent\'s required context fields. Keys are the entity names, values are the extracted strings.',
      properties: {
        // Since we don't know the exact keys ahead of time, we just ask for an object.
        // The LLM will return a map of extracted keys.
      }
    }
  },
  required: ['extractedEntities']
}

type AvailableIntent = { id: string; description: string; expectedEntities: string[] }
type DetectedIntent = { intent: string | null; extractedEntities: Record<string, string> }

function buildClassifierInstruction(availableIntents: AvailableIntent[]): string {
  return `You are a strict intent classifier for an operations platform.
Classify the user's message into one of the available intents.
If the message does not match any intent, return an empty string for the intent.
Also extract any relevant details from the user's message that map to the "expectedEntities" for that intent.

Available Intents:
${availableIntents.map(i => `- ID: ${i.id}\n  Description: ${i.description}\n  Expected Entities: ${i.expectedEntities.join(', ')}`).join('\n\n')}
`
}

/**
 * Normalize a model's classification into the response contract: `intent` must
 * be one of the offered ids (anything else — '', hallucinated ids, non-strings
 * — becomes null) and `extractedEntities` keeps only string values. The client
 * re-validates, but normalizing here keeps both fallback paths honest.
 */
function normalizeDetection(parsed: unknown, availableIntents: AvailableIntent[]): DetectedIntent {
  const raw = (parsed ?? {}) as { intent?: unknown; extractedEntities?: unknown }
  const intent = typeof raw.intent === 'string' && availableIntents.some(i => i.id === raw.intent)
    ? raw.intent
    : null
  const entities: Record<string, string> = {}
  if (raw.extractedEntities && typeof raw.extractedEntities === 'object') {
    for (const [k, v] of Object.entries(raw.extractedEntities as Record<string, unknown>)) {
      if (typeof v === 'string') entities[k] = v
    }
  }
  return { intent, extractedEntities: entities }
}

/**
 * Claude fallback classifier (Fable 5 → Sonnet 4.6), mirroring score-context's
 * provider redundancy. Interview Mode — and therefore the ActionConfirmCard —
 * can ONLY start from this route, so a Gemini-only classifier made every
 * provider outage silently disable all actions: the chat model (already
 * running on its own Claude fallback) kept telling users to "approve via the
 * Confirm Card" while this route returned intent:null and no card could ever
 * render. Each attempt is timeout-bounded so the send path stays responsive.
 */
async function detectWithClaude(message: string, availableIntents: AvailableIntent[]): Promise<DetectedIntent | null> {
  const { claudeChat, isClaudeConfigured, CLAUDE_PRIMARY_MODEL, CLAUDE_BACKUP_MODEL } = await import('@/lib/claude')
  if (!isClaudeConfigured()) return null

  const system = `${buildClassifierInstruction(availableIntents)}
Respond with ONLY a valid JSON object on a single line, no markdown and no explanation:
{"intent":"<intent-id or empty string>","extractedEntities":{"<entity>":"<value>"}}`
  const classifierMessages = [{ id: '1', role: 'user' as const, content: message, timestamp: new Date().toISOString() }]

  for (const model of [CLAUDE_PRIMARY_MODEL, CLAUDE_BACKUP_MODEL]) {
    try {
      const rawText = await withTimeout(
        claudeChat(classifierMessages, system, { model, maxTokens: 256, temperature: 0 }),
        6_000,
        null,
        `detect-intent-claude-${model}`
      )
      if (!rawText) continue
      const clean = stripSuggestedTools(rawText).replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
      const match = clean.match(/\{[\s\S]*\}/)
      if (!match) continue
      return normalizeDetection(JSON.parse(match[0]), availableIntents)
    } catch (err) {
      console.warn(`[detect-intent] Claude ${model} classification failed:`, err)
    }
  }
  return null
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { message: string; availableIntents: AvailableIntent[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { message, availableIntents } = body

  if (!message || !availableIntents) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }

  // Primary: Gemini 3.5 Flash with a structured-output schema.
  try {
    const model = getGenAI().getGenerativeModel({
      model: 'gemini-3.5-flash',
      systemInstruction: buildClassifierInstruction(availableIntents),
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: intentSchema,
        temperature: 0,
      }
    })

    // HARDENED: 5s timeout prevents indefinite hang if Gemini is unresponsive
    const result = await withTimeout(
      model.generateContent(message),
      5_000,
      null,
      'detect-intent'
    )
    if (result) {
      const text = result.response.text()
      return NextResponse.json(normalizeDetection(JSON.parse(text), availableIntents))
    }
    console.warn('[detect-intent] Gemini timed out — trying Claude fallback')
  } catch (err) {
    console.error('Intent Detection Error (Gemini) — trying Claude fallback:', err)
  }

  // Fallback: Claude chain. Without this, a Gemini outage silently disables
  // Interview Mode (and every Confirm Card) while chat itself keeps working
  // on the Claude rotation — the worst kind of half-outage.
  try {
    const claudeResult = await detectWithClaude(message, availableIntents)
    if (claudeResult) {
      return NextResponse.json(claudeResult)
    }
  } catch (err) {
    console.error('Intent Detection Error (Claude fallback):', err)
  }

  return NextResponse.json({ intent: null, extractedEntities: {} })
}
