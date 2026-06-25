'use client'

import { useState, useRef, useEffect, useCallback, useMemo, memo, Fragment } from 'react'
import { mutate } from 'swr'
import { useSession, signIn } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { TasksSection, CalendarSection, DocumentsSection, KPISection, ProjectHealthSection, SectionErrorBoundary } from '@/app/components/LeftPanelSections'
import { ExecutionFeed } from '@/app/components/RightPanelSections'
import { InterviewBadge, ActionConfirmCard, SkillBadge } from '@/app/components/ChatEnhancements'
import { ToolPanel } from '@/app/components/ToolPanel'
import { ToolPanelCollapsedRail, MobileToolEdge } from '@/app/components/ToolPanelCollapsedRail'
import type { ToolArtifactData } from '@/types'
import { ContextAttachMenu, AttachmentChips } from '@/app/components/ContextAttachMenu'
import { SkillsPopover } from '@/app/components/SkillsPopover'
import { SKILL_CATALOG, SKILL_MAP } from '@/lib/skills'
import { BrandedHeader } from '@/app/components/BrandedHeader'
import { AnimatedNumber } from '@/app/components/AnimatedNumber'
import { OnboardingCard, shouldShowOnboardingCard } from '@/app/components/OnboardingCard'
import { OnboardingBanner } from '@/app/components/OnboardingBanner'
import { GoogleChatPanel } from '@/app/components/GoogleChatPanel'
import { EmailPreviewCard } from '@/app/components/EmailPreviewCard'
import { InfoPopover } from '@/app/components/InfoPopover'
import { FounderLensWizard } from '@/app/components/FounderLensWizard'
import { useTenant } from '@/app/components/TenantProvider'
import { useKPIData } from '@/app/hooks/useKPIData'
import { useSpaces, useUnreadCounts } from '@/app/hooks/useGoogleChat'
import {
  detectIntent,
  startInterview,
  advanceInterview,
  restartInterview,
  getCurrentQuestion,
  getCurrentQuestionWithDefaults,
  getTotalQuestions,
  hasPermission,
  getRequiredPermission,
  isReadOnlyIntent,
  isHighStakesIntent,
} from '@/lib/interview'
import { PAPERCLIP_BASE_URL } from '@/lib/paperclipConfig'
import { useCompanies } from '@/app/hooks/useCompanies'
import type { InterviewState, ActionSpec, ChatAttachment, ActiveSkill } from '@/types'
import { executeAction } from '@/lib/actions/executeAction'
import { useSwipePanels } from '@/app/hooks/useSwipePanels'
import { MessageContent, parseInlineMarkdown } from '@/app/components/MessageContent'



/* ── Dynamic suggestions are built per-user in HubPage via useMemo ── */

const FALLBACK_SUGGESTIONS = [
  "What projects need attention?",
  "Summarize today's agent activity",
  "Show workspace status",
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
function LeftPanelImpl({ isOpen, onClose, onInjectChat, panelRef, closeBtnRef, isMobileViewport, style, activeProject, workspaceName, kpis, kpiLoading }: { isOpen?: boolean; onClose?: () => void; onInjectChat: (msg: string, attachments?: ChatAttachment[]) => void; panelRef?: React.Ref<HTMLElement>; closeBtnRef?: React.Ref<HTMLButtonElement>; isMobileViewport?: boolean; style?: React.CSSProperties; activeProject?: string; workspaceName?: string; kpis?: import('@/types').LiveKPI[]; kpiLoading?: boolean }) {
  const tenant = useTenant()
  return (
    <aside
      ref={panelRef}
      className={`panel-left ${isOpen ? 'mobile-open' : ''}`}
      aria-label="Context Layer"
      style={style}
      {...(isOpen && isMobileViewport
        ? { role: 'dialog' as const, 'aria-modal': true }
        : {})}
    >
      <div className="panel-header">
        <h2 className="panel-title">
          <span className="panel-title-display">{workspaceName || tenant?.name || 'Business'}</span>
        </h2>
        {onClose && (
          <button ref={closeBtnRef} className="panel-close-btn" onClick={onClose} aria-label="Close Context Layer">
            &times;
          </button>
        )}
      </div>

      <div className="panel-content">
        <SectionErrorBoundary label="KPIs">
          <KPISection kpis={kpis ?? []} isLoading={!!kpiLoading} onInjectChat={onInjectChat} />
        </SectionErrorBoundary>
        <SectionErrorBoundary label="Calendar">
          <CalendarSection onInjectChat={onInjectChat} />
        </SectionErrorBoundary>
        <SectionErrorBoundary label="Tasks">
          <TasksSection onInjectChat={onInjectChat} />
        </SectionErrorBoundary>
        <SectionErrorBoundary label="Documents">
          <DocumentsSection onInjectChat={onInjectChat} />
        </SectionErrorBoundary>
      </div>
    </aside>
  )
}

// Memoized so chat-input keystrokes (unrelated HubPage state) don't re-render the
// whole left panel; injectRecall is already a stable useCallback.
const LeftPanel = memo(LeftPanelImpl)



/* ── Right Panel: Execution Layer ── */
function RightPanel({
  isOpen,
  onClose,
  onInjectChat,
  panelRef,
  style,
  projects,
  activeProject,
  userRole,
  kpiLoading,
  onCustomizeCSuite,
}: {
  isOpen?: boolean
  onClose?: () => void
  onInjectChat: (msg: string) => void
  panelRef?: React.Ref<HTMLElement>
  style?: React.CSSProperties
  projects?: import('@/types').ProjectKPI[]
  activeProject?: string
  userRole?: string
  kpiLoading?: boolean
  onCustomizeCSuite: (orgId: string, orgName: string) => void
}) {
  // Build Paperclip workspace URL from the active project
  const paperclipBaseUrl = process.env.NEXT_PUBLIC_PAPERCLIP_URL || 'https://rxfit-paperclip-11747747730.us-central1.run.app'
  const activeCompany = projects?.find(p => p.identifier?.toLowerCase() === activeProject?.toLowerCase() || p.companyName?.toLowerCase().includes(activeProject?.toLowerCase() || ''))
  const paperclipUrl = activeCompany?.companyId
    ? `${paperclipBaseUrl}/companies/${activeCompany.companyId}`
    : paperclipBaseUrl

  return (
    <aside ref={panelRef} className={`panel-right ${isOpen ? 'mobile-open' : ''}`} aria-label="Execution Layer" style={style}>
      <div className="panel-header">
        <h2 className="panel-title">
          <span className="panel-title-display">Execution</span>
        </h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <a
            href={paperclipUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              padding: '4px 10px',
              fontSize: '0.7rem',
              fontWeight: 600,
              color: 'var(--accent-gold)',
              border: '1px solid var(--accent-gold)',
              borderRadius: 'var(--radius-md)',
              textDecoration: 'none',
              transition: 'all 0.15s ease',
              opacity: 0.85,
            }}
            onMouseEnter={(e) => { (e.target as HTMLElement).style.opacity = '1'; (e.target as HTMLElement).style.background = 'rgba(197,160,89,0.1)' }}
            onMouseLeave={(e) => { (e.target as HTMLElement).style.opacity = '0.85'; (e.target as HTMLElement).style.background = 'transparent' }}
            aria-label="Open Paperclip workspace"
          >
            📎 Paperclip →
          </a>
          {onClose && (
            <button className="panel-close-btn" onClick={onClose} aria-label="Close Execution Layer">
              &times;
            </button>
          )}
        </div>
      </div>

      <div className="panel-content">
        <ProjectHealthSection projects={projects} onInjectChat={onInjectChat} userRole={userRole} isLoading={kpiLoading} />
        {/* orgId derives from activeCompany (same projects.find the page used for the
            now-removed activeOrgId prop — both resolved to this exact value). */}
        <ExecutionFeed onInjectChat={onInjectChat} onCustomizeCSuite={onCustomizeCSuite} orgId={activeCompany?.companyId} />
      </div>
    </aside>
  )
}

/* ══════════════════════════════════════════════════════════════════════════════
   MAIN PAGE
   ══════════════════════════════════════════════════════════════════════════════ */

