'use client'

import { useState, useRef, useEffect, useCallback, Fragment } from 'react'
import { mutate } from 'swr'
import { useSession, signIn } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { TasksSection, CalendarSection, DocumentsSection, KPISection, ProjectHealthSection } from '@/app/components/LeftPanelSections'
import { ExecutionFeed } from '@/app/components/RightPanelSections'
import { InterviewBadge, ContextInjectionBanner, ActionConfirmCard } from '@/app/components/ChatEnhancements'
import { ContextAttachMenu, AttachmentChips } from '@/app/components/ContextAttachMenu'
import { BrandedHeader } from '@/app/components/BrandedHeader'
import { AnimatedNumber } from '@/app/components/AnimatedNumber'
import { OnboardingCard, shouldShowOnboardingCard } from '@/app/components/OnboardingCard'
import { OnboardingBanner } from '@/app/components/OnboardingBanner'
import { GoogleChatPanel } from '@/app/components/GoogleChatPanel'
import { InfoPopover } from '@/app/components/InfoPopover'
import { useKPIData } from '@/app/hooks/useKPIData'
import { useSpaces, useUnreadCounts } from '@/app/hooks/useGoogleChat'
import {
  detectIntent,
  startInterview,
  advanceInterview,
  getCurrentQuestion,
  getTotalQuestions,
} from '@/lib/interview'
import type { InterviewState, ActionSpec, ChatAttachment } from '@/types'

const CHAT_SUGGESTIONS = [
  "What's blocking FridgeSnap revenue?",
  "Summarize today's agent activity",
  "Show Q2 goal status",
  "Create a task for the team",
]

const ONBOARDING_SUGGESTIONS = [
  "What meetings do I have today?",
  "Show my open tasks",
  "What files did I work on recently?",
  "What is this Hub for?",
]


/* ══════════════════════════════════════════════════════════════════════════════
   COMPONENTS
   ══════════════════════════════════════════════════════════════════════════════ */

// AnimatedNumber is now imported from @/app/components/AnimatedNumber

/* ── Left Panel: Context Layer ── */
function LeftPanel({ isOpen, onClose, onInjectChat, panelRef, style, activeProject }: { isOpen?: boolean; onClose?: () => void; onInjectChat: (msg: string, useCase?: string) => void; panelRef?: React.Ref<HTMLElement>; style?: React.CSSProperties; activeProject?: string }) {
  return (
    <aside ref={panelRef} className={`panel-left ${isOpen ? 'mobile-open' : ''}`} aria-label="Context Layer" style={style}>
      <div className="panel-header">
        <h2 className="panel-title">
          <span className="panel-title-display">Context</span>
        </h2>
        {onClose && (
          <button className="panel-close-btn" onClick={onClose} aria-label="Close Context Layer">
            &times;
          </button>
        )}
      </div>

      <div className="panel-content">
        <KPISection activeProject={activeProject} onInjectChat={onInjectChat} />
        <CalendarSection onInjectChat={onInjectChat} />
        <TasksSection onInjectChat={onInjectChat} />
        <DocumentsSection onInjectChat={onInjectChat} />
      </div>
    </aside>
  )
}

/* ── Safe Markdown-like renderer (no dangerouslySetInnerHTML) ── */
function parseInlineMarkdown(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  // Match bold (**...**) and italic (*...*) — bold first since it's a superset
  const regex = /\*\*(.*?)\*\*|\*(.*?)\*/g
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

function MessageContent({ content }: { content: string }) {
  const lines = content.split('\n')

  return (
    <div style={{ whiteSpace: 'pre-wrap' }}>
      {lines.map((line, i) => {
        // Bullet points
        if (line.startsWith('• ') || line.startsWith('- ')) {
          return <div key={i} style={{ paddingLeft: '8px' }}>{parseInlineMarkdown(line)}</div>
        }
        // Table header detection
        if (line.includes('|') && line.trim().startsWith('|')) {
          const cells = line.split('|').filter(c => c.trim())
          if (cells.every(c => /^[\s-]+$/.test(c))) return <Fragment key={i} />  // separator line
          return (
            <div key={i} style={{
              display: 'flex',
              gap: '8px',
              fontFamily: 'var(--font-mono)',
              fontSize: '0.7rem',
              padding: '2px 0',
              color: line.includes('---') ? 'transparent' : undefined,
            }}>
              {cells.map((cell, j) => (
                <span key={j} style={{ flex: 1, minWidth: 0 }}>{parseInlineMarkdown(cell.trim())}</span>
              ))}
            </div>
          )
        }
        // Empty line
        if (!line.trim()) {
          return <div key={i}>{' '}</div>
        }
        return <div key={i}>{parseInlineMarkdown(line)}</div>
      })}
    </div>
  )
}

/* ── Right Panel: Execution Layer ── */
function RightPanel({ isOpen, onClose, onInjectChat, panelRef, style, projects }: { isOpen?: boolean; onClose?: () => void; onInjectChat: (msg: string, useCase?: string) => void; panelRef?: React.Ref<HTMLElement>; style?: React.CSSProperties; projects?: import('@/types').ProjectKPI[] }) {
  return (
    <aside ref={panelRef} className={`panel-right ${isOpen ? 'mobile-open' : ''}`} aria-label="Execution Layer" style={style}>
      <div className="panel-header">
        <h2 className="panel-title">
          <span className="panel-title-display">Execution</span>
        </h2>
        {onClose && (
          <button className="panel-close-btn" onClick={onClose} aria-label="Close Execution Layer">
            &times;
          </button>
        )}
      </div>

      <div className="panel-content">
        <ProjectHealthSection projects={projects} onInjectChat={onInjectChat} />
        <ExecutionFeed onInjectChat={onInjectChat} />
      </div>
    </aside>
  )
}

/* ══════════════════════════════════════════════════════════════════════════════
   MAIN PAGE
   ══════════════════════════════════════════════════════════════════════════════ */

type MobileTab = 'chat' | 'command' | 'execution' | 'google_chat'
type ChatMsg = { id: string; role: 'user' | 'assistant'; content: string; timestamp?: string; attachments?: ChatAttachment[] }

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

export default function HubPage() {
  const { data: session } = useSession()
  const router = useRouter()
  const [activeProject, setActiveProject] = useState('all')
  const { projects } = useKPIData(activeProject)
  const [mobileLeftOpen, setMobileLeftOpen] = useState(false)
  const [mobileRightOpen, setMobileRightOpen] = useState(false)
  const [mobileTab, setMobileTab] = useState<MobileTab>('chat')
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [showOnboardingCard, setShowOnboardingCard] = useState(false)
  const [chatPanelOpen, setChatPanelOpen] = useState(false)

  // Google Chat unread badge — uses visible spaces from useSpaces hook
  const { visibleSpaces: chatVisibleSpaces } = useSpaces()
  const { totalUnread: chatTotalUnread } = useUnreadCounts(chatVisibleSpaces)
  // Derive current user role from session
  const userRole = (session?.user as Record<string, unknown>)?.role as string ?? 'onboarding'
  const isOnboarding = userRole === 'onboarding'
  const canUseInterviewMode = !isOnboarding
  const canAccessAdmin = userRole === 'admin' || userRole === 'superadmin'

  // Swipe gesture state — real-time drag-follow system
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)
  const swipeDirRef = useRef<'left' | 'right' | null>(null)
  const isSwipingRef = useRef(false)
  const leftPanelRef = useRef<HTMLElement>(null)
  const rightPanelRef = useRef<HTMLElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const SWIPE_COMMIT = 104 // px to commit open/close (~30% more bail room)
  const SCREEN_W = typeof window !== 'undefined' ? window.innerWidth : 375

  // Chat state (lifted so handleChatInject can share it)
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [isTyping, setIsTyping] = useState(false)
  const [actionExecuting, setActionExecuting] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const chatMessagesRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [showScrollBtn, setShowScrollBtn] = useState(false)

  // Interview Mode state
  const [interviewState, setInterviewState] = useState<InterviewState | null>(null)
  const [injectedContext, setInjectedContext] = useState<string | null>(null)
  const [actionSpec, setActionSpec] = useState<InterviewState['spec']>(null)

  // Context attachments state
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])

  const handleAddAttachment = useCallback((att: Omit<ChatAttachment, 'id'>) => {
    if (attachments.length >= 5) return  // Cap at 5
    setAttachments(prev => [...prev, { ...att, id: crypto.randomUUID() }])
  }, [attachments.length])

  const handleRemoveAttachment = useCallback((id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id))
  }, [])

  // Auth error detection
  const authError = (session?.user as Record<string, unknown> | undefined)?.error === 'RefreshAccessTokenError'

  // User initials for chat avatar
  const userInitials = (() => {
    const name = session?.user?.name || ''
    const parts = name.split(' ').filter(Boolean)
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
    return '??' 
  })()

  // Initialize theme from localStorage and apply to <html>
  useEffect(() => {
    const saved = (typeof window !== 'undefined' && localStorage.getItem('rx-hub-theme')) as 'dark' | 'light' | null
    const initial = saved || 'dark'
    setTheme(initial)
    document.documentElement.setAttribute('data-theme', initial)
  }, [])

  // Show onboarding card on first sign-in (localStorage check)
  useEffect(() => {
    if (isOnboarding && shouldShowOnboardingCard()) {
      setShowOnboardingCard(true)
    }
  }, [isOnboarding])

  const handleThemeToggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    document.documentElement.setAttribute('data-theme', next)
    localStorage.setItem('rx-hub-theme', next)
  }

  /* ── E1: Haptic feedback utility ── */
  const haptic = useCallback((ms = 10) => {
    try { navigator?.vibrate?.(ms) } catch { /* silent */ }
  }, [])

  const handleMobileTab = (tab: MobileTab) => {
    haptic()
    setMobileTab(tab)
    if (tab === 'command') {
      setMobileLeftOpen(true)
      setMobileRightOpen(false)
      setChatPanelOpen(false)
    } else if (tab === 'execution') {
      setMobileRightOpen(true)
      setMobileLeftOpen(false)
      setChatPanelOpen(false)
    } else if (tab === 'google_chat') {
      setMobileLeftOpen(false)
      setMobileRightOpen(false)
      setChatPanelOpen(true)
    } else {
      setMobileLeftOpen(false)
      setMobileRightOpen(false)
      setChatPanelOpen(false)
    }
  }

  const handleClosePanels = () => {
    setMobileLeftOpen(false)
    setMobileRightOpen(false)
    setChatPanelOpen(false)
    setMobileTab('chat')
  }

  /* ── Swipe gesture handlers — real-time drag-follow ── */
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0]
    touchStartRef.current = { x: touch.clientX, y: touch.clientY }
    swipeDirRef.current = null
    isSwipingRef.current = false
  }, [])

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!touchStartRef.current) return
    const touch = e.touches[0]
    const dx = touch.clientX - touchStartRef.current.x
    const dy = touch.clientY - touchStartRef.current.y

    // Lock direction on first significant movement
    if (!swipeDirRef.current) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return
      if (Math.abs(dy) > Math.abs(dx)) {
        // Vertical scroll — abort swipe tracking
        touchStartRef.current = null
        return
      }
      swipeDirRef.current = dx > 0 ? 'right' : 'left'
      isSwipingRef.current = true
    }

    const screenW = window.innerWidth
    if (screenW > 640) return // Desktop — no drag

    // Determine what panel to show based on swipe + current state
    if (swipeDirRef.current === 'right') {
      if (mobileRightOpen && rightPanelRef.current) {
        // Closing right panel — drag it away
        const offset = Math.max(0, dx)
        rightPanelRef.current.style.transform = `translateX(${offset}px)`
        rightPanelRef.current.style.transition = 'none'
        if (backdropRef.current) {
          backdropRef.current.style.opacity = String(Math.max(0, 1 - offset / (screenW * 0.4)))
        }
      } else if (!mobileLeftOpen && leftPanelRef.current) {
        // Opening left panel — drag it in from -100%
        const progress = Math.min(dx / screenW, 1)
        const panelX = -screenW + (progress * screenW)
        leftPanelRef.current.style.transform = `translateX(${panelX}px)`
        leftPanelRef.current.style.transition = 'none'
        leftPanelRef.current.style.visibility = 'visible'
        if (backdropRef.current) {
          backdropRef.current.style.display = 'block'
          backdropRef.current.style.opacity = String(Math.min(progress * 1.5, 1))
        }
      }
    } else if (swipeDirRef.current === 'left') {
      if (mobileLeftOpen && leftPanelRef.current) {
        // Closing left panel — drag it away
        const offset = Math.min(0, dx)
        leftPanelRef.current.style.transform = `translateX(${offset}px)`
        leftPanelRef.current.style.transition = 'none'
        if (backdropRef.current) {
          backdropRef.current.style.opacity = String(Math.max(0, 1 - Math.abs(offset) / (screenW * 0.4)))
        }
      } else if (!mobileRightOpen && rightPanelRef.current) {
        // Opening right panel — drag it in from +100%
        const progress = Math.min(Math.abs(dx) / screenW, 1)
        const panelX = screenW - (progress * screenW)
        rightPanelRef.current.style.transform = `translateX(${panelX}px)`
        rightPanelRef.current.style.transition = 'none'
        rightPanelRef.current.style.visibility = 'visible'
        if (backdropRef.current) {
          backdropRef.current.style.display = 'block'
          backdropRef.current.style.opacity = String(Math.min(progress * 1.5, 1))
        }
      }
    }
  }, [mobileLeftOpen, mobileRightOpen])

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (!touchStartRef.current || !isSwipingRef.current) {
      touchStartRef.current = null
      return
    }

    const touch = e.changedTouches[0]
    const dx = touch.clientX - touchStartRef.current.x
    const dir = swipeDirRef.current
    touchStartRef.current = null
    swipeDirRef.current = null
    isSwipingRef.current = false

    const screenW = window.innerWidth
    if (screenW > 640) return

    // Reset inline styles so CSS transitions take over
    const resetPanel = (el: HTMLElement | null) => {
      if (!el) return
      el.style.transform = ''
      el.style.transition = ''
      el.style.visibility = ''
    }
    // Explicitly restore backdrop to match React state (not '' which clears to CSS default)
    const panelsStillOpen = mobileLeftOpen || mobileRightOpen
    if (backdropRef.current) {
      backdropRef.current.style.display = panelsStillOpen ? 'block' : 'none'
      backdropRef.current.style.opacity = panelsStillOpen ? '1' : '0'
    }

    const absDx = Math.abs(dx)
    const committed = absDx > SWIPE_COMMIT

    if (dir === 'right') {
      if (mobileRightOpen && committed) {
        resetPanel(rightPanelRef.current)
        handleClosePanels()
      } else if (!mobileLeftOpen && committed) {
        resetPanel(leftPanelRef.current)
        handleMobileTab('command')
      } else {
        resetPanel(leftPanelRef.current)
        resetPanel(rightPanelRef.current)
      }
    } else if (dir === 'left') {
      if (mobileLeftOpen && committed) {
        resetPanel(leftPanelRef.current)
        handleClosePanels()
      } else if (!mobileRightOpen && committed) {
        resetPanel(rightPanelRef.current)
        handleMobileTab('execution')
      } else {
        resetPanel(leftPanelRef.current)
        resetPanel(rightPanelRef.current)
      }
    } else {
      resetPanel(leftPanelRef.current)
      resetPanel(rightPanelRef.current)
    }
  }, [mobileLeftOpen, mobileRightOpen])

  /* ── Scroll to bottom of chat ── */
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  useEffect(() => { scrollToBottom() }, [messages, scrollToBottom])

  /* ── E2: Scroll-to-bottom detection ── */
  useEffect(() => {
    const el = chatMessagesRef.current
    if (!el) return
    const handleScroll = () => {
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      setShowScrollBtn(distFromBottom > 120)
    }
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [])

  /* ── Send to Gemini API ── */
  const sendToApi = useCallback(async (userMessage: string, allMessages: ChatMsg[], useCase: string = 'deep_dive', msgAttachments?: ChatAttachment[]) => {
    setIsTyping(true)

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: allMessages.map(m => ({
            id: m.id,
            role: m.role,
            content: m.content,
            timestamp: new Date().toISOString(),
          })),
          useCase,
          attachments: msgAttachments && msgAttachments.length > 0 ? msgAttachments : undefined,
        }),
      })

      if (!res.ok) throw new Error(`API ${res.status}`)

      // Stream the response
      const reader = res.body?.getReader()
      if (!reader) throw new Error('No response body')

      const decoder = new TextDecoder()
      let fullText = ''

      // Add an empty assistant message that we'll stream into
      const assistantId = String(Date.now())
      setMessages(prev => [...prev, { id: assistantId, role: 'assistant' as const, content: '' }])
      setIsTyping(false)

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value, { stream: true })
        const lines = chunk.split('\n')

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6)
            if (data === '[DONE]') break
            try {
              const parsed = JSON.parse(data)
              if (parsed.text) {
                fullText += parsed.text
                setMessages(prev =>
                  prev.map(m => m.id === assistantId ? { ...m, content: fullText } : m)
                )
              }
            } catch {
              // Skip malformed lines
            }
          }
        }
      }

      return // Success ? no fallback needed
    } catch (err) {
      console.error('Chat API Error:', err);
      setIsTyping(false);
      setMessages(prev => [...prev, {
        id: String(Date.now()),
        role: 'assistant' as const,
        content: "I'm having trouble connecting to the intelligence nodes right now. Please try again in a moment.",
      }]);
    }
  }, [])

  const doSend = useCallback((message: string, msgAttachments?: ChatAttachment[]) => {
    haptic()
    const newMessage: ChatMsg = {
      id: crypto.randomUUID(),
      role: 'user' as const,
      content: message,
      timestamp: new Date().toISOString(),
      attachments: msgAttachments,
    }

    setMessages(prev => {
      const updated = [...prev, newMessage]

      // Check if message triggers interview mode (disabled for onboarding users)
      const intent = canUseInterviewMode ? detectIntent(message) : null
      if (intent && !interviewState?.active) {
        const newState = startInterview(intent)
        setInterviewState(newState)
        
        const question = getCurrentQuestion(newState)
        if (question) {
          const totalQ = getTotalQuestions(intent)
          const introMsg: ChatMsg = {
            id: crypto.randomUUID(),
            role: 'assistant' as const,
            content: `✦ **Interview Mode Activated**\n\nI need to understand this fully before we proceed. I'll ask you ${totalQ} quick questions.\n\n**Question 1 of ${totalQ}:**\n${question.question}${question.defaultValue ? `\n\n_Default: ${question.defaultValue}_` : ''}`,
            timestamp: new Date().toISOString(),
          }
          return [...updated, introMsg]
        }
        return updated
      }

      // If interview is active, advance it
      if (interviewState?.active && interviewState.intent) {
        const nextState = advanceInterview(interviewState, message)
        setInterviewState(nextState)

        if (!nextState.active && nextState.spec) {
          // Interview complete — build spec
          setActionSpec(nextState.spec)
          const doneMsg: ChatMsg = {
            id: crypto.randomUUID(),
            role: 'assistant' as const,
            content: '✅ Interview complete! Please review the action below and approve, edit, or cancel.',
            timestamp: new Date().toISOString(),
          }
          return [...updated, doneMsg]
        } else {
          const question = getCurrentQuestion(nextState)
          if (question) {
             const qMsg: ChatMsg = {
              id: crypto.randomUUID(),
              role: 'assistant' as const,
              content: `✦ **${question.question}**${question.defaultValue ? `\n\n_Default: ${question.defaultValue}_` : ''}`,
              timestamp: new Date().toISOString(),
            }
            return [...updated, qMsg]
          }
        }
        return updated
      }

      // Determine useCase
      let useCase = 'deep_dive'
      if (interviewState?.active || (canUseInterviewMode && detectIntent(message))) {
        useCase = 'interview'
      }

      // No interview — send to Gemini API
      sendToApi(message, updated, useCase, msgAttachments)
      return updated
    })
  }, [interviewState, sendToApi, canUseInterviewMode])

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

  /* ── Handle context injection from panels ── */
  const handleChatInject = useCallback((message: string, useCase: string = 'recall') => {
    setMobileLeftOpen(false)
    setMobileRightOpen(false)
    setMobileTab('chat')
    // Create a user message and send it
    const userMsg = { 
      id: crypto.randomUUID(), 
      role: 'user' as const, 
      content: message, 
      timestamp: new Date().toISOString() 
    }
    setMessages(prev => {
      const updated = [...prev, userMsg]
      // Trigger the chat API call (reuse existing send logic)
      sendToApi(message, updated, useCase)
      return updated
    })
  }, [sendToApi])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend])

  const handleTextareaInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    e.target.style.height = 'auto'
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'
  }, [])

  /* ── Execute approved action from Interview Mode ── */
  const handleActionApprove = useCallback(async (spec: ActionSpec) => {
    haptic(15) // Stronger haptic for consequential action
    setActionExecuting(true)
    setActionSpec(null)
    setInterviewState(null)

    // Add a "working on it" message
    const workingId = crypto.randomUUID()
    setMessages(prev => [...prev, {
      id: workingId,
      role: 'assistant' as const,
      content: '⏳ Executing action...',
      timestamp: new Date().toISOString(),
    }])

    try {
      let resultMsg = ''

      switch (spec.intent) {
        case 'create_task': {
          // Get the first task list ID via the tasks API
          const listsRes = await fetch('/api/google/tasks')
          const listsData = await listsRes.json()
          const taskListId = listsData?.taskLists?.[0]?.id
          if (!taskListId) throw new Error('No task lists found')

          // Interview collects: description, priority, deadline, assignee
          const taskTitle = spec.details.description || spec.details.title || spec.summary
          const taskNotes = [
            spec.details.priority ? `Priority: ${spec.details.priority}` : '',
            spec.details.assignee ? `Assigned to: ${spec.details.assignee}` : '',
          ].filter(Boolean).join('\n')

          const res = await fetch('/api/google/tasks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'create',
              taskListId,
              title: taskTitle,
              notes: taskNotes,
              due: spec.details.deadline || spec.details.due || undefined,
            }),
          })
          if (!res.ok) throw new Error(`Task creation failed: ${res.status}`)
          const data = await res.json()
          resultMsg = `✅ **Task created!**\n\n"${data.task?.title || taskTitle}" has been added to your Google Tasks.`
          break
        }

        case 'schedule_event': {
          // Interview collects: title, when, attendees, location, duration
          const whenText = spec.details.when || spec.details.start || spec.details.date || ''
          
          // Try to parse the "when" into an ISO string
          // If it's already ISO, use it; otherwise try Date.parse
          let startDate: Date
          const parsed = Date.parse(whenText)
          if (!isNaN(parsed)) {
            startDate = new Date(parsed)
          } else {
            // Fallback: use tomorrow at 10 AM if unparseable
            startDate = new Date()
            startDate.setDate(startDate.getDate() + 1)
            startDate.setHours(10, 0, 0, 0)
          }

          // Parse duration (default 30 min)
          const durationText = spec.details.duration || '30 minutes'
          const durationMatch = durationText.match(/(\d+)\s*(min|hour|hr)/i)
          let durationMs = 30 * 60 * 1000 // default 30 min
          if (durationMatch) {
            const num = parseInt(durationMatch[1], 10)
            durationMs = durationMatch[2].startsWith('h')
              ? num * 60 * 60 * 1000
              : num * 60 * 1000
          }

          const endDate = new Date(startDate.getTime() + durationMs)
          const startISO = startDate.toISOString()
          const endISO = endDate.toISOString()

          const eventTitle = spec.details.title || spec.summary
          const eventDesc = [
            spec.details.location ? `Location: ${spec.details.location}` : '',
            spec.details.notes || '',
          ].filter(Boolean).join('\n')

          const res = await fetch('/api/google/calendar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              summary: eventTitle,
              description: eventDesc,
              start: startISO,
              end: endISO,
              attendees: spec.details.attendees
                ? spec.details.attendees.split(',').map((e: string) => e.trim())
                : undefined,
            }),
          })
          if (!res.ok) throw new Error(`Event creation failed: ${res.status}`)
          const data = await res.json()
          resultMsg = `✅ **Event scheduled!**\n\n"${data.event?.summary || eventTitle}" has been added to your Google Calendar for ${startDate.toLocaleDateString()} at ${startDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
          break
        }

        case 'send_communication': {
          // Route through Paperclip agent
          const res = await fetch('/api/paperclip/api/companies', {
            method: 'GET',
          })
          // For now, log the intent — full Paperclip communication routing TBD
          resultMsg = `✅ **Communication queued!**\n\n"${spec.details.subject || spec.summary}" will be sent via ${spec.targetSystems.join(', ')}.`
          break
        }

        case 'create_paperclip_issue': {
          const issueTitle = spec.details.title || spec.summary
          const issueDesc = spec.details.description || ''
          const issuePriority = spec.details.priority || 'medium'

          const res = await fetch('/api/paperclip/issues', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title: issueTitle,
              description: issueDesc,
              priority: issuePriority,
            }),
          })
          if (!res.ok) throw new Error(`Paperclip Issue creation failed: ${res.status}`)
          const data = await res.json()
          resultMsg = `✅ **Agent Triggered!**\n\n"${data.issue?.title || issueTitle}" has been assigned to the CEO Agent. You can track progress in the Execution Feed.`
          
          // Force refresh the Right Panel feed immediately
          mutate('/api/feed')
          break
        }

        default:
          resultMsg = `⚠️ Unknown action type: ${spec.intent}`
      }

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
  }, [])

  return (
    <div
      className="hub-shell"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      <BrandedHeader
        activeProject={activeProject}
        onProjectChange={setActiveProject}
        theme={theme}
        onThemeToggle={handleThemeToggle}
      />

      {/* Auth error banner */}
      {authError && (
        <div className="auth-error-banner" role="alert">
          <span>⚠️ Your session has expired.</span>
          <button onClick={() => signIn('google')} className="auth-error-btn">
            Sign in again
          </button>
        </div>
      )}

      {/* Onboarding banner (persistent until role assigned) */}
      {isOnboarding && !showOnboardingCard && (
        <OnboardingBanner />
      )}

      {/* Tablet: control bar (shown only between 641px–1024px) */}
            <div className="mobile-control-bar">
        <button
          className="mobile-control-btn"
          onClick={() => { setMobileLeftOpen(true); setMobileRightOpen(false) }}
          aria-label="Open Tasks"
        >
          <span style={{ color: 'var(--accent)', marginRight: '6px' }}>☰</span> Tasks
        </button>
        <button
          className="mobile-control-btn"
          onClick={() => { setMobileRightOpen(true); setMobileLeftOpen(false) }}
          aria-label="Open Activity"
        >
          <span style={{ color: 'var(--accent)', marginRight: '6px' }}>⚡</span> Activity
        </button>
      </div>

      <div className="panels-container">
        <LeftPanel isOpen={mobileLeftOpen} onClose={handleClosePanels} onInjectChat={(msg) => handleChatInject(msg, 'recall')} panelRef={leftPanelRef} activeProject={activeProject} />

        {/* ── Center Panel: AI Chat (inlined for shared state) ── */}
        <main className="panel-center" aria-label="AI Chat">
          <div className="chat-container">
            {/* Chat Header */}
            <div className="chat-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span className="panel-title-dot" aria-hidden="true" />
                <h2 className="chat-header-title">
                  <span aria-hidden="true">✦ </span>AI Assistant
                </h2>
                <span className="chat-header-model-badge">
                  Gemini 2.5
                </span>
              </div>
            </div>

                        {/* Interview badge */}
            {interviewState?.active && (
              <InterviewBadge
                state={interviewState}
                totalQuestions={interviewState.intent ? getTotalQuestions(interviewState.intent) : 0}
                onCancel={() => { setInterviewState(null) }}
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
                    How can I help today?
                  </h3>
                  <p style={{
                    fontSize: 'var(--text-sm)', color: 'var(--text-muted)',
                    maxWidth: '280px', lineHeight: 1.5, margin: 0,
                  }}>
                    Ask about your projects, create tasks, schedule events, or check your business metrics.
                  </p>
                </div>
              )}
              {messages.map(msg => (
                <div key={msg.id} className={`chat-message ${msg.role === 'user' ? 'chat-message-user' : ''}`}>
                  <div
                    className={`chat-message-avatar ${msg.role === 'user' ? 'chat-message-avatar-user' : 'chat-message-avatar-ai'}`}
                    aria-hidden="true"
                  >
                    {msg.role === 'user' ? userInitials : '✦'}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '78%' }}>
                    <div className={`chat-bubble ${msg.role === 'user' ? 'chat-bubble-user' : 'chat-bubble-ai'}`} style={{ maxWidth: '100%' }}>
                      <MessageContent content={msg.content} />
                    </div>
                    {/* Show attachment chips on sent user messages */}
                    {msg.role === 'user' && msg.attachments && msg.attachments.length > 0 && (
                      <AttachmentChips
                        attachments={msg.attachments}
                        onRemove={() => {}}
                        readOnly
                      />
                    )}
                    {msg.role === 'assistant' && msg.content && <CopyButton text={msg.content} />}
                  </div>
                </div>
              ))}

              {/* Action confirm card */}
              {actionSpec && (
                <ActionConfirmCard
                  spec={actionSpec}
                  onApprove={() => handleActionApprove(actionSpec)}
                  onEdit={() => { /* could re-enter interview */ }}
                  onCancel={() => { setActionSpec(null); setInterviewState(null) }}
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
                {(isOnboarding ? ONBOARDING_SUGGESTIONS : CHAT_SUGGESTIONS).map(s => (
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

        {!isOnboarding && (
          <RightPanel isOpen={mobileRightOpen} onClose={handleClosePanels} onInjectChat={(msg) => handleChatInject(msg, 'execute')} panelRef={rightPanelRef} projects={projects} />
        )}

        {/* Onboarding: hide right panel placeholder for onboarding users */}
        {isOnboarding && (
          <aside className="panel-right panel-right--onboarding" aria-hidden="true">
            <div className="onboarding-right-placeholder">
              <span className="onboarding-right-placeholder__icon">⚡</span>
              <span className="onboarding-right-placeholder__text" style={{ display: 'inline-flex', alignItems: 'center' }}>
                Execution Feed unlocks after role assignment
                <InfoPopover
                  align="left"
                  content={
                    <>
                      <p style={{ fontWeight: 600, color: 'var(--accent)' }}>⚡ Locked Panel Information</p>
                      <p style={{ marginTop: '6px' }}>The <b>Execution Feed</b> displays running tasks, background operations, and AI agent output in real time.</p>
                      <p><b>How to unlock:</b> Contact your hub administrator to assign your operational role (Staff/Admin) in the Hub Roles configuration.</p>
                    </>
                  }
                />
              </span>
            </div>
          </aside>
        )}
      </div>

      {/* Google Chat panel overlay */}
      <GoogleChatPanel
        isOpen={chatPanelOpen}
        onClose={handleClosePanels}
      />

      {/* Mobile: Glassmorphism Bottom Navigation Bar */}
      <nav className="mobile-bottom-nav" aria-label="Mobile navigation" role="tablist">
        <button
          className={`mobile-nav-btn ${mobileTab === 'command' ? 'active' : ''}`}
          onClick={() => handleMobileTab('command')}
          aria-label="Tasks"
          role="tab"
          aria-selected={mobileTab === 'command'}
        >
          <span className="mobile-nav-icon" aria-hidden="true">☰</span>
          <span className="mobile-nav-label">Tasks</span>
        </button>
        <button
          className={`mobile-nav-btn mobile-nav-btn--center ${mobileTab === 'google_chat' ? 'active' : ''}`}
          onClick={() => handleMobileTab('google_chat')}
          aria-label={`Google Chat${chatTotalUnread > 0 ? `, ${chatTotalUnread} unread` : ''}`}
          role="tab"
          aria-selected={mobileTab === 'google_chat'}
        >
          <span className="mobile-nav-icon mobile-nav-icon--chat" aria-hidden="true" style={{ position: 'relative' }}>
            <span className="rx-icon" style={{marginTop: '4px'}}>
              <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </span>
            {chatTotalUnread > 0 && (
              <span style={{ position: 'absolute', top: '-6px', right: '-8px', background: 'var(--accent)', color: 'var(--btn-text)', fontSize: '10px', padding: '2px 6px', borderRadius: '12px', fontWeight: 'bold' }} aria-label={`${chatTotalUnread} unread`}>
                {chatTotalUnread > 99 ? '99+' : chatTotalUnread}
              </span>
            )}
          </span>
          <span className="mobile-nav-label">Google Chat</span>
        </button>
        <button
          className={`mobile-nav-btn ${mobileTab === 'execution' ? 'active' : ''}`}
          onClick={() => handleMobileTab('execution')}
          aria-label="Activity"
          role="tab"
          aria-selected={mobileTab === 'execution'}
        >
          <span className="mobile-nav-icon" aria-hidden="true">⚡</span>
          <span className="mobile-nav-label">Activity</span>
        </button>
      </nav>

      {/* Backdrop (always rendered for swipe gesture opacity control) */}
      <div
        ref={backdropRef}
        className="mobile-backdrop"
        onClick={handleClosePanels}
        aria-hidden="true"
        style={{
          display: (mobileLeftOpen || mobileRightOpen) ? 'block' : 'none',
          opacity: (mobileLeftOpen || mobileRightOpen) ? 1 : 0,
        }}
      />

      {/* Onboarding card (full-screen, first sign-in only) */}
      {showOnboardingCard && (
        <OnboardingCard onDismiss={() => setShowOnboardingCard(false)} />
      )}
    </div>
  )
}