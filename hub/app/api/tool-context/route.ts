import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { withFault } from '@/lib/route-fault'

export const runtime = 'nodejs'

/** Generic fallback when Gemini is unavailable or returns bad data */
const FALLBACK_CONTEXT = {
  summary: '',
  suggestedPrompts: [
    'Summarize my options',
    'What are the key risks?',
    'Help me structure my thinking',
    'What should I prioritize?',
    'Draft a recommendation',
  ],
  keyEntities: [],
}

const SYSTEM_PROMPT = `You are a context summarizer. Given the recent chat messages and the tool being activated, generate:
1) A 2-3 sentence summary of what was being discussed
2) 3-5 suggested prompts that would help the user apply this tool to the current conversation context
3) Key entities mentioned (names, URLs, companies, metrics)

Return valid JSON only — no markdown fences, no explanation:
{"summary": "string", "suggestedPrompts": ["string"], "keyEntities": ["string"]}`

/**
 * POST /api/tool-context
 * Generates a context card with summary, suggested prompts, and key entities
 * when a tool is activated mid-conversation.
 *
 * Body: { toolId: string, recentMessages: Array<{role, content}> }
 */
export const POST = withFault('tool-context', async (req: NextRequest) => {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await req.json()
    const { toolId, recentMessages } = body

    if (!toolId || !Array.isArray(recentMessages)) {
      return NextResponse.json(
        { error: 'Missing required fields: toolId, recentMessages' },
        { status: 400 },
      )
    }

    /* Build a condensed transcript for the model */
    const transcript = recentMessages
      .slice(-10) // Only the last 10 messages — keep the prompt short for Flash speed
      .map((m: { role: string; content: string }) => `[${m.role}]: ${m.content}`)
      .join('\n')

    const userPrompt = `Tool being activated: ${toolId}\n\nRecent conversation:\n${transcript}`

    const apiKey =
      process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_API_KEY ||
      process.env.GOOGLE_GENERATIVE_AI_API_KEY
    if (!apiKey) {
      console.warn('[tool-context] No Gemini API key set (GEMINI_API_KEY / GOOGLE_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY) — returning fallback context')
      return NextResponse.json({ contextCard: FALLBACK_CONTEXT })
    }

    const genAI = new GoogleGenerativeAI(apiKey)
    const model = genAI.getGenerativeModel({ model: 'gemini-3.5-flash' })

    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      systemInstruction: { role: 'system', parts: [{ text: SYSTEM_PROMPT }] },
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 512,
        responseMimeType: 'application/json',
      },
    })

    const rawText = result.response.text()

    /* Parse the JSON response — strip markdown fences if the model wrapped them */
    const cleaned = rawText.replace(/```json\s*/g, '').replace(/```/g, '').trim()
    const parsed = JSON.parse(cleaned) as {
      summary?: string
      suggestedPrompts?: string[]
      keyEntities?: string[]
    }

    const contextCard = {
      summary: parsed.summary ?? '',
      suggestedPrompts: Array.isArray(parsed.suggestedPrompts) ? parsed.suggestedPrompts : FALLBACK_CONTEXT.suggestedPrompts,
      keyEntities: Array.isArray(parsed.keyEntities) ? parsed.keyEntities : [],
    }

    return NextResponse.json({ contextCard })
  } catch (err) {
    console.error('[tool-context POST]', err)
    /* Graceful degradation — return usable defaults so the UI never breaks */
    return NextResponse.json({ contextCard: FALLBACK_CONTEXT })
  }
})