type MobileTab = 'chat' | 'command' | 'execution' | 'google_chat' | 'tool_panel'
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
  const { projects, kpis, isLoading: kpiLoading } = useKPIData(activeProject)
  const { companies: allCompanies } = useCompanies()

  // Resolve the active workspace company for issue creation and deep links
  const resolveActiveCompany = useCallback(() => {
    if (!allCompanies.length) return null
    if (activeProject && activeProject !== 'all') {
      const match = allCompanies.find(
        c => c.identifier?.toLowerCase() === activeProject.toLowerCase()
          || c.name?.toLowerCase().includes(activeProject.toLowerCase())
      )
      if (match) return match
    }
    // Fallback to first available company
    return allCompanies[0] ?? null
  }, [activeProject, allCompanies])
  const [mobileLeftOpen, setMobileLeftOpen] = useState(false)
  const [mobileRightOpen, setMobileRightOpen] = useState(false)
  const [mobileTab, setMobileTab] = useState<MobileTab>('chat')
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [showOnboardingCard, setShowOnboardingCard] = useState(false)
  const [chatPanelOpen, setChatPanelOpen] = useState(false)
  const [showWizard, setShowWizard] = useState(false)
  const [wizardOrg, setWizardOrg] = useState<{ id: string; name: string } | null>(null)

  // Google Chat unread badge — uses visible spaces from useSpaces hook
  const { visibleSpaces: chatVisibleSpaces } = useSpaces()
  const { totalUnread: chatTotalUnread } = useUnreadCounts(chatVisibleSpaces)
  // Derive current user role from session
  const userRole = (session?.user as Record<string, unknown>)?.role as string ?? 'onboarding'
  const isOnboarding = userRole === 'onboarding'
  const canUseInterviewMode = !isOnboarding
  const canAccessAdmin = userRole === 'admin' || userRole === 'superadmin'

  // Dynamic suggestions based on the user's actual projects/workspace
  const chatSuggestions = useMemo(() => {
    if (!projects || projects.length === 0) return FALLBACK_SUGGESTIONS

    // Pick the most relevant project names (up to 2)
    const topProjects = projects
      .filter(p => p.companyName && p.companyName !== 'All')
      .slice(0, 2)

    const suggestions: string[] = []

    if (topProjects.length > 0) {
      // Lead with a project-specific question
      suggestions.push(`What's blocking ${topProjects[0].companyName}?`)
    }

    suggestions.push("Summarize today's agent activity")

    if (topProjects.length > 1) {
      suggestions.push(`Compare ${topProjects[0].companyName} vs ${topProjects[1].companyName} progress`)
    } else {
      suggestions.push('Show workspace status')
    }

    suggestions.push('Create a task for the team')

    return suggestions
  }, [projects])


  // Chat state (lifted so handleChatInject can share it)
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [isTyping, setIsTyping] = useState(false)
  const [activeModel, setActiveModel] = useState<string | null>(null)
  const [actionExecuting, setActionExecuting] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const chatMessagesRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [showScrollBtn, setShowScrollBtn] = useState(false)

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
  const [skillsPopoverOpen, setSkillsPopoverOpen] = useState(false)

  // Tool Panel state
  const [toolPanelOpen, setToolPanelOpen] = useState(false)
  const [toolPanelCollapsed, setToolPanelCollapsed] = useState(false)
  const [toolArtifacts, setToolArtifacts] = useState<ToolArtifactData | null>(null)

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

  const handleClosePanels = useCallback(() => {
    setMobileLeftOpen(false)
    setMobileRightOpen(false)
    setChatPanelOpen(false)
    setMobileTab('chat')
  }, [])

  // Swipe gesture state — real-time drag-follow system
  const {
    leftPanelRef,
    rightPanelRef,
    backdropRef,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
  } = useSwipePanels({
    mobileLeftOpen,
    mobileRightOpen,
    handleClosePanels,
    handleMobileTab,
  })

  /* ── Mobile drawer a11y: dialog focus management, scroll-lock, Escape ── */
  const leftCloseBtnRef = useRef<HTMLButtonElement>(null)
  const leftOpenerRef = useRef<HTMLElement | null>(null)
  const [isMobileViewport, setIsMobileViewport] = useState(false)

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)')
    const update = () => setIsMobileViewport(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])

  // Focus management for the mobile left drawer
  useEffect(() => {
    if (!(mobileLeftOpen && isMobileViewport)) return
    const panel = leftPanelRef.current
    if (!panel) return

    leftOpenerRef.current = (document.activeElement as HTMLElement) ?? null
    // Move focus in (next frame so the open transition/visibility has applied)
    const raf = requestAnimationFrame(() => leftCloseBtnRef.current?.focus())

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const focusable = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus()
      }
    }
    panel.addEventListener('keydown', onKeyDown)

    return () => {
      cancelAnimationFrame(raf)
      panel.removeEventListener('keydown', onKeyDown)
      // Restore focus to the opener (e.g. the command nav button)
      leftOpenerRef.current?.focus?.()
    }
  }, [mobileLeftOpen, isMobileViewport, leftPanelRef])

  // Body scroll-lock while any panel is open
  useEffect(() => {
    const anyOpen = mobileLeftOpen || mobileRightOpen || chatPanelOpen
    if (!anyOpen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [mobileLeftOpen, mobileRightOpen, chatPanelOpen])

  // Escape closes any open panel
  useEffect(() => {
    const anyOpen = mobileLeftOpen || mobileRightOpen || chatPanelOpen
    if (!anyOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClosePanels()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mobileLeftOpen, mobileRightOpen, chatPanelOpen, handleClosePanels])

  /* ── Scroll to bottom of chat ── */
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  useEffect(() => { scrollToBottom() }, [messages, actionSpec, scrollToBottom])

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

    // HARDENED: AbortController with 45-second client-side timeout
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 45_000)

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          messages: allMessages.map(m => ({
            id: m.id,
            role: m.role,
            content: m.content,
            timestamp: new Date().toISOString(),
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
          serverDetail = errBody?.details || errBody?.error || ''
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
        // 5xx / network / unknown — generic to the user, details already logged above.
        content = "Something went wrong on my end. Give it another try in a moment."
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

  /* ── Handle context injection from panels ── */
  const handleChatInject = useCallback((message: string, useCase: string = 'deep_dive', injectAttachments?: ChatAttachment[]) => {
    setMobileLeftOpen(false)
    setMobileRightOpen(false)
    setMobileTab('chat')
    const userMsg = {
      id: crypto.randomUUID(),
      role: 'user' as const,
      content: message,
      timestamp: new Date().toISOString(),
      // Carry any panel-attached context (e.g. a tapped Drive document's fileId)
      // so the chat route resolves its real content, and the chip renders.
      attachments: injectAttachments && injectAttachments.length > 0 ? injectAttachments : undefined,
    }
    // Capture the updated messages array via functional updater, but fire the
    // API call OUTSIDE the updater to prevent double-firing under React
    // concurrent mode / Strict Mode (P7 fix from /review).
    let updatedMessages: ChatMsg[] = []
    setMessages(prev => {
      updatedMessages = [...prev, userMsg]
      return updatedMessages
    })
    // React batches state updates synchronously within event handlers,
    // so updatedMessages is populated by the time we reach here.
    sendToApi(message, updatedMessages, useCase, injectAttachments)
  }, [sendToApi])

  // Stable per-panel inject handlers — referentially constant across renders so
  // memoized panel children (e.g. FeedCard) don't re-render on unrelated state
  // changes like chat-input typing.
  const injectRecall = useCallback((msg: string, atts?: ChatAttachment[]) => handleChatInject(msg, 'recall', atts), [handleChatInject])
  const injectExecute = useCallback((msg: string) => handleChatInject(msg, 'execute'), [handleChatInject])
  const injectDeepDive = useCallback((msg: string) => handleChatInject(msg, 'deep_dive'), [handleChatInject])

  /* ── Handle skill activation from popover or inline link ── */
  const handleSkillActivate = useCallback((skillId: string) => {
    const skill = SKILL_MAP[skillId]
    if (skill) {
      setActiveSkill({ id: skill.id, name: skill.name, plugin: skill.plugin })
      setSkillsPopoverOpen(false)
      setToolPanelOpen(true)
      setToolPanelCollapsed(false)
      setToolArtifacts(null)
      setMobileTab('tool_panel')
    }
  }, [])

  /* ── Handle skill deactivation (with optional artifact persistence) ── */
  /* ── Handle skill deactivation (cleanup only — saving is handled by ToolPanel.handleSaveAndClose) ── */
  const handleSkillDeactivate = useCallback(() => {
    setActiveSkill(null)
    setToolPanelOpen(false)
    setToolPanelCollapsed(false)
    setToolArtifacts(null)
    if (mobileTab === 'tool_panel') setMobileTab('chat')
  }, [mobileTab])

  /* ── Save tool artifacts callback for ToolPanel ── */
  const handleSaveToolArtifacts = useCallback(async (artifacts: ToolArtifactData) => {
    await fetch('/api/tool-artifacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        toolId: activeSkill?.id,
        title: `${activeSkill?.name}: ${artifacts.title || 'Untitled'}`,
        content: artifacts,
        contextSummary: null,
      }),
    })
  }, [activeSkill])

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
    setMessages(prev => prev.filter(m => !m.content.includes('Interview complete!')))

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
        onOpenGoogleChat={() => setChatPanelOpen(true)}
        chatUnreadCount={chatTotalUnread}
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
        <LeftPanel isOpen={mobileLeftOpen} onClose={handleClosePanels} onInjectChat={injectRecall} panelRef={leftPanelRef} closeBtnRef={leftCloseBtnRef} isMobileViewport={isMobileViewport} activeProject={activeProject} workspaceName={projects?.[0]?.companyName} kpis={kpis} kpiLoading={kpiLoading} />

        {/* ── Center Panel: AI Chat (inlined for shared state) ── */}
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
                <span className={`chat-header-model-badge${activeModel?.includes('Claude') ? ' chat-header-model-badge--claude' : activeModel ? ' chat-header-model-badge--gemini' : ''}`}>
                  {activeModel || 'AI'}
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

        {!isOnboarding && activeSkill && toolPanelOpen && !toolPanelCollapsed && (
          <ToolPanel
            activeSkill={activeSkill}
            messages={messages}
            onDismiss={handleSkillDeactivate}
            onInjectChat={injectDeepDive}
            onSaveArtifacts={handleSaveToolArtifacts}
            isCollapsed={toolPanelCollapsed}
            onToggleCollapse={() => setToolPanelCollapsed(c => !c)}
          />
        )}

        {!isOnboarding && activeSkill && toolPanelOpen && toolPanelCollapsed && (
          <ToolPanelCollapsedRail
            activeSkill={activeSkill}
            onExpand={() => setToolPanelCollapsed(false)}
          />
        )}

        {!isOnboarding && (!activeSkill || !toolPanelOpen) && (
          <RightPanel
            isOpen={mobileRightOpen}
            onClose={handleClosePanels}
            onInjectChat={injectExecute}
            panelRef={rightPanelRef}
            projects={projects}
            activeProject={activeProject}
            userRole={userRole}
            kpiLoading={kpiLoading}
            onCustomizeCSuite={(orgId, orgName) => {
              setWizardOrg({ id: orgId, name: orgName })
              setShowWizard(true)
            }}
          />
        )}

        {/* Mobile: Champagne gold edge indicator when tool is active but panel not visible */}
        {activeSkill && mobileTab !== 'tool_panel' && (
          <MobileToolEdge
            activeSkill={activeSkill}
            onTap={() => setMobileTab('tool_panel')}
          />
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

      {/* C-Suite Customization Wizard Modal */}
      {showWizard && wizardOrg && (
        <FounderLensWizard
          orgId={wizardOrg.id}
          orgName={wizardOrg.name}
          onClose={() => {
            setShowWizard(false)
            setWizardOrg(null)
          }}
        />
      )}
    </div>
  )
}