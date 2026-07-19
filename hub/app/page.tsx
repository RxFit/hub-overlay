'use client'

import { useState, useRef, useEffect, useCallback, useMemo, memo, Fragment } from 'react'
import { useSession, signIn } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { TasksSection, CalendarSection, DocumentsSection, KPISection, ProjectHealthSection, SectionErrorBoundary } from '@/app/components/LeftPanelSections'
import { ExecutionFeed } from '@/app/components/RightPanelSections'
import { RightPanelTabsNav, PulseStrip, AttentionStrip, TabPlaceholder, type RightPanelTab } from '@/app/components/RightPanelWorkspace'
import { IssuesTabView } from '@/app/components/IssuesTabView'
import { AgentsTabView } from '@/app/components/AgentsTabView'
import { RoutinesTabView } from '@/app/components/RoutinesTabView'
import { GoalsTabView } from '@/app/components/GoalsTabView'
import { useExecutionDashboard } from '@/app/hooks/useHubData'
import { InterviewBadge, ActionConfirmCard, SkillBadge } from '@/app/components/ChatEnhancements'
import { ToolPanel } from '@/app/components/ToolPanel'
import { ToolPanelCollapsedRail, MobileToolEdge } from '@/app/components/ToolPanelCollapsedRail'
import type { ToolArtifactData } from '@/types'
import { ContextAttachMenu, AttachmentChips } from '@/app/components/ContextAttachMenu'
import { SkillsPopover } from '@/app/components/SkillsPopover'
import { SKILL_CATALOG, SKILL_MAP } from '@/lib/skills'
import { stripSuggestedTools } from '@/lib/model-output'
import { BrandedHeader } from '@/app/components/BrandedHeader'
import { AnimatedNumber } from '@/app/components/AnimatedNumber'
import { OnboardingCard, shouldShowOnboardingCard } from '@/app/components/OnboardingCard'
import { OnboardingBanner } from '@/app/components/OnboardingBanner'
import { GoogleChatPanel } from '@/app/components/GoogleChatPanel'
import { RequestAccessLink } from '@/app/components/RequestAccessLink'
import { InfoPopover } from '@/app/components/InfoPopover'
import { FounderLensWizard } from '@/app/components/FounderLensWizard'
import { useTenant } from '@/app/components/TenantProvider'
import { useKPIData } from '@/app/hooks/useKPIData'
import { useSpaces, useUnreadCounts } from '@/app/hooks/useGoogleChat'
import {
  restartInterview,
  getCurrentQuestionWithDefaults,
  getTotalQuestions,
  isReadOnlyIntent,
} from '@/lib/interview'
import { PAPERCLIP_BASE_URL } from '@/lib/paperclipConfig'
import { isInterviewScaffold } from '@/lib/interview-scaffold'
import { useCompanies } from '@/app/hooks/useCompanies'
import type { ChatAttachment } from '@/types'
import { useChatEngine, type ChatMsg, type MobileTab } from '@/app/hooks/useChatEngine'
import { useSwipePanels } from '@/app/hooks/useSwipePanels'
import { resolveRole } from '@/lib/roles'
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
function LeftPanelImpl({ isOpen, onClose, onInjectChat, onInjectAction, panelRef, closeBtnRef, isMobileViewport, style, activeProject, workspaceName, kpis, kpiLoading, kpiError, onKpiRetry }: { isOpen?: boolean; onClose?: () => void; onInjectChat: (msg: string, attachments?: ChatAttachment[]) => void; onInjectAction: (msg: string, attachments?: ChatAttachment[]) => void; panelRef?: React.Ref<HTMLElement>; closeBtnRef?: React.Ref<HTMLButtonElement>; isMobileViewport?: boolean; style?: React.CSSProperties; activeProject?: string; workspaceName?: string; kpis?: import('@/types').LiveKPI[]; kpiLoading?: boolean; kpiError?: unknown; onKpiRetry?: () => void }) {
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
          <KPISection kpis={kpis ?? []} isLoading={!!kpiLoading} error={kpiError} onRetry={onKpiRetry} onInjectChat={onInjectChat} />
        </SectionErrorBoundary>
        <SectionErrorBoundary label="Calendar">
          <CalendarSection onInjectChat={onInjectChat} />
        </SectionErrorBoundary>
        <SectionErrorBoundary label="Tasks">
          <TasksSection onInjectChat={onInjectChat} onInjectAction={onInjectAction} />
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
  onInjectAction,
  panelRef,
  style,
  projects,
  activeProject,
  userRole,
  kpiLoading,
  kpiError,
  onKpiRetry,
  onCustomizeCSuite,
}: {
  isOpen?: boolean
  onClose?: () => void
  // Read-style taps (health lookups, "tell me about" feed cards) — direct, intent-free path.
  onInjectChat: (msg: string) => void
  // Action-style affordances (create-task CTA) — routed through doSend for Interview Mode.
  onInjectAction: (msg: string) => void
  panelRef?: React.Ref<HTMLElement>
  style?: React.CSSProperties
  projects?: import('@/types').ProjectKPI[]
  activeProject?: string
  userRole?: string
  kpiLoading?: boolean
  kpiError?: unknown
  onKpiRetry?: () => void
  onCustomizeCSuite: (orgId: string, orgName: string) => void
}) {
  // Build Paperclip workspace URL from the active project
  const paperclipBaseUrl = process.env.NEXT_PUBLIC_PAPERCLIP_URL || 'https://rxfit-paperclip-11747747730.us-central1.run.app'
  const activeCompany = projects?.find(p => p.identifier?.toLowerCase() === activeProject?.toLowerCase() || p.companyName?.toLowerCase().includes(activeProject?.toLowerCase() || ''))
  const paperclipUrl = activeCompany?.companyId
    ? `${paperclipBaseUrl}/companies/${activeCompany.companyId}`
    : paperclipBaseUrl

  // Phase 1 workspace scaffold: tab state + the dashboard snapshot behind the
  // Pulse header and Attention strip (read-only; no new write paths).
  const [activeTab, setActiveTab] = useState<RightPanelTab>('pulse')
  const { dashboard, isLoading: dashboardLoading } = useExecutionDashboard(activeCompany?.companyId)

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

      <RightPanelTabsNav active={activeTab} onChange={setActiveTab} />

      <div className="panel-content">
        {activeTab === 'pulse' ? (
          <>
            <PulseStrip dashboard={dashboard} isLoading={dashboardLoading} />
            <ProjectHealthSection projects={projects} onInjectChat={onInjectChat} userRole={userRole} isLoading={kpiLoading} error={kpiError} onRetry={onKpiRetry} />
            {/* orgId derives from activeCompany (same projects.find the page used for the
                now-removed activeOrgId prop — both resolved to this exact value). */}
            <ExecutionFeed onInjectChat={onInjectChat} onInjectAction={onInjectAction} onCustomizeCSuite={onCustomizeCSuite} orgId={activeCompany?.companyId} />
          </>
        ) : activeTab === 'issues' ? (
          <IssuesTabView orgId={activeCompany?.companyId} userRole={userRole} onInjectChat={onInjectChat} />
        ) : activeTab === 'agents' ? (
          <AgentsTabView orgId={activeCompany?.companyId} userRole={userRole} onInjectChat={onInjectChat} />
        ) : activeTab === 'routines' ? (
          <RoutinesTabView orgId={activeCompany?.companyId} userRole={userRole} onInjectChat={onInjectChat} onInjectAction={onInjectAction} />
        ) : activeTab === 'goals' ? (
          <GoalsTabView orgId={activeCompany?.companyId} userRole={userRole} onInjectChat={onInjectChat} onInjectAction={onInjectAction} />
        ) : (
          <TabPlaceholder tab={activeTab} paperclipUrl={paperclipUrl} onInjectChat={onInjectChat} />
        )}
      </div>

      {/* Persistent footer: blocked/error/approval/budget signals; every chip
          resolves through a read-style assistant query. */}
      <AttentionStrip dashboard={dashboard} onInjectChat={onInjectChat} />
    </aside>
  )
}

/* ══════════════════════════════════════════════════════════════════════════════
   MAIN PAGE
   ══════════════════════════════════════════════════════════════════════════════ */

// `MobileTab` and `ChatMsg` types now live in and are imported from useChatEngine.

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  
  const handleCopy = () => {
    // Copy what the bubble SHOWS — the raw content still carries the hidden
    // <!--suggestedTools--> metadata comment, which must not leak into pastes.
    navigator.clipboard.writeText(stripSuggestedTools(text).trimEnd())
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
  const { projects, kpis, isLoading: kpiLoading, error: kpiError, refetch: kpiRefetch } = useKPIData(activeProject)
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
  // From the role config (single source of truth) — onboarding users now get
  // Interview Mode too, so personal Google actions (own Tasks/Calendar) work;
  // per-intent permissions still deny org-level actions with a clear message.
  const canUseInterviewMode = resolveRole(userRole).canUseInterviewMode
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


  // Presentational chat refs/state (kept in page.tsx; the chat engine state and
  // handlers live in useChatEngine — see the `chat` hook call below).
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const chatMessagesRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [showScrollBtn, setShowScrollBtn] = useState(false)

  // Skills popover (UI-only) state
  const [skillsPopoverOpen, setSkillsPopoverOpen] = useState(false)

  // Tool Panel state
  const [toolPanelOpen, setToolPanelOpen] = useState(false)
  const [toolPanelCollapsed, setToolPanelCollapsed] = useState(false)
  const [toolArtifacts, setToolArtifacts] = useState<ToolArtifactData | null>(null)

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

  // Apply the theme to <html> on mount. The in-app dark/light TOGGLE was removed
  // (its header slot now hosts the EXA Search toggle), but we still honor any
  // previously-saved preference and default to dark so styling is unaffected.
  useEffect(() => {
    const saved = (typeof window !== 'undefined' && localStorage.getItem('rx-hub-theme')) as 'dark' | 'light' | null
    document.documentElement.setAttribute('data-theme', saved || 'dark')
  }, [])

  // Show onboarding card on first sign-in (localStorage check)
  useEffect(() => {
    if (isOnboarding && shouldShowOnboardingCard()) {
      setShowOnboardingCard(true)
    }
  }, [isOnboarding])

  /* ── E1: Haptic feedback utility ── */
  const haptic = useCallback((ms = 10) => {
    try { navigator?.vibrate?.(ms) } catch { /* silent */ }
  }, [])

  /* ── Chat / interview / skill engine (extracted, behavior-preserving) ──
   * Page-owned dependencies are passed in; the engine returns the state values
   * the JSX renders plus the setters/handlers the page wires into events. */
  const chat = useChatEngine({
    userRole,
    canUseInterviewMode,
    haptic,
    resolveActiveCompany,
    setMobileLeftOpen,
    setMobileRightOpen,
    setMobileTab,
    textareaRef,
  })
  const {
    messages,
    input,
    isTyping,
    activeModel,
    interviewState,
    actionSpec,
    contextScore,
    contextWeakDim,
    isScoring,
    attachments,
    quotedReply,
    activeSkill,
    suggestedTools,
    exaMode,
    setInput,
    setMessages,
    setInterviewState,
    setActionSpec,
    setContextScore,
    setContextWeakDim,
    setQuotedReply,
    setActiveSkill,
    setExaMode,
    handleAddAttachment,
    handleRemoveAttachment,
    handleSend,
    handleSuggestion,
    injectRecall,
    injectExecute,
    injectDeepDive,
    handleActionApprove,
  } = chat

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
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
  } = useSwipePanels({
    mobileLeftOpen,
    mobileRightOpen,
    handleClosePanels,
    handleMobileTab,
    // The Google Chat / Gmail overlay owns horizontal touch movement (Focus
    // strip, email rows) — drawer swipes are fully disengaged while it's open.
    disabled: chatPanelOpen,
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
    // iOS Safari cancels an in-flight smooth scrollIntoView when the layout
    // shifts mid-animation — exactly what happens when the ActionConfirmCard
    // mounts right after the "Interview complete" bubble. The view then
    // strands at the card's header with the Approve/Edit/Cancel buttons below
    // the fold and no retry. Verify once things settle and force-finish.
    window.setTimeout(() => {
      const el = chatMessagesRef.current
      if (!el) return
      if (el.scrollHeight - el.scrollTop - el.clientHeight > 24) {
        el.scrollTop = el.scrollHeight
      }
    }, 600)
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
  }, [setActiveSkill])

  /* ── Handle skill deactivation (with optional artifact persistence) ── */
  /* ── Handle skill deactivation (cleanup only — saving is handled by ToolPanel.handleSaveAndClose) ── */
  const handleSkillDeactivate = useCallback(() => {
    setActiveSkill(null)
    setToolPanelOpen(false)
    setToolPanelCollapsed(false)
    setToolArtifacts(null)
    if (mobileTab === 'tool_panel') setMobileTab('chat')
  }, [mobileTab, setActiveSkill])

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
  }, [setInput])

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
        exaMode={exaMode}
        onExaToggle={() => { haptic(); setExaMode(prev => !prev) }}
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
        <LeftPanel isOpen={mobileLeftOpen} onClose={handleClosePanels} onInjectChat={injectRecall} onInjectAction={injectExecute} panelRef={leftPanelRef} closeBtnRef={leftCloseBtnRef} isMobileViewport={isMobileViewport} activeProject={activeProject} workspaceName={projects?.[0]?.companyName} kpis={kpis} kpiLoading={kpiLoading} kpiError={kpiError} onKpiRetry={kpiRefetch} />

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
                    I&apos;m your business co-pilot. Ask me anything about your workspace.
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
                  <div className={`chat-message-col ${msg.role === 'user' ? 'chat-message-col--user' : 'chat-message-col--ai'}`}>
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
                          onClick={() => setQuotedReply({ id: msg.id, content: stripSuggestedTools(msg.content).trimEnd().slice(0, 200) })}
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
                      // Remove the interview scaffold messages ("Interview complete!" / "Briefing approved")
                      setMessages(prev => prev.filter(m => !isInterviewScaffold(m)))
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
                    setMessages(prev => prev.filter(m => !isInterviewScaffold(m)))
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
              {/* EXA Search mode indicator — reminds the user the chat is a pure
                  web-search tool and no other Hub tool will fire while it's on. */}
              {exaMode && (
                <div className="exa-mode-banner" role="status">
                  <span className="exa-mode-banner__dot" aria-hidden="true" />
                  <span className="exa-mode-banner__label">EXA Search</span>
                  <span className="exa-mode-banner__hint">Semantic web search — other assistant tools are paused</span>
                  <button
                    className="exa-mode-banner__off"
                    onClick={() => { haptic(); setExaMode(false) }}
                    aria-label="Turn EXA Search off"
                  >
                    Turn off
                  </button>
                </div>
              )}
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
                  placeholder={exaMode ? "Search the web with EXA — papers, companies, market research..." : interviewState?.active ? "Answer the interview question..." : "Ask about your projects, create tasks, check status..."}
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
            // Read-style right-panel taps (health lookups, "tell me about" feed
            // cards) take the direct, intent-free recall path — acceptance #2.
            onInjectChat={injectRecall}
            // Only the explicit create-task CTA is action-style: route it through
            // doSend so detectIntent → role-gate → Interview Mode runs.
            onInjectAction={injectExecute}
            panelRef={rightPanelRef}
            projects={projects}
            activeProject={activeProject}
            userRole={userRole}
            kpiLoading={kpiLoading}
            kpiError={kpiError}
            onKpiRetry={kpiRefetch}
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
                      <p style={{ marginTop: '6px' }}>
                        <RequestAccessLink role={userRole} reason="Requesting operational role assignment (Execution Feed locked)" label="Request role assignment →" />
                      </p>
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
        onDiscussEmail={text => {
          // "Discuss in AI chat": close the Gmail overlay so the AI column is
          // visible, then run the email summary through the read-style inject
          // (deep_dive — no intent detection on an informational lookup).
          handleClosePanels()
          injectDeepDive(text)
        }}
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

      {/* Backdrop — visibility is a PURE function of the open flags, rendered by
          React. Nothing mutates its inline style imperatively, so it can never be
          stranded visible (the stuck-`.mobile-backdrop` P0 class). */}
      <div
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