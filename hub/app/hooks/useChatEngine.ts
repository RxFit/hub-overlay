'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { mutate } from 'swr'
import {
  detectIntent,
  startInterview,
  advanceInterview,
  getCurrentQuestion,
  getCurrentQuestionWithDefaults,
  getTotalQuestions,
  hasPermission,
  getRequiredPermission,
  isHighStakesIntent,
} from '@/lib/interview'
import { INTERVIEW_SCAFFOLD_KIND, isInterviewScaffold, type ChatMsgKind } from '@/lib/interview-scaffold'
import { shouldRouteThroughSend } from '@/lib/inject-routing'
import { CLIENT_ABORT_MS } from '@/lib/timeout-config'
import { executeAction } from '@/lib/actions/executeAction'
import type { InterviewState, ActionSpec, ChatAttachment, ActiveSkill, Company } from '@/types'

/**
 * `kind` tags scaffold messages injected by Interview Mode (e.g. the
 * "Interview complete!" / "Briefing approved" prompts shown above the
 * ActionConfirmCard) so cleanup can filter by type instead of fragile
 * content string-matching.
 */
export type ChatMsg = { id: string; role: 'user' | 'assistant'; content: string; kind?: ChatMsgKind; timestamp?: string; attachments?: ChatAttachment[] }

export type MobileTab = 'chat' | 'command' | 'execution' | 'google_chat' | 'tool_panel'

/**
 * useChatEngine — the chat / interview / skill engine extracted from page.tsx.
 *
 * This is a behavior-preserving MOVE: the function bodies below are identical to
 * the ones that used to live in HubPage, including the P7/E1 "pure updater +
 * runAfter" pattern, the gateToken threading, the AbortController/timeout, and
 * the SSE parsing. Only the seam changed — page-owned dependencies are passed in
 * via `options`, and the engine's state + handlers are returned for the JSX
 * (panels, mobile nav, wizard) that stays in page.tsx.
 *
 * INPUTS (options): dependencies the engine needs from the page —
 *   - userRole / canUseInterviewMode: role gating for Interview Mode
 *   - haptic: haptic feedback utility
 *   - resolveActiveCompany: resolves the active workspace company for actions
 *   - setMobileLeftOpen / setMobileRightOpen / setMobileTab: page layout setters
 *     the inject handler closes/switches (kept in page so layout stays there)
 *   - textareaRef: the chat input textarea ref (handleSend resets its height)
 *
 * OUTPUTS (returned object): the engine state values the JSX renders +
 *   the setters/handlers page.tsx wires into events (send, inject, approve,
 *   skill activation, interview badge/confirm-card controls, quoted reply).
 */
export interface UseChatEngineOptions {
  userRole: string
  canUseInterviewMode: boolean
  haptic: (ms?: number) => void
  resolveActiveCompany: () => Company | null
  setMobileLeftOpen: (v: boolean) => void
  setMobileRightOpen: (v: boolean) => void
  setMobileTab: (v: MobileTab) => void
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
}

export function useChatEngine(options: UseChatEngineOptions) {
  const {
    userRole,
    canUseInterviewMode,
    haptic,
    resolveActiveCompany,
    setMobileLeftOpen,
    setMobileRightOpen,
    setMobileTab,
    textareaRef,
  } = options

  // Chat state (lifted so handleChatInject can share it)
  const [messages, setMessages] = useState<ChatMsg[]>([])
  // Always-current snapshot of `messages` so event handlers (e.g. panel injects)
  // can read the latest history synchronously, without depending on a setState
  // updater having already run (it has NOT, by the next line).
  const messagesRef = useRef<ChatMsg[]>([])
  useEffect(() => { messagesRef.current = messages }, [messages])
  const [input, setInput] = useState('')
  const [isTyping, setIsTyping] = useState(false)
  const [activeModel, setActiveModel] = useState<string | null>(null)
  const [actionExecuting, setActionExecuting] = useState(false)

  // Interview Mode state
  const [interviewState, setInterviewState] = useState<InterviewState | null>(null)
  const [actionSpec, setActionSpec] = useState<InterviewState['spec']>(null)

  // Context Sufficiency Score — live gate state
  const [contextScore, setContextScore] = useState<number | undefined>(undefined)
  const [contextWeakDim, setContextWeakDim] = useState<string | null>(null)
  const [isScoring, setIsScoring] = useState(false)

  // Context attachments state
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])

  // Quoted reply state
  const [quotedReply, setQuotedReply] = useState<{ id: string; content: string } | null>(null)

  // Skills state
  const [activeSkill, setActiveSkill] = useState<ActiveSkill | null>(null)
  const [suggestedTools, setSuggestedTools] = useState<string[]>([])

  const handleAddAttachment = useCallback((att: Omit<ChatAttachment, 'id'>) => {
    if (attachments.length >= 5) return  // Cap at 5
    setAttachments(prev => [...prev, { ...att, id: crypto.randomUUID() }])
  }, [attachments.length])

  const handleRemoveAttachment = useCallback((id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id))
  }, [])

  /* ── Send to Gemini API ── */
  const sendToApi = useCallback(async (userMessage: string, allMessages: ChatMsg[], useCase: string = 'deep_dive', msgAttachments?: ChatAttachment[]) => {
    setIsTyping(true)

    // HARDENED: AbortController with client-side timeout (CLIENT_ABORT_MS) — the
    // outermost user-facing bound in the timeout ladder (see lib/timeout-config.ts).
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), CLIENT_ABORT_MS)

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          // Per-message `attachments` are intentionally NOT sent: the chat route reads
          // only role/content from history plus the top-level `attachments` below.
          // Carry the message's real timestamp; fall back to now only if it's missing.
          messages: allMessages.map(m => ({
            id: m.id,
            role: m.role,
            content: m.content,
            timestamp: m.timestamp ?? new Date().toISOString(),
          })),
          useCase,
          attachments: msgAttachments && msgAttachments.length > 0 ? msgAttachments : undefined,
          activeSkill: activeSkill?.id || undefined,
        }),
      })

      if (!res.ok) {
        // Surface the server's structured error instead of discarding it.
        let serverDetail = ''
        try {
          const errBody = await res.json()
          // `details` may be a string (500 handler) or a structured object such
          // as Zod's `error.issues` (400 validation) — stringify the latter so the
          // diagnostic shows the real cause instead of "[object Object]".
          serverDetail = typeof errBody?.details === 'string'
            ? errBody.details
            : errBody?.details != null
              ? JSON.stringify(errBody.details)
              : (errBody?.error || '')
        } catch {
          // non-JSON body (e.g. an opaque framework 500) — leave serverDetail empty
        }
        const apiErr = new Error(serverDetail || `API ${res.status}`) as Error & { status?: number }
        apiErr.status = res.status
        throw apiErr
      }

      // Stream the response
      const reader = res.body?.getReader()
      if (!reader) throw new Error('No response body')

      const decoder = new TextDecoder()
      let fullText = ''

      // Add an empty assistant message that we'll stream into
      const assistantId = crypto.randomUUID()
      setMessages(prev => [...prev, { id: assistantId, role: 'assistant' as const, content: '' }])
      setIsTyping(false)

      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          if (trimmed.startsWith('data: ')) {
            const data = trimmed.slice(6)
            if (data === '[DONE]') break
            try {
              const parsed = JSON.parse(data)
              if (parsed.text) {
                fullText += parsed.text
                setMessages(prev =>
                  prev.map(m => m.id === assistantId ? { ...m, content: fullText } : m)
                )
              }
              if (parsed.error) {
                // Server sent an error event — APPEND it so any text already
                // streamed into this bubble (e.g. a model that failed mid-stream)
                // is preserved rather than discarded.
                setMessages(prev =>
                  prev.map(m => m.id === assistantId
                    ? { ...m, content: (m.content ? m.content + '\n\n' : '') + `⚠️ ${parsed.error}` }
                    : m)
                )
              }
              // Parse modelUsed event for dynamic badge
              if (parsed.modelUsed) {
                setActiveModel(parsed.modelUsed)
              }
              // Parse suggestedTools metadata from SSE
              if (parsed.suggestedTools && Array.isArray(parsed.suggestedTools)) {
                setSuggestedTools(parsed.suggestedTools)
              }
            } catch {
              // Skip malformed lines
            }
          }
        }
      }

      return // Success — no fallback needed
    } catch (err) {
      const isTimeout = err instanceof DOMException && err.name === 'AbortError'
      const status = (err as { status?: number } | undefined)?.status
      const detail = err instanceof Error ? err.message : ''
      console.error('Chat API Error:', { status, detail, err });
      setIsTyping(false);

      let content: string
      if (isTimeout) {
        content = "⏱️ That took longer than expected. Try asking again — things usually speed up quickly."
      } else if (status === 401) {
        content = "Your session expired. Please sign in again to continue."
      } else {
        // 5xx / network / unknown. The raw detail/status suffix is dev-only —
        // production users must never see internal error text in the bubble.
        const diag = process.env.NODE_ENV === 'development'
          ? (detail
              ? `\n\n\`${detail}\``
              : (status ? `\n\n\`HTTP ${status}\`` : '\n\n`no response (network/timeout)`'))
          : ''
        content = `Something went wrong on my end. Give it another try in a moment.${diag}`
      }

      setMessages(prev => [...prev, {
        id: crypto.randomUUID(),
        role: 'assistant' as const,
        content,
      }]);
    } finally {
      clearTimeout(timeoutId)
    }
  }, [activeSkill])

  const doSend = useCallback((message: string, msgAttachments?: ChatAttachment[]) => {
    haptic()
    // If there's a quoted reply, prepend it as context
    const quoteText = quotedReply?.content ?? ''
    const isTruncated = quoteText.length > 200
    const contextPrefix = quotedReply
      ? `> Replying to: ${quoteText.slice(0, 200)}${isTruncated ? '...' : ''}\n\n`
      : ''
    const fullMessage = contextPrefix + message
    if (quotedReply) setQuotedReply(null)

    const newMessage: ChatMsg = {
      id: crypto.randomUUID(),
      role: 'user' as const,
      content: fullMessage,
      timestamp: new Date().toISOString(),
      attachments: msgAttachments,
    }

    // ── P7 (E1): keep the setMessages updater PURE ──
    // React may invoke a state updater more than once (and does under StrictMode
    // in dev). All branch decisions and side effects (intent detection, interview
    // advance, scoring, sends) are computed/deferred here and fired AFTER the
    // commit so they run exactly once. `committed` captures the post-append list
    // for the sends that need it. `advanceInterview` / `startInterview` are pure.
    const immediate: ChatMsg[] = [newMessage]
    let runAfter: (() => void) | null = null
    let committed: ChatMsg[] = []

    if (canUseInterviewMode && !interviewState?.active) {
      // Branch A — possible interview start. Intent detection is async; defer it.
      runAfter = () => {
        detectIntent(message).then(({ intent, extractedEntities }) => {
          if (intent) {
            // Role gating: check if user has permission for this intent
            if (!hasPermission(userRole, intent)) {
              const required = getRequiredPermission(intent)
              const deniedMsg: ChatMsg = {
                id: crypto.randomUUID(),
                role: 'assistant' as const,
                content: `🔒 **Permission Denied**\n\nThis action requires **${required}** privileges. Your current role is **${userRole}**.\n\nPlease contact an administrator if you need elevated access.`,
                timestamp: new Date().toISOString(),
              }
              setMessages(prevMsgs => [...prevMsgs, deniedMsg])
              return
            }

            const newState = startInterview(intent, extractedEntities)
            setInterviewState(newState)
            setActiveModel('Claude Fable 5')

            // If the state is still active, it means we have unanswered questions.
            if (newState.active) {
              const question = getCurrentQuestion(newState)
              if (question) {
                const totalQ = getTotalQuestions(intent)
                const introMsg: ChatMsg = {
                  id: crypto.randomUUID(),
                  role: 'assistant' as const,
                  content: `✦ **Interview Mode Activated**\n\nI need to understand this fully before we proceed. I'll ask you ${totalQ} quick questions.\n\n**Question 1 of ${totalQ}:**\n${question.question}${question.defaultValue ? `\n\n_Default: ${question.defaultValue}_` : ''}`,
                  timestamp: new Date().toISOString(),
                }
                setMessages(prevMsgs => [...prevMsgs, introMsg])
              }
            } else if (newState.spec) {
               // Power user provided all info, skip directly to confirm.
               const followUpMsg: ChatMsg = {
                id: crypto.randomUUID(),
                role: 'assistant' as const,
                content: `Thanks. I've drafted the action specification below for your review.`,
                timestamp: new Date().toISOString(),
              }
              setMessages(prevMsgs => [...prevMsgs, followUpMsg])
            }
          } else {
            // No intent detected, just send to normal chat API
            sendToApi(fullMessage, committed, 'deep_dive', msgAttachments)
          }
        }).catch(() => {
          sendToApi(fullMessage, committed, 'deep_dive', msgAttachments)
        })
      }
    } else if (interviewState?.active && interviewState.intent) {
      // Branch B — advance the active interview. advanceInterview is pure, so it
      // is safe to compute here (outside the updater) to decide what to render.
      const nextState = advanceInterview(interviewState, message)
      const intentForScore = nextState.intent ?? interviewState.intent
      const contextForScore = nextState.context

      // ── Context Sufficiency Score Gate ──
      // Fire score check asynchronously after every answer so the badge
      // updates in real-time without blocking the UI.
      const fireScoreGate = () => {
        if (!intentForScore) return
        setIsScoring(true)
        fetch('/api/chat/score-context', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            intent: intentForScore,
            context: contextForScore,
            currentStep: nextState.step,
            totalSteps: getTotalQuestions(intentForScore),
          }),
        })
          .then(r => r.json())
          .then((result: { score?: number; weakDimension?: string | null }) => {
            if (typeof result.score === 'number') {
              setContextScore(result.score)
              setContextWeakDim(result.weakDimension ?? null)
            }
          })
          .catch(() => { /* fail silently — score stays at previous value */ })
          .finally(() => setIsScoring(false))
      }

        if (!nextState.active && nextState.spec) {
          // Interview answers collected — show confirm card immediately to prevent latency.
          // The background Context Sufficiency Score check may still be running (isScoring=true).
          // If it resolves <80%, the UI will handle it asynchronously.
          const runQualityGate = async (spec: typeof nextState.spec) => {
            if (!spec) return

            // Fetch a FRESH context-sufficiency score. Reading the async badge
            // state (contextScore) here is unreliable — this closure captured a
            // stale value, and the real follow-up question was never populated.
            // Default to 0, not 80 (P0-2): an unreachable/non-numeric gate must
            // never read as a pass. The server is the source of truth and only a
            // genuine pass returns a signed gateToken, which the write boundary
            // re-verifies — but defaulting closed here keeps the UX honest too.
            let finalScore = 0
            let finalWeak: string | null = null
            let followUpQuestion: string | null = null
            let gateToken: string | undefined
            try {
              const scoreRes = await fetch('/api/chat/score-context', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  intent: spec.intent,
                  context: nextState.context,
                  currentStep: nextState.step,
                  totalSteps: getTotalQuestions(spec.intent),
                }),
              })
              const scoreData = await scoreRes.json()
              if (typeof scoreData.score === 'number') finalScore = scoreData.score
              finalWeak = scoreData.weakDimension ?? null
              followUpQuestion = scoreData.followUpQuestion ?? null
              gateToken = typeof scoreData.gateToken === 'string' ? scoreData.gateToken : undefined
              setContextScore(finalScore)
              setContextWeakDim(finalWeak)
            } catch {
              // Network error reaching the gate — fail closed for high-stakes intents.
              if (isHighStakesIntent(spec.intent) || spec.intent === 'delete_workspace' || spec.intent === 'delete_agent') {
                finalScore = 0
                followUpQuestion = 'I could not verify this action is safe to execute. Please re-state the key details and try again.'
              }
            }

            if (finalScore < 80) {
              // ── BLOCKED — context insufficient ──
              // Re-activate interview for a follow-up question, don't show confirm card
              setInterviewState({
                ...nextState,
                active: true,
                spec: null,
              })
              setMessages(prev => [...prev, {
                id: crypto.randomUUID(),
                role: 'assistant' as const,
                content: `🧠 **Context Score: ${finalScore}% — Below the 80% threshold**

I need more detail before this can execute safely. The weakest area is **${(finalWeak ?? 'context').replace(/_/g, ' ')}**.

**${followUpQuestion ?? 'Can you add more specifics so I can validate this safely?'}**`,
                timestamp: new Date().toISOString(),
              }])
              return
            }

            // ── PASSED — proceed with existing quality gate logic ──
            if (isHighStakesIntent(spec.intent)) {
              // High-Stakes Pre-Cog Validation: AI verifies edge cases before generating Confirm Card
              const specSummary = Object.entries(spec.details)
                .map(([k, v]) => `${k}: ${v}`)
                .join('\n')

              const evalPrompt = `You are the Hub's Autonomous Strategic Validator (Pre-Cog).
The user wants to execute a high-stakes action: ${spec.summary}
Collected details:
${specSummary}

Evaluate this spec for critical edge cases based on the action type:
- If this is an external communication (email, etc.): Are we ensuring idempotency? What happens if the target is missing? Is the brand voice defined?
- If this is an automation / issue: Is the goal clear? Are success criteria defined? What happens if the trigger fails?
- If this is a CEO handoff (create agent / launch campaign): Is there enough context for the CEO to decide which agents to create?

Respond with EXACTLY one of:
1. "SUFFICIENT" if the brief has no glaring holes or edge cases and is ready to execute safely.
2. A single follow-up question if you identify an edge case, risk, or missing detail that the user MUST address before execution (e.g., "What should we do if the client doesn't have an email on file?"). Do not include any other text.`

              const thinkingId = crypto.randomUUID()
              setMessages(prev => [...prev, {
                id: thinkingId,
                role: 'assistant' as const,
                content: '🧠 Evaluating briefing quality for CEO handoff...',
                timestamp: new Date().toISOString(),
              }])

              fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  messages: [{ role: 'user', content: evalPrompt }],
                  useCase: 'execute',
                }),
              }).then(async (res) => {
                const reader = res.body?.getReader()
                if (!reader) return
                let fullText = ''
                const decoder = new TextDecoder()
                let buffer = ''
                while (true) {
                  const { done, value } = await reader.read()
                  if (done) break
                  buffer += decoder.decode(value, { stream: true })
                  const lines = buffer.split('\n')
                  buffer = lines.pop() ?? ''
                  for (const line of lines) {
                    const trimmed = line.trim()
                    if (!trimmed) continue
                    if (trimmed.startsWith('data: ')) {
                      const data = trimmed.slice(6)
                      if (data === '[DONE]') continue
                      try {
                        const p = JSON.parse(data)
                        if (p.text) fullText += p.text
                        if (p.modelUsed) {
                          setActiveModel(p.modelUsed)
                        }
                      } catch { /* skip */ }
                    }
                  }
                }
                if (buffer.trim().startsWith('data: ')) {
                  const data = buffer.trim().slice(6)
                  try {
                    const p = JSON.parse(data)
                    if (p.text) fullText += p.text
                    if (p.modelUsed) {
                      setActiveModel(p.modelUsed)
                    }
                  } catch { /* skip */ }
                }
                const cleanResponse = fullText.replace(/<!--suggestedTools:\[.*?\]-->/g, '').trim()
                if (cleanResponse.toUpperCase().includes('SUFFICIENT')) {
                  setActionSpec({ ...spec, gateToken })
                  setMessages(prev => {
                    const filtered = prev.filter(m => m.id !== thinkingId)
                    return [...filtered, {
                      id: crypto.randomUUID(), role: 'assistant' as const,
                      kind: INTERVIEW_SCAFFOLD_KIND,
                      content: '✅ Briefing approved by AI quality gate. Please review the action below and approve, edit, or cancel.',
                      timestamp: new Date().toISOString(),
                    }]
                  })
                } else {
                  setInterviewState({ ...nextState, active: true, spec: null })
                  setMessages(prev => {
                    const filtered = prev.filter(m => m.id !== thinkingId)
                    return [...filtered, {
                      id: crypto.randomUUID(), role: 'assistant' as const,
                      content: `🧠 **AI Quality Gate** — The briefing needs more detail before handing off to the CEO:\n\n**${cleanResponse}**`,
                      timestamp: new Date().toISOString(),
                    }]
                  })
                }
              }).catch(() => {
                setActionSpec({ ...spec, gateToken })
                setMessages(prev => {
                  const filtered = prev.filter(m => m.id !== thinkingId)
                  return [...filtered, {
                    id: crypto.randomUUID(), role: 'assistant' as const,
                    kind: INTERVIEW_SCAFFOLD_KIND,
                    content: '✅ Interview complete! Please review the action below and approve, edit, or cancel.',
                    timestamp: new Date().toISOString(),
                  }]
                })
              })
              return
            }

            // Non-CEO-routed: show confirm card directly
            setActionSpec({ ...spec, gateToken })
            setMessages(prev => [...prev, {
              id: crypto.randomUUID(),
              role: 'assistant' as const,
              kind: INTERVIEW_SCAFFOLD_KIND,
              content: '✅ Interview complete! Please review the action below and approve, edit, or cancel.',
              timestamp: new Date().toISOString(),
            }])
          }

          // Confirm path: append the thinking indicator now; run the gate after commit.
          const thinkingMsg: ChatMsg = {
            id: crypto.randomUUID(),
            role: 'assistant' as const,
            content: `🧠 **Scoring context quality…** (${isScoring ? 'evaluating' : 'finalizing'})`,
            timestamp: new Date().toISOString(),
          }
          immediate.push(thinkingMsg)
          // Capture the narrowed (non-null) spec for the deferred closure — TS
          // doesn't preserve property narrowing across a function boundary.
          const confirmedSpec = nextState.spec
          runAfter = () => {
            setInterviewState(nextState)
            setActiveModel('Claude Fable 5')
            fireScoreGate()
            // Run the async gate — it updates state on its own.
            runQualityGate(confirmedSpec)
          }
        } else {
          const question = getCurrentQuestionWithDefaults(nextState)
          if (question) {
            // Show the next question; score badge updates from the async score fetch.
            const qMsg: ChatMsg = {
              id: crypto.randomUUID(),
              role: 'assistant' as const,
              content: `✦ **${question.question}**${question.defaultValue ? `\n\n_${nextState._editDefaults ? 'Previous answer' : 'Default'}: ${question.defaultValue}_` : ''}`,
              timestamp: new Date().toISOString(),
            }
            immediate.push(qMsg)
          }
          runAfter = () => {
            setInterviewState(nextState)
            setActiveModel('Claude Fable 5')
            fireScoreGate()
          }
        }
    } else {
      // Branch C — no active interview; normal chat send.
      runAfter = () => {
        // Reset context score when not in interview mode
        setContextScore(undefined)
        setContextWeakDim(null)
        sendToApi(fullMessage, committed, 'deep_dive', msgAttachments)
      }
    }

    // Pure updater: append the precomputed message(s) and capture the result so
    // deferred sends can reference the post-append list.
    setMessages(prev => {
      committed = [...prev, ...immediate]
      return committed
    })

    // Side effects run exactly once, AFTER the commit (P7/E1).
    runAfter?.()
  }, [interviewState, sendToApi, canUseInterviewMode, quotedReply, userRole])

  /* ── Handle manual send from input ── */
  const handleSend = useCallback(() => {
    const msg = input.trim()
    if (!msg) return
    const currentAttachments = [...attachments]
    setInput('')
    setAttachments([])
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    doSend(msg, currentAttachments)
  }, [input, doSend, attachments])

  /* ── Handle suggestion chip click ── */
  const handleSuggestion = useCallback((suggestion: string) => {
    doSend(suggestion)
  }, [doSend])

  /* ── Handle context injection from panels ──
   * Two routing modes:
   *  - 'execute'  → action-style inject: delegate to doSend so detectIntent,
   *                 role-gating, and Interview Mode run exactly as if the user
   *                 had typed the sentence (parity with handleSend).
   *  - other      → read-style inject ('recall' / 'deep_dive'): keep the direct
   *                 sendToApi path (no intent detection on informational lookups).
   */
  const handleChatInject = useCallback((message: string, useCase: string, injectAttachments?: ChatAttachment[]) => {
    setMobileLeftOpen(false)
    setMobileRightOpen(false)
    setMobileTab('chat')

    // Defense-in-depth: mirror the 5-attachment cap enforced in handleAddAttachment
    // and server-side (route.ts). The inject path previously forwarded these uncapped.
    const cappedAttachments = injectAttachments && injectAttachments.length > 0
      ? injectAttachments.slice(0, 5)
      : undefined

    // Action-style injects go through the shared send core for full parity.
    if (shouldRouteThroughSend(useCase)) {
      doSend(message, cappedAttachments)
      return
    }

    // Read-style injects: direct, intent-free send (unchanged behavior).
    const userMsg: ChatMsg = {
      id: crypto.randomUUID(),
      role: 'user' as const,
      content: message,
      timestamp: new Date().toISOString(),
      // Carry any panel-attached context (e.g. a tapped Drive document's fileId)
      // so the chat route resolves its real content, and the chip renders.
      attachments: cappedAttachments,
    }
    // Capture the updated messages array via functional updater, but fire the
    // API call OUTSIDE the updater to prevent double-firing under React
    // concurrent mode / Strict Mode (P7 fix from /review).
    // Build the outgoing history from the always-current ref — NOT from the
    // setMessages updater below. React does not run that updater synchronously,
    // so the previous code read an EMPTY `updatedMessages` here and sent `[]`,
    // which the chat route rejected with 400 "messages array required" (the
    // Zod `.min(1)` failure). That's why panel/document taps failed while typed
    // messages — which defer their read to after commit — worked.
    const updatedMessages: ChatMsg[] = [...messagesRef.current, userMsg]
    setMessages(prev => [...prev, userMsg])
    sendToApi(message, updatedMessages, useCase, cappedAttachments)
  }, [sendToApi, doSend, setMobileLeftOpen, setMobileRightOpen, setMobileTab])

  // Stable per-panel inject handlers — referentially constant across renders so
  // memoized panel children (e.g. FeedCard) don't re-render on unrelated state
  // changes like chat-input typing.
  const injectRecall = useCallback((msg: string, atts?: ChatAttachment[]) => handleChatInject(msg, 'recall', atts), [handleChatInject])
  const injectExecute = useCallback((msg: string) => handleChatInject(msg, 'execute'), [handleChatInject])
  const injectDeepDive = useCallback((msg: string) => handleChatInject(msg, 'deep_dive'), [handleChatInject])

  /* ── Execute approved action from Interview Mode ── */
  const handleActionApprove = useCallback(async (spec: ActionSpec) => {
    haptic(15) // Stronger haptic for consequential action
    setActionExecuting(true)
    setActionSpec(null)
    setInterviewState(null)
    setMessages(prev => prev.filter(m => !isInterviewScaffold(m)))

    // Add a "working on it" message
    const workingId = crypto.randomUUID()
    setMessages(prev => [...prev, {
      id: workingId,
      role: 'assistant' as const,
      content: '⏳ Executing action...',
      timestamp: new Date().toISOString(),
    }])

    try {
      const activeCompany = resolveActiveCompany()
      const activeCompanyObj = activeCompany ? {
        id: activeCompany.id,
        name: activeCompany.name,
        identifier: activeCompany.identifier,
      } : null

      const resultMsg = await executeAction(spec, {
        activeCompany: activeCompanyObj,
        mutate,
      })

      // Replace the "working" message with the result
      setMessages(prev => prev.map(m =>
        m.id === workingId ? { ...m, content: resultMsg } : m
      ))
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error'
      setMessages(prev => prev.map(m =>
        m.id === workingId
          ? { ...m, content: `❌ **Action failed:** ${errMsg}\n\nPlease try again or contact support.` }
          : m
      ))
    } finally {
      setActionExecuting(false)
    }
  }, [resolveActiveCompany, mutate])

  return {
    // ── State values (read in JSX) ──
    messages,
    input,
    isTyping,
    activeModel,
    actionExecuting,
    interviewState,
    actionSpec,
    contextScore,
    contextWeakDim,
    isScoring,
    attachments,
    quotedReply,
    activeSkill,
    suggestedTools,
    // ── Setters page JSX wires into events ──
    setInput,
    setMessages,
    setInterviewState,
    setActionSpec,
    setContextScore,
    setContextWeakDim,
    setQuotedReply,
    setActiveSkill,
    // ── Handlers ──
    handleAddAttachment,
    handleRemoveAttachment,
    sendToApi,
    doSend,
    handleSend,
    handleSuggestion,
    handleChatInject,
    injectRecall,
    injectExecute,
    injectDeepDive,
    handleActionApprove,
  }
}
