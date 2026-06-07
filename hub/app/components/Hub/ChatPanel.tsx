'use client'

import { useState, Fragment } from 'react'
import { InterviewBadge, ContextInjectionBanner, ActionConfirmCard, SkillBadge } from '@/app/components/ChatEnhancements'
import { ContextAttachMenu, AttachmentChips } from '@/app/components/ContextAttachMenu'
import { SkillsPopover } from '@/app/components/SkillsPopover'
import { EmailPreviewCard } from '@/app/components/EmailPreviewCard'
import { SKILL_CATALOG, SKILL_MAP } from '@/lib/skills'
import {
  getTotalQuestions,
  restartInterview,
  getCurrentQuestionWithDefaults,
} from '@/lib/interview'
import type { InterviewState, ActionSpec, ChatAttachment, ActiveSkill } from '@/types'

/* ── Constants ── */

const ONBOARDING_SUGGESTIONS = [
  "What meetings do I have today?",
  "Show my open tasks",
  "What files did I work on recently?",
  "What is this Hub for?",
]

/* ── Chat message type (matches page.tsx) ── */

type ChatMsg = {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp?: string
  attachments?: ChatAttachment[]
}

/* ══════════════════════════════════════════════════════════════════════════════
   HELPER COMPONENTS  (moved from page.tsx)
   ══════════════════════════════════════════════════════════════════════════════ */

/* ── Safe Markdown-like renderer (no dangerouslySetInnerHTML) ── */
function parseInlineMarkdown(text: string, onToolActivate?: (toolId: string) => void): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  // Match bold (**...**), italic (*...*), and tool references ([[...]])
  const regex = /\*\*(.*?)\*\*|\*(.*?)\*|\[\[([\w-]+)\]\]/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    // Push text before this match
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index))
    }
    if (match[1] !== undefined) {
      // Bold
      nodes.push(<strong key={`b-${match.index}`}>{match[1]}</strong>)
    } else if (match[2] !== undefined) {
      // Italic
      nodes.push(<em key={`i-${match.index}`}>{match[2]}</em>)
    } else if (match[3] !== undefined) {
      // Tool reference — render as clickable gold link
      const toolId = match[3]
      nodes.push(
        <button
          key={`tool-${match.index}`}
          className="inline-tool-link"
          onClick={() => onToolActivate?.(toolId)}
          title={SKILL_MAP[toolId]?.description || toolId}
        >
          {toolId}
        </button>
      )
    }
    lastIndex = match.index + match[0].length
  }
  // Push remaining text
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex))
  }
  if (nodes.length === 0) {
    nodes.push(text)
  }
  return nodes
}

function MessageContent({ content, onToolActivate }: { content: string; onToolActivate?: (toolId: string) => void }) {
  // Strip suggestedTools metadata from visible content
  const cleanContent = content.replace(/<!--suggestedTools:\[.*?\]-->/g, '').trimEnd()
  
  // Custom parser to split by HTML code blocks and generic code blocks
  const parts: { type: 'text' | 'html' | 'code', content: string, lang?: string }[] = []
  const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g
  let lastIndex = 0
  let match

  while ((match = codeBlockRegex.exec(cleanContent)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', content: cleanContent.slice(lastIndex, match.index) })
    }
    const lang = match[1] || ''
    if (lang === 'html') {
      parts.push({ type: 'html', content: match[2] })
    } else {
      parts.push({ type: 'code', content: match[2], lang })
    }
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < cleanContent.length) {
    parts.push({ type: 'text', content: cleanContent.slice(lastIndex) })
  }

  return (
    <div style={{ whiteSpace: 'pre-wrap' }}>
      {parts.map((part, pIndex) => {
        if (part.type === 'html') {
          return <EmailPreviewCard key={pIndex} htmlContent={part.content} />
        }
        if (part.type === 'code') {
          return (
            <div key={pIndex} style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 'clamp(0.78rem, 0.74rem + 0.2vw, 0.85rem)',
              background: 'rgba(0,0,0,0.25)',
              border: '1px solid rgba(255,255,255,0.06)',
              borderRadius: 'var(--radius-md)',
              padding: 'var(--space-3)',
              margin: 'var(--space-2) 0',
              overflowX: 'auto',
              lineHeight: 1.55,
            }}>
              {part.content}
            </div>
          )
        }
        
        const lines = part.content.split('\n')
        return (
          <Fragment key={pIndex}>
            {lines.map((line, i) => {
              // Heading lines (## Header or ### Header)
              if (/^#{1,3} /.test(line)) {
                const level = line.match(/^(#+)/)?.[1].length || 2
                const text = line.replace(/^#+\s*/, '')
                return (
                  <div key={`${pIndex}-${i}`} style={{
                    fontFamily: 'var(--font-heading)',
                    fontWeight: 600,
                    fontSize: level === 1 ? '1.05em' : level === 2 ? '0.95em' : '0.9em',
                    marginTop: '0.75em',
                    marginBottom: '0.25em',
                    color: 'var(--text-primary)',
                    letterSpacing: '-0.01em',
                  }}>
                    {parseInlineMarkdown(text, onToolActivate)}
                  </div>
                )
              }
              // Numbered list items (1. or 1) style)
              if (/^\d+[.)\s]/.test(line.trim())) {
                return (
                  <div key={`${pIndex}-${i}`} style={{ paddingLeft: '16px', position: 'relative' }}>
                    {parseInlineMarkdown(line, onToolActivate)}
                  </div>
                )
              }
              // Bullet points — proper indentation
              if (line.startsWith('• ') || line.startsWith('- ')) {
                return <div key={`${pIndex}-${i}`} style={{ paddingLeft: '16px', position: 'relative' }}>{parseInlineMarkdown(line, onToolActivate)}</div>
              }
              // Blockquote lines (> text)
              if (line.startsWith('> ')) {
                return (
                  <div key={`${pIndex}-${i}`} style={{
                    paddingLeft: '12px',
                    borderLeft: '3px solid var(--accent-dim)',
                    color: 'var(--text-secondary)',
                    fontStyle: 'italic',
                    margin: '4px 0',
                  }}>
                    {parseInlineMarkdown(line.slice(2), onToolActivate)}
                  </div>
                )
              }
              // Table header detection
              if (line.includes('|') && line.trim().startsWith('|')) {
                const cells = line.split('|').filter(c => c.trim())
                if (cells.every(c => /^[\s-]+$/.test(c))) return <Fragment key={`${pIndex}-${i}`} />  // separator line
                return (
                  <div key={`${pIndex}-${i}`} style={{
                    display: 'flex',
                    gap: '8px',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 'clamp(0.75rem, 0.7rem + 0.25vw, 0.85rem)',
                    padding: '2px 0',
                    color: line.includes('---') ? 'transparent' : undefined,
                  }}>
                    {cells.map((cell, j) => (
                      <span key={j} style={{ flex: 1, minWidth: 0 }}>{parseInlineMarkdown(cell.trim(), onToolActivate)}</span>
                    ))}
                  </div>
                )
              }
              // Empty line → visible paragraph break
              if (!line.trim()) {
                return <div key={`${pIndex}-${i}`} style={{ height: '0.5em' }} aria-hidden="true" />
              }
              return <div key={`${pIndex}-${i}`}>{parseInlineMarkdown(line, onToolActivate)}</div>
            })}
          </Fragment>
        )
      })}
    </div>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  
  const handleCopy = () => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <button 
      onClick={handleCopy} 
      className="chat-copy-btn" 
      aria-label="Copy message"
      title="Copy message"
    >
      {copied ? (
        <span className="rx-icon rx-icon--sm">
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </span>
      ) : (
        <span className="rx-icon rx-icon--sm">
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        </span>
      )}
      <span style={{ fontSize: '10px', marginLeft: '4px' }}>{copied ? 'Copied!' : 'Copy'}</span>
    </button>
  )
}

/* ══════════════════════════════════════════════════════════════════════════════
   CHAT PANEL COMPONENT
   ══════════════════════════════════════════════════════════════════════════════ */

export interface ChatPanelProps {
  /* ── Message / conversation state ── */
  messages: ChatMsg[]
  input: string
  isTyping: boolean
  showScrollBtn: boolean

  /* ── Interview mode state ── */
  interviewState: InterviewState | null
  injectedContext: string | null
  actionSpec: ActionSpec | null
  actionExecuting: boolean

  /* ── Context sufficiency gate ── */
  contextScore: number | undefined
  contextWeakDim: string | null
  isScoring: boolean

  /* ── Attachments & quoted reply ── */
  attachments: ChatAttachment[]
  quotedReply: { id: string; content: string } | null

  /* ── Skills ── */
  activeSkill: ActiveSkill | null
  suggestedTools: string[]
  skillsPopoverOpen: boolean

  /* ── Suggestions / onboarding ── */
  chatSuggestions: string[]
  isOnboarding: boolean
  userInitials: string
  session: { user?: { name?: string | null } } | null

  /* ── Refs ── */
  chatMessagesRef: React.Ref<HTMLDivElement>
  messagesEndRef: React.Ref<HTMLDivElement>
  textareaRef: React.Ref<HTMLTextAreaElement>

  /* ── Handlers ── */
  handleSend: () => void
  handleSuggestion: (s: string) => void
  handleSkillActivate: (toolId: string) => void
  handleSkillDeactivate: () => void
  handleSaveToolArtifacts: (data: unknown) => void
  handleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  handleTextareaInput: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
  handleAddAttachment: (att: Omit<ChatAttachment, 'id'>) => void
  handleRemoveAttachment: (id: string) => void
  handleActionApprove: (spec: ActionSpec) => void
  scrollToBottom: () => void
  haptic: (ms?: number) => void

  /* ── Setters ── */
  setInput: (v: string) => void
  setSkillsPopoverOpen: (v: boolean) => void
  setInterviewState: (v: InterviewState | null) => void
  setContextScore: (v: number | undefined) => void
  setContextWeakDim: (v: string | null) => void
  setQuotedReply: (v: { id: string; content: string } | null) => void
  setActionSpec: (v: ActionSpec | null) => void
  setMessages: React.Dispatch<React.SetStateAction<ChatMsg[]>>
  setInjectedContext: (v: string | null) => void
}

export function ChatPanel({
  messages,
  input,
  isTyping,
  showScrollBtn,
  interviewState,
  injectedContext,
  actionSpec,
  // actionExecuting is accepted but not directly used in the JSX — kept for future use
  contextScore,
  contextWeakDim,
  isScoring,
  attachments,
  quotedReply,
  activeSkill,
  suggestedTools,
  skillsPopoverOpen,
  chatSuggestions,
  isOnboarding,
  userInitials,
  session,
  chatMessagesRef,
  messagesEndRef,
  textareaRef,
  handleSend,
  handleSuggestion,
  handleSkillActivate,
  handleSkillDeactivate,
  handleKeyDown,
  handleTextareaInput,
  handleAddAttachment,
  handleRemoveAttachment,
  handleActionApprove,
  scrollToBottom,
  haptic,
  setInput: _setInput,
  setSkillsPopoverOpen,
  setInterviewState,
  setContextScore,
  setContextWeakDim,
  setQuotedReply,
  setActionSpec,
  setMessages,
  setInjectedContext,
}: ChatPanelProps) {
  return (
    <main className="panel-center" aria-label="AI Chat">
      <div className="chat-container">
        {/* Chat Header */}
        <div className="chat-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span className="panel-title-dot" aria-hidden="true" />
            <h2 className="chat-header-title">
              <span style={{ color: 'var(--text-muted)', animation: 'sparkle-breathe 3s ease-in-out infinite' }}>
                ✦
              </span>
              {' '}AI Assistant
            </h2>
            <span className="chat-header-model-badge">
              Gemini 2.5
            </span>
          </div>
        </div>

        {/* Skills popover */}
        {skillsPopoverOpen && (
          <SkillsPopover
            isOpen={skillsPopoverOpen}
            onClose={() => setSkillsPopoverOpen(false)}
            onActivate={handleSkillActivate}
            suggestedTools={suggestedTools}
            activeSkillId={activeSkill?.id ?? null}
            skillCatalog={SKILL_CATALOG.map(s => ({
              id: s.id,
              name: s.name,
              description: s.description,
              plugin: s.plugin,
            }))}
          />
        )}

        {/* Skill badge */}
        {activeSkill && (
          <SkillBadge
            skill={activeSkill}
            onDismiss={handleSkillDeactivate}
          />
        )}

        {/* Interview badge — live context score */}
        {interviewState?.active && (
          <InterviewBadge
            state={interviewState}
            totalQuestions={interviewState.intent ? getTotalQuestions(interviewState.intent) : 0}
            onCancel={() => {
              setInterviewState(null)
              setContextScore(undefined)
              setContextWeakDim(null)
            }}
            contextScore={isScoring ? undefined : contextScore}
            weakDimension={contextWeakDim ?? undefined}
          />
        )}

        {/* Context injection banner */}
        {injectedContext && (
          <ContextInjectionBanner
            source={injectedContext}
            onDismiss={() => setInjectedContext(null)}
          />
        )}

        {/* Messages */}
        <div ref={chatMessagesRef} className="chat-messages" role="log" aria-label="Chat messages" aria-live="polite">
          {messages.length === 0 && (
            <div className="chat-welcome chat-welcome--animate" style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center',
              justifyContent: 'center', flex: 1, gap: '12px', padding: '48px 24px',
              textAlign: 'center',
            }}>
              <div className="chat-message-avatar chat-message-avatar-ai"
                style={{ width: 52, height: 52, fontSize: '1.3rem' }}>✦</div>
              <h3 style={{
                fontFamily: 'var(--font-display)', fontSize: '1.15rem',
                fontWeight: 800, color: 'var(--text-primary)', margin: 0,
                letterSpacing: '-0.02em',
              }}>
                {session?.user?.name ? `Hey ${session.user.name.split(' ')[0]} 👋` : 'Hey there 👋'}
              </h3>
              <p style={{
                fontFamily: 'var(--font-chat)', fontSize: 'var(--text-sm)',
                color: 'var(--text-muted)',
                maxWidth: '300px', lineHeight: 1.6, margin: 0,
              }}>
                I'm your business co-pilot. Ask me anything about your workspace.
              </p>
            </div>
          )}
          {messages.map(msg => (
            <div key={msg.id} className={`chat-message ${msg.role === 'user' ? 'chat-message-user' : ''}`}>
              {msg.role === 'assistant' ? (
                <button
                  className="chat-message-avatar chat-message-avatar-ai clickable"
                  onClick={() => setSkillsPopoverOpen(true)}
                  aria-label="Open skills menu"
                  title="Open AI Skills"
                >
                  ✦
                </button>
              ) : (
                <div
                  className="chat-message-avatar chat-message-avatar-user"
                  aria-hidden="true"
                >
                  {userInitials}
                </div>
              )}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '78%' }}>
                <div className={`chat-bubble ${msg.role === 'user' ? 'chat-bubble-user' : 'chat-bubble-ai'}`} style={{ maxWidth: '100%' }}>
                  <MessageContent content={msg.content} onToolActivate={handleSkillActivate} />
                </div>
                {/* Show attachment chips on sent user messages */}
                {msg.role === 'user' && msg.attachments && msg.attachments.length > 0 && (
                  <AttachmentChips
                    attachments={msg.attachments}
                    onRemove={() => {}}
                    readOnly
                  />
                )}
                {msg.role === 'assistant' && msg.content && (
                  <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                    <CopyButton text={msg.content} />
                    <button
                      className="chat-reply-btn"
                      onClick={() => setQuotedReply({ id: msg.id, content: msg.content.slice(0, 200) })}
                      aria-label="Reply to this message"
                    >
                      ↩️ Reply
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}

          {/* Action confirm card */}
          {actionSpec && (
            <ActionConfirmCard
              spec={actionSpec}
              onApprove={() => handleActionApprove(actionSpec)}
              onEdit={() => {
                // Re-enter interview with previous answers as defaults
                if (actionSpec.intent) {
                  const editState = restartInterview(actionSpec.intent, actionSpec.details)
                  setInterviewState(editState)
                  setActionSpec(null)
                  // Remove the "interview complete" message
                  setMessages(prev => prev.filter(m => !m.content.includes('Interview complete!') && !m.content.includes('Briefing approved')))
                  // Show the first question with the previous answer as default
                  const question = getCurrentQuestionWithDefaults(editState)
                  if (question) {
                    const totalQ = getTotalQuestions(actionSpec.intent)
                    const editMsg: ChatMsg = {
                      id: crypto.randomUUID(),
                      role: 'assistant' as const,
                      content: `✏️ **Editing — ${actionSpec.intent.replace(/_/g, ' ')}**\n\n**Question 1 of ${totalQ}:**\n${question.question}${question.defaultValue ? `\n\n_Previous answer: ${question.defaultValue}_` : ''}`,
                      timestamp: new Date().toISOString(),
                    }
                    setMessages(prev => [...prev, editMsg])
                  }
                }
              }}
              onCancel={() => {
                setActionSpec(null)
                setInterviewState(null)
                setMessages(prev => prev.filter(m => !m.content.includes('Interview complete!')))
              }}
            />
          )}

          {isTyping && (
            <div className="chat-message" aria-label="AI is typing">
              <div className="chat-message-avatar chat-message-avatar-ai" aria-hidden="true">✦</div>
              <div className="chat-bubble chat-bubble-ai">
                <div className="chat-thinking" aria-label="Thinking">
                  <div className="chat-thinking-dot" />
                  <div className="chat-thinking-dot" />
                  <div className="chat-thinking-dot" />
                </div>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />

          {/* E2: Scroll-to-bottom floating pill */}
          {showScrollBtn && (
            <button
              className="chat-scroll-bottom-pill"
              onClick={() => { scrollToBottom(); haptic() }}
              aria-label="Scroll to latest messages"
            >
              ↓ New messages
            </button>
          )}
        </div>

        {/* Suggestion chips (shown when chat is fresh) */}
        {messages.length <= 1 && (
          <div className="chat-suggestions" role="group" aria-label="Suggested prompts">
            {(isOnboarding ? ONBOARDING_SUGGESTIONS : chatSuggestions).map(s => (
              <button
                key={s}
                className="chat-suggestion-chip"
                onClick={() => handleSuggestion(s)}
                aria-label={`Ask: ${s}`}
              >
                {s} <span className="rx-arrow">→</span>
              </button>
            ))}
          </div>
        )}

        {/* Input */}
        <div className="chat-input-area">
          {/* Attachment chips (shown above textarea when items are attached) */}
          {quotedReply && (
            <div className="quoted-reply-chip">
              <div style={{ flex: 1, overflow: 'hidden' }}>{quotedReply.content}</div>
              <button
                className="quoted-reply-chip__dismiss"
                onClick={() => setQuotedReply(null)}
                aria-label="Remove quoted reply"
              >
                ✕
              </button>
            </div>
          )}
          {attachments.length > 0 && (
            <AttachmentChips
              attachments={attachments}
              onRemove={handleRemoveAttachment}
            />
          )}
          <div className="chat-input-wrapper">
            <ContextAttachMenu
              onAttach={handleAddAttachment}
              disabled={isTyping}
            />
            <textarea
              ref={textareaRef}
              className="chat-input"
              aria-label="Chat message input"
              placeholder={interviewState?.active ? "Answer the interview question..." : "Ask about your projects, create tasks, check status..."}
              value={input}
              onChange={handleTextareaInput}
              onKeyDown={handleKeyDown}
              rows={1}
            />
            <button
              className="chat-send-btn"
              onClick={handleSend}
              disabled={(!input.trim() && attachments.length === 0) || isTyping}
              aria-label="Send message"
            >
              ↑
            </button>
          </div>
        </div>
      </div>
    </main>
  )
}
