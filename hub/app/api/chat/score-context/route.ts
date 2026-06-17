import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { GoogleGenerativeAI } from '@google/generative-ai'
import type { ContextScoreResult, InterviewIntent } from '@/types'

export const runtime = 'nodejs'
export const maxDuration = 30

/* ══════════════════════════════════════════════════════════════════════════════
   CONTEXT SUFFICIENCY GATE
   POST /api/chat/score-context

   Evaluates whether an in-progress Interview Mode has collected enough context
   to safely generate an ActionConfirmCard. Uses Claude Fable 5 (primary) or
   Gemini 2.5 Pro (fallback) to score:

   Input:
   {
     intent: InterviewIntent,
     context: Record<string, string>,   // collected answers so far
     currentStep: number,               // how many questions answered
     totalSteps: number,
   }

   Output: ContextScoreResult
   {
     score: number,           // 0-100, 80+ = pass
     passed: boolean,
     weakDimension: string | null,
     followUpQuestion: string | null,
   }
   ══════════════════════════════════════════════════════════════════════════════ */

const genAI = new GoogleGenerativeAI(
  process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY || ''
)

/* ── Dimension definitions per intent ── */

const INTENT_DIMENSIONS: Record<string, string[]> = {
  create_task: ['outcome', 'timeline', 'constraints', 'success_criteria'],
  schedule_event: ['attendees', 'timing', 'purpose', 'duration'],
  send_communication: ['recipient', 'channel', 'message_content', 'tone'],
  create_paperclip_issue: ['task_clarity', 'agent_context', 'success_criteria'],
  check_agent_status: ['scope'],
  view_runs: ['scope', 'time_range'],
  assign_issue: ['issue_identity', 'agent_target'],
  update_issue_state: ['issue_identity', 'new_state'],
  create_agent: ['project', 'agent_name', 'instructions', 'success_criteria'],
  launch_campaign: ['goal', 'audience', 'timeline', 'success_criteria', 'constraints'],
  restart_agent: ['project', 'agent_identity'],
  run_audit: ['scope'],
  create_workspace: ['name', 'template'],
  delete_workspace: ['confirmation'],
  delete_agent: ['confirmation'],
}

function buildScoringPrompt(
  intent: string,
  context: Record<string, string>,
  dimensions: string[]
): string {
  const contextSummary = Object.entries(context)
    .filter(([k]) => k !== '_confirm')
    .map(([k, v]) => `  ${k}: ${v || '(empty)'}`)
    .join('\n')

  const dimensionList = dimensions.map(d => `- ${d.replace(/_/g, ' ')}`).join('\n')

  return `You are the Paperclip AI Context Sufficiency Evaluator. Your job is to score whether an Interview Mode session has collected enough context to safely execute a "${intent}" action.

## Collected Context
${contextSummary || '(no context collected yet)'}

## Required Quality Dimensions
${dimensionList}

## Scoring Rules
Evaluate each dimension:
- 25 points: outcome/goal is specific and measurable
- 25 points: timeline/deadline is clear or intentionally open
- 25 points: constraints or scope boundaries are defined
- 25 points: success criteria or acceptance conditions are described

For simpler intents (check_agent_status, view_runs, run_audit), any answer scores 80+.
For destructive intents (delete_workspace, delete_agent), require explicit confirmation text to score 80+.
For complex intents (launch_campaign, create_agent), require all 4 dimensions to score 80+.

## Response Format
Respond with ONLY a valid JSON object on a single line. No markdown, no code blocks, no explanation:
{"score":<0-100>,"passed":<true/false>,"weakDimension":<"dimension_name" or null>,"followUpQuestion":<"specific question" or null>}

Rules:
- score >= 80 → passed: true, weakDimension: null, followUpQuestion: null
- score < 80 → passed: false, weakDimension: the single most critical missing dimension, followUpQuestion: one specific, non-generic question to fill that gap
- followUpQuestion must reference the actual context already provided (show you've read it)
- Never ask for information already in the context
- Be concise — the question displays in a badge, not a message`
}

function parseScoreResponse(raw: string): ContextScoreResult {
  // Strip any markdown fencing or extra text
  const clean = raw
    .replace(/```json\n?/g, '')
    .replace(/```\n?/g, '')
    .replace(/<!--suggestedTools:\[.*?\]-->/g, '')
    .trim()

  // Find the JSON object
  const match = clean.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('No JSON found in response')

  const parsed = JSON.parse(match[0])

  return {
    score: typeof parsed.score === 'number' ? Math.min(100, Math.max(0, Math.round(parsed.score))) : 0,
    passed: Boolean(parsed.passed),
    weakDimension: parsed.weakDimension ?? null,
    followUpQuestion: parsed.followUpQuestion ?? null,
  }
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: {
    intent: InterviewIntent
    context: Record<string, string>
    currentStep?: number
    totalSteps?: number
  }

  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { intent, context } = body

  if (!intent || !context) {
    return NextResponse.json({ error: 'intent and context are required' }, { status: 400 })
  }

  // For read-only / simple intents with any answer → auto-pass
  const readOnlyIntents = ['check_agent_status', 'view_runs', 'run_audit']
  if (readOnlyIntents.includes(intent)) {
    const result: ContextScoreResult = {
      score: 90,
      passed: true,
      weakDimension: null,
      followUpQuestion: null,
    }
    return NextResponse.json(result)
  }

  const dimensions = INTENT_DIMENSIONS[intent] ?? ['outcome', 'timeline', 'constraints']

  // If no answers yet, return a baseline low score without calling Gemini
  const answerCount = Object.values(context).filter(v => v && v.trim() && v !== '').length
  if (answerCount === 0) {
    const result: ContextScoreResult = {
      score: 10,
      passed: false,
      weakDimension: dimensions[0] ?? 'outcome',
      followUpQuestion: null,
    }
    return NextResponse.json(result)
  }

  try {
    // Claude Fable 5 primary → Gemini 2.5 Pro fallback for scoring
    const prompt = buildScoringPrompt(intent, context, dimensions)

    // Try Claude first (better at structured JSON output): Fable 5 → Sonnet 4.6.
    try {
      const { claudeChat, CLAUDE_PRIMARY_MODEL, CLAUDE_BACKUP_MODEL } = await import('@/lib/claude')
      const scorerSystem = 'You are a context sufficiency scorer. Return ONLY valid JSON.'
      const scorerMessages = [{ id: '1', role: 'user' as const, content: prompt, timestamp: new Date().toISOString() }]
      let rawText: string
      try {
        rawText = await claudeChat(scorerMessages, scorerSystem, { model: CLAUDE_PRIMARY_MODEL, maxTokens: 256, temperature: 0.1 })
      } catch (primaryErr) {
        console.warn('[score-context] Claude Fable 5 failed, trying Sonnet 4.6:', primaryErr)
        rawText = await claudeChat(scorerMessages, scorerSystem, { model: CLAUDE_BACKUP_MODEL, maxTokens: 256, temperature: 0.1 })
      }
      const scoreResult = parseScoreResponse(rawText)
      return NextResponse.json(scoreResult)
    } catch (claudeErr) {
      console.warn('[score-context] Claude chain failed, falling back to Gemini 2.5 Pro:', claudeErr)

      // Fallback: Gemini 2.5 Pro
      const model = genAI.getGenerativeModel({
        model: 'gemini-2.5-pro',
        generationConfig: { temperature: 0.1, maxOutputTokens: 256 },
      })
      const result = await model.generateContent(prompt)
      const rawText = result.response.text()
      const scoreResult = parseScoreResponse(rawText)
      return NextResponse.json(scoreResult)
    }

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Scoring failed'
    console.error('[API] POST /api/chat/score-context error:', err)

    // For high-stakes or destructive intents, FAIL CLOSED — a scoring outage
    // must not let a consequential action through unvalidated.
    const failClosedIntents = [
      'send_communication', 'create_paperclip_issue', 'create_agent', 'launch_campaign',
      'assign_issue', 'update_issue_state', 'restart_agent',
      'create_workspace', 'delete_workspace', 'delete_agent',
    ]
    if (failClosedIntents.includes(intent)) {
      const blocked: ContextScoreResult = {
        score: 0,
        passed: false,
        weakDimension: 'validation',
        followUpQuestion:
          'I could not verify this action is safe to execute right now. Please re-state the key details so I can re-check before proceeding.',
      }
      return NextResponse.json(blocked, {
        headers: { 'X-Score-Fallback': 'fail-closed', 'X-Score-Error': message.slice(0, 100) },
      })
    }

    // Low-stakes / read-only intents — fail open so the UX isn't blocked.
    const fallback: ContextScoreResult = {
      score: 80,
      passed: true,
      weakDimension: null,
      followUpQuestion: null,
    }
    return NextResponse.json(fallback, {
      headers: { 'X-Score-Fallback': 'fail-open', 'X-Score-Error': message.slice(0, 100) },
    })
  }
}
