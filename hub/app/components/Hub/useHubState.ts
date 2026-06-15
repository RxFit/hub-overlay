/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  ⚠️  DEPRECATED — DO NOT USE OR REFERENCE                          ║
 * ║                                                                     ║
 * ║  This file is a DEAD parallel implementation of the Hub chat stack. ║
 * ║  The LIVE implementation is in app/page.tsx.                         ║
 * ║                                                                     ║
 * ║  This file has ZERO imports — nothing references useHubState().     ║
 * ║  It contains unfixed bugs (useCase:'recall' default, inline         ║
 * ║  executeAction without role enforcement, bare string injections).   ║
 * ║                                                                     ║
 * ║  It exists only as a reference. Delete when the migration to        ║
 * ║  page.tsx is confirmed stable (post hub-00018 deploy).              ║
 * ║                                                                     ║
 * ║  2026-06-14: Marked deprecated after Claude Coworks audit revealed  ║
 * ║  this file was being confused with the live stack.                   ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */
'use client'

import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { mutate } from 'swr'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { SKILL_MAP } from '@/lib/skills'
import { shouldShowOnboardingCard } from '@/app/components/OnboardingCard'
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
  isHighStakesIntent,
} from '@/lib/interview'
import { PAPERCLIP_BASE_URL } from '@/lib/paperclipConfig'
import { useCompanies } from '@/app/hooks/useCompanies'
import type { InterviewState, ActionSpec, ChatAttachment, ActiveSkill, ToolArtifactData } from '@/types'

/* ── Constants ── */

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

/* ── Local types ── */

export type MobileTab = 'chat' | 'command' | 'execution' | 'google_chat' | 'tool_panel'
export type ChatMsg = { id: string; role: 'user' | 'assistant'; content: string; timestamp?: string; attachments?: ChatAttachment[] }

/* ── Return type ── */

export interface HubState {
  // Session & routing
  session: ReturnType<typeof useSession>['data']
  router: ReturnType<typeof useRouter>

  // Project / KPI
  activeProject: string
  setActiveProject: React.Dispatch<React.SetStateAction<string>>
  projects: ReturnType<typeof useKPIData>['projects']
  kpiLoading: boolean
  allCompanies: ReturnType<typeof useCompanies>['companies']
  resolveActiveCompany: () => { id: string; name: string; identifier: string } | null

  // Mobile layout
  mobileLeftOpen: boolean
  setMobileLeftOpen: React.Dispatch<React.SetStateAction<boolean>>
  mobileRightOpen: boolean
  setMobileRightOpen: React.Dispatch<React.SetStateAction<boolean>>
  mobileTab: MobileTab
  setMobileTab: React.Dispatch<React.SetStateAction<MobileTab>>

  // Theme
  theme: 'dark' | 'light'
  handleThemeToggle: () => void

  // Onboarding
  showOnboardingCard: boolean
  setShowOnboardingCard: React.Dispatch<React.SetStateAction<boolean>>
  isOnboarding: boolean

  // Google Chat
  chatPanelOpen: boolean
  setChatPanelOpen: React.Dispatch<React.SetStateAction<boolean>>
  chatTotalUnread: number

  // Wizard
  showWizard: boolean
  setShowWizard: React.Dispatch<React.SetStateAction<boolean>>
  wizardOrg: { id: string; name: string } | null
  setWizardOrg: React.Dispatch<React.SetStateAction<{ id: string; name: string } | null>>

  // Role
  userRole: string
  canUseInterviewMode: boolean
  canAccessAdmin: boolean

  // Chat
  messages: ChatMsg[]
  setMessages: React.Dispatch<React.SetStateAction<ChatMsg[]>>
  input: string
  setInput: React.Dispatch<React.SetStateAction<string>>
  isTyping: boolean
  activeModel: string | null
  actionExecuting: boolean
  showScrollBtn: boolean

  // Interview
  interviewState: InterviewState | null
  setInterviewState: React.Dispatch<React.SetStateAction<InterviewState | null>>
  injectedContext: string | null
  setInjectedContext: React.Dispatch<React.SetStateAction<string | null>>
  actionSpec: InterviewState['spec']
  setActionSpec: React.Dispatch<React.SetStateAction<InterviewState['spec']>>

  // Context Sufficiency Score
  contextScore: number | undefined
  contextWeakDim: string | null
  isScoring: boolean

  // Attachments
  attachments: ChatAttachment[]
  setAttachments: React.Dispatch<React.SetStateAction<ChatAttachment[]>>

  // Quoted reply
  quotedReply: { id: string; content: string } | null
  setQuotedReply: React.Dispatch<React.SetStateAction<{ id: string; content: string } | null>>

  // Skills
  activeSkill: ActiveSkill | null
  setActiveSkill: React.Dispatch<React.SetStateAction<ActiveSkill | null>>
  suggestedTools: string[]
  setSuggestedTools: React.Dispatch<React.SetStateAction<string[]>>
  skillsPopoverOpen: boolean
  setSkillsPopoverOpen: React.Dispatch<React.SetStateAction<boolean>>

  // Tool Panel
  toolPanelOpen: boolean
  setToolPanelOpen: React.Dispatch<React.SetStateAction<boolean>>
  toolPanelCollapsed: boolean
  setToolPanelCollapsed: React.Dispatch<React.SetStateAction<boolean>>
  toolArtifacts: ToolArtifactData | null
  setToolArtifacts: React.Dispatch<React.SetStateAction<ToolArtifactData | null>>

  // Auth
  authError: boolean

  // Computed
  chatSuggestions: string[]
  userInitials: string
  onboardingSuggestions: string[]

  // Refs
  messagesEndRef: React.RefObject<HTMLDivElement | null>
  chatMessagesRef: React.RefObject<HTMLDivElement | null>
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  touchStartRef: React.MutableRefObject<{ x: number; y: number } | null>
  swipeDirRef: React.MutableRefObject<'left' | 'right' | null>
  isSwipingRef: React.MutableRefObject<boolean>
  leftPanelRef: React.RefObject<HTMLElement | null>
  rightPanelRef: React.RefObject<HTMLElement | null>
  backdropRef: React.RefObject<HTMLDivElement | null>

  // Handlers
  handleSend: () => void
  handleSuggestion: (suggestion: string) => void
  handleChatInject: (message: string, useCase?: string) => void
  handleSkillActivate: (skillId: string) => void
  handleSkillDeactivate: () => void
  handleSaveToolArtifacts: (artifacts: ToolArtifactData) => Promise<void>
  handleKeyDown: (e: React.KeyboardEvent) => void
  handleTextareaInput: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
  handleMobileTab: (tab: MobileTab) => void
  handleClosePanels: () => void
  handleAddAttachment: (att: Omit<ChatAttachment, 'id'>) => void
  handleRemoveAttachment: (id: string) => void
  handleActionApprove: (spec: ActionSpec) => Promise<void>
  handleTouchStart: (e: React.TouchEvent) => void
  handleTouchMove: (e: React.TouchEvent) => void
  handleTouchEnd: (e: React.TouchEvent) => void
  haptic: (ms?: number) => void
  scrollToBottom: () => void
  doSend: (message: string, msgAttachments?: ChatAttachment[]) => void
  sendToApi: (userMessage: string, allMessages: ChatMsg[], useCase?: string, msgAttachments?: ChatAttachment[]) => Promise<void>
}

/* ══════════════════════════════════════════════════════════════════════════════
   useHubState — Extracted state management hook for HubPage
   ══════════════════════════════════════════════════════════════════════════════ */

export function useHubState(): HubState {
  const { data: session } = useSession()
  const router = useRouter()
  const [activeProject, setActiveProject] = useState('all')
  const { projects, isLoading: kpiLoading } = useKPIData(activeProject)
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

  // Swipe gesture state — real-time drag-follow system
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)
  const swipeDirRef = useRef<'left' | 'right' | null>(null)
  const isSwipingRef = useRef(false)
  const leftPanelRef = useRef<HTMLElement>(null)
  const rightPanelRef = useRef<HTMLElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const SWIPE_COMMIT = 104 // px to commit open/close (~30% more bail room)

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
  const [injectedContext, setInjectedContext] = useState<string | null>(null)
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

  const handleClosePanels = () => {
    setMobileLeftOpen(false)
    setMobileRightOpen(false)
    setChatPanelOpen(false)
    setMobileTab('chat')
  }

  /* ── Swipe gesture handlers — real-time drag-follow ── */
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0]
    const target = e.target as HTMLElement
    // Skip swipe tracking inside the chat interaction zone
    // (suggestions, input area, quoted replies) to allow native text
    // selection, magnifying glass, and horizontal chip scrolling
    if (
      target.closest('.chat-suggestions') ||
      target.closest('.chat-input-area') ||
      target.closest('.quoted-reply-chip')
    ) {
      touchStartRef.current = null
      return
    }
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
                // Server sent an error event — show it to the user
                setMessages(prev =>
                  prev.map(m => m.id === assistantId ? { ...m, content: `⚠️ ${parsed.error}` } : m)
                )
              }
              // Parse suggestedTools metadata from SSE
              if (parsed.suggestedTools && Array.isArray(parsed.suggestedTools)) {
                setSuggestedTools(parsed.suggestedTools)
              }
              // Parse modelUsed event for dynamic badge
              if (parsed.modelUsed) {
                setActiveModel(parsed.modelUsed)
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
      console.error('Chat API Error:', err);
      setIsTyping(false);
      setMessages(prev => [...prev, {
        id: String(Date.now()),
        role: 'assistant' as const,
        content: isTimeout
          ? "⏱️ That took longer than expected. Try asking again — things usually speed up quickly."
          : "Something went wrong on my end. Give it another try in a moment.",
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

    setMessages(prev => {
      const updated = [...prev, newMessage]

      // Check if message triggers interview mode (disabled for onboarding users)
      if (canUseInterviewMode && !interviewState?.active) {
        // Kick off async intent detection without blocking the UI rendering of the user message
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
            sendToApi(fullMessage, updated, activeSkill ? 'deep_dive' : 'deep_dive', msgAttachments)
          }
        }).catch(() => {
          sendToApi(fullMessage, updated, activeSkill ? 'deep_dive' : 'deep_dive', msgAttachments)
        })

        return updated
      }

      // If interview is active, advance it
      if (interviewState?.active && interviewState.intent) {
        const nextState = advanceInterview(interviewState, message)
        setInterviewState(nextState)
        setActiveModel('Claude Fable 5')

        // ── Context Sufficiency Score Gate ──
        // Fire score check asynchronously after every answer so the badge
        // updates in real-time without blocking the UI.
        const intentForScore = nextState.intent ?? interviewState.intent
        const contextForScore = nextState.context
        if (intentForScore) {
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

            // Trust the real-time contextScore and contextWeakDim
            let finalScore = contextScore ?? 80
            let finalWeak: string | null = contextWeakDim
            let followUpQuestion: string | null = null

            // If we already know the score is < 80, handle it directly.
            // If the score is still processing, the Confirm Card UI itself will show a "Validating..." state and block approval until ready.
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

**${followUpQuestion}**`,
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
                  setActionSpec(spec)
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
                setActionSpec(spec)
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
            setActionSpec(spec)
            setMessages(prev => [...prev, {
              id: crypto.randomUUID(),
              role: 'assistant' as const,
              content: '✅ Interview complete! Please review the action below and approve, edit, or cancel.',
              timestamp: new Date().toISOString(),
            }])
          }

          // Show thinking indicator immediately, then run the gate
          const thinkingMsg: ChatMsg = {
            id: crypto.randomUUID(),
            role: 'assistant' as const,
            content: `🧠 **Scoring context quality…** (${isScoring ? 'evaluating' : 'finalizing'})`,
            timestamp: new Date().toISOString(),
          }
          // Run the async gate — we can't await inside setMessages callback,
          // so start it immediately and let it update state
          runQualityGate(nextState.spec)
          return [...updated, thinkingMsg]

        } else {
          const question = getCurrentQuestionWithDefaults(nextState)
          if (question) {
            // Show the next question; score badge will update from the async score fetch above
            const qMsg: ChatMsg = {
              id: crypto.randomUUID(),
              role: 'assistant' as const,
              content: `✦ **${question.question}**${question.defaultValue ? `\n\n_${nextState._editDefaults ? 'Previous answer' : 'Default'}: ${question.defaultValue}_` : ''}`,
              timestamp: new Date().toISOString(),
            }
            return [...updated, qMsg]
          }
        }
        return updated
      }

      // No active interview — always use deep_dive for general chat
      const useCase = 'deep_dive'

      // Reset context score when not in interview mode
      setContextScore(undefined)
      setContextWeakDim(null)

      // No interview — send to Gemini API
      sendToApi(message, updated, useCase, msgAttachments)
      return updated
    })
  }, [interviewState, sendToApi, canUseInterviewMode, quotedReply])

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
          // Route communication requests to the COO in the user's active workspace.
          const activeCompany = resolveActiveCompany()
          if (!activeCompany) throw new Error('No workspace available — please select a project first.')

          const commDetails = spec.details.details || spec.details.description || spec.summary
          const commTo = spec.details.to || spec.details.recipient || ''
          const commChannel = spec.details.channel || spec.details.medium || 'email'
          const commTitle = `Communication Request: ${(commDetails || commTo).slice(0, 80)}`
          const commDesc = [
            `## Communication Request`,
            ``,
            commTo ? `**To:** ${commTo}` : '',
            `**Channel:** ${commChannel}`,
            `**Details:** ${commDetails}`,
            ``,
            `### Directive`,
            `The human operator has requested a communication be sent. COO: compose the message based on the details above and execute delivery via ${commChannel}. Report back with confirmation of what was sent, to whom, and when.`,
          ].filter(Boolean).join('\n')

          // Find the COO agent dynamically in the target workspace
          let commAssigneeId: string | undefined
          try {
            const agentsRes = await fetch(`/api/paperclip/api/companies/${activeCompany.id}/agents`)
            if (agentsRes.ok) {
              const agentsData = await agentsRes.json()
              const agents = Array.isArray(agentsData) ? agentsData : agentsData.agents ?? []
              const coo = agents.find((a: { name: string }) => a.name.toLowerCase().includes('coo') || a.name.toLowerCase().includes('operations'))
              if (coo) commAssigneeId = coo.id
            }
          } catch { /* will fall through to server-side CEO resolution */ }

          const scIssueRes = await fetch('/api/paperclip/issues', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title: commTitle,
              description: commDesc,
              priority: 'high',
              companyId: activeCompany.id,
              ...(commAssigneeId ? { assigneeId: commAssigneeId } : {}),
            }),
          })
          if (!scIssueRes.ok) throw new Error(`Communication issue creation failed: ${scIssueRes.status}`)
          const scIssueData = await scIssueRes.json()
          
          const issueId = scIssueData.issue?.identifier || scIssueData.issue?.id || ''
          const inboxUrl = `${PAPERCLIP_BASE_URL}/${activeCompany.identifier}/inbox/mine`

          resultMsg = `✉️ **Communication Routed to ${commAssigneeId ? 'COO' : 'CEO'} Agent**\n\nIssue **${issueId}** ("${scIssueData.issue?.title || commTitle}") has been created and assigned in the **${activeCompany.name}** workspace.\n\n▶ Track progress in the **Execution Feed** (right panel) or view it directly in your [Paperclip Inbox](${inboxUrl}).`
          mutate('/api/feed')
          break
        }

        case 'create_paperclip_issue': {

          const issueTitle = spec.details.title || spec.summary
          const issueDesc = spec.details.description || ''
          const issuePriority = spec.details.priority || 'medium'
          const issueCompany = resolveActiveCompany()

          const res = await fetch('/api/paperclip/issues', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title: issueTitle,
              description: issueDesc,
              priority: issuePriority,
              ...(issueCompany ? { companyId: issueCompany.id } : {}),
            }),
          })
          if (!res.ok) throw new Error(`Paperclip Issue creation failed: ${res.status}`)
          const data = await res.json()
          
          const issueId = data.issue?.identifier || data.issue?.id || ''
          const issuePrefix = issueCompany?.identifier || 'RXF'
          const inboxUrl = `${PAPERCLIP_BASE_URL}/${issuePrefix}/inbox/mine`
          
          resultMsg = `✅ **Agent Triggered!**\n\nIssue **${issueId}** ("${data.issue?.title || issueTitle}") has been assigned to the CEO Agent in **${issueCompany?.name || 'your workspace'}**.\n\n▶ Track progress in the **Execution Feed** (right panel) or view it directly in your [Paperclip Inbox](${inboxUrl}).`
          
          // Force refresh the Right Panel feed immediately
          mutate('/api/feed')
          break
        }

        case 'check_agent_status': {
          // Fetch agent status from all companies
          const companiesRes = await fetch('/api/paperclip/api/companies')
          if (!companiesRes.ok) throw new Error(`Failed to fetch companies: ${companiesRes.status}`)
          const companiesData = await companiesRes.json()
          const companies = Array.isArray(companiesData) ? companiesData : companiesData.companies ?? []

          const targetProject = spec.details.project?.toLowerCase()
          const targetCompanies = targetProject === 'all'
            ? companies
            : companies.filter((c: { name: string }) => c.name.toLowerCase().includes(targetProject || ''))

          const agentStatusParts: string[] = []
          for (const company of targetCompanies.slice(0, 5)) {
            try {
              const agentsRes = await fetch(`/api/paperclip/api/companies/${company.id}/agents`)
              if (!agentsRes.ok) continue
              const agentsData = await agentsRes.json()
              const agents = agentsData.agents ?? []
              const lines = agents.map((a: { name: string; status: string }) =>
                `  • **${a.name}** — ${a.status === 'active' ? '🟢' : a.status === 'error' ? '🔴' : '⚪'} ${a.status}`
              )
              agentStatusParts.push(`**${company.name}** (${agents.length} agents):\n${lines.join('\n')}`)
            } catch { /* skip */ }
          }

          resultMsg = agentStatusParts.length > 0
            ? `📊 **Agent Status Report**\n\n${agentStatusParts.join('\n\n')}`
            : '⚠️ No agents found or Paperclip is unavailable.'
          break
        }

        case 'view_runs': {
          const companiesRes = await fetch('/api/paperclip/api/companies')
          if (!companiesRes.ok) throw new Error('Failed to fetch companies')
          const companiesData = await companiesRes.json()
          const companies = Array.isArray(companiesData) ? companiesData : companiesData.companies ?? []

          const targetProject = spec.details.project?.toLowerCase()
          const targetCompanies = targetProject === 'all'
            ? companies
            : companies.filter((c: { name: string }) => c.name.toLowerCase().includes(targetProject || ''))

          const runParts: string[] = []
          for (const company of targetCompanies.slice(0, 5)) {
            try {
              const runsRes = await fetch(`/api/paperclip/api/companies/${company.id}/runs?limit=10`)
              if (!runsRes.ok) continue
              const runsData = await runsRes.json()
              const runs = runsData.runs ?? []
              if (runs.length === 0) continue
              const lines = runs.map((r: { agentName: string; status: string; issueIdentifier: string; durationMs: number | null }) =>
                `  • **${r.agentName}** → ${r.issueIdentifier} — ${r.status === 'completed' ? '✅' : r.status === 'failed' ? '❌' : '⏳'} ${r.status}${r.durationMs ? ` (${(r.durationMs / 1000).toFixed(1)}s)` : ''}`
              )
              runParts.push(`**${company.name}**:\n${lines.join('\n')}`)
            } catch { /* skip */ }
          }

          resultMsg = runParts.length > 0
            ? `📋 **Recent Runs**\n\n${runParts.join('\n\n')}`
            : '⚠️ No recent runs found.'
          break
        }

        case 'assign_issue': {
          // Resolve issue and agent, then PATCH the assignment
          const aiCompaniesRes = await fetch('/api/paperclip/api/companies')
          if (!aiCompaniesRes.ok) throw new Error('Failed to fetch companies')
          const aiCompaniesData = await aiCompaniesRes.json()
          const aiCompanies = Array.isArray(aiCompaniesData) ? aiCompaniesData : aiCompaniesData.companies ?? []

          const issueRef = (spec.details.issueRef || '').toLowerCase()
          const agentRef = (spec.details.agent || '').toLowerCase()
          let foundIssue: { id: string; title: string; companyId: string } | null = null
          let foundAgent: { id: string; name: string } | null = null

          for (const company of aiCompanies) {
            try {
              const [issuesRes, agentsRes] = await Promise.all([
                fetch(`/api/paperclip/api/companies/${company.id}/issues?limit=50`),
                fetch(`/api/paperclip/api/companies/${company.id}/agents`),
              ])
              if (issuesRes.ok && !foundIssue) {
                const issData = await issuesRes.json()
                const issues = issData.issues ?? []
                const match = issues.find((i: { identifier: string; title: string }) =>
                  i.identifier?.toLowerCase().includes(issueRef) ||
                  i.title?.toLowerCase().includes(issueRef)
                )
                if (match) foundIssue = { id: match.id, title: match.title, companyId: company.id }
              }
              if (agentsRes.ok && !foundAgent) {
                const agData = await agentsRes.json()
                const agents = agData.agents ?? []
                const match = agents.find((a: { name: string }) =>
                  a.name?.toLowerCase().includes(agentRef)
                )
                if (match) foundAgent = { id: match.id, name: match.name }
              }
            } catch { /* skip */ }
          }

          if (!foundIssue) throw new Error(`Could not find issue matching "${spec.details.issueRef}"`)
          if (!foundAgent) throw new Error(`Could not find agent matching "${spec.details.agent}"`)

          const assignRes = await fetch(`/api/paperclip/api/companies/${foundIssue.companyId}/issues/${foundIssue.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assigneeAgentId: foundAgent.id }),
          })
          if (!assignRes.ok) throw new Error(`Failed to reassign issue: ${assignRes.status}`)

          resultMsg = `✅ **Issue Reassigned**\n\n"${foundIssue.title}" has been assigned to **${foundAgent.name}**.`
          mutate('/api/feed')
          break
        }

        case 'update_issue_state': {
          // Resolve issue, then PATCH the status
          const usCompaniesRes = await fetch('/api/paperclip/api/companies')
          if (!usCompaniesRes.ok) throw new Error('Failed to fetch companies')
          const usCompaniesData = await usCompaniesRes.json()
          const usCompanies = Array.isArray(usCompaniesData) ? usCompaniesData : usCompaniesData.companies ?? []

          const usIssueRef = (spec.details.issueRef || '').toLowerCase()
          let usFoundIssue: { id: string; title: string; companyId: string } | null = null

          for (const company of usCompanies) {
            try {
              const issuesRes = await fetch(`/api/paperclip/api/companies/${company.id}/issues?limit=50`)
              if (!issuesRes.ok) continue
              const issData = await issuesRes.json()
              const issues = issData.issues ?? []
              const match = issues.find((i: { identifier: string; title: string }) =>
                i.identifier?.toLowerCase().includes(usIssueRef) ||
                i.title?.toLowerCase().includes(usIssueRef)
              )
              if (match) {
                usFoundIssue = { id: match.id, title: match.title, companyId: company.id }
                break
              }
            } catch { /* skip */ }
          }

          if (!usFoundIssue) throw new Error(`Could not find issue matching "${spec.details.issueRef}"`)

          // Map user-friendly state names to Paperclip status values
          const stateMap: Record<string, string> = {
            'open': 'todo', 'todo': 'todo',
            'in-progress': 'in_progress', 'in progress': 'in_progress', 'started': 'in_progress',
            'done': 'done', 'complete': 'done', 'completed': 'done',
            'cancelled': 'cancelled', 'canceled': 'cancelled',
          }
          const rawState = (spec.details.newState || '').toLowerCase()
          const mappedStatus = stateMap[rawState] || rawState

          const stateRes = await fetch(`/api/paperclip/api/companies/${usFoundIssue.companyId}/issues/${usFoundIssue.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: mappedStatus }),
          })
          if (!stateRes.ok) throw new Error(`Failed to update issue state: ${stateRes.status}`)

          resultMsg = `✅ **Issue Updated**\n\n"${usFoundIssue.title}" state changed to **${spec.details.newState}**.`
          mutate('/api/feed')
          break
        }

        case 'create_agent': {
          // CEO-ROUTED: Create an Issue for the CEO to provision the agent
          const companiesRes = await fetch('/api/paperclip/api/companies')
          if (!companiesRes.ok) throw new Error('Failed to fetch companies')
          const companiesData = await companiesRes.json()
          const companies = Array.isArray(companiesData) ? companiesData : companiesData.companies ?? []
          const targetName = spec.details.project?.toLowerCase() || ''
          const company = companies.find((c: { name: string }) => c.name.toLowerCase().includes(targetName))
          if (!company) throw new Error(`Workspace "${spec.details.project}" not found`)

          // Get the CEO agent ID
          const agentsRes = await fetch(`/api/paperclip/api/companies/${company.id}/agents`)
          const agentsData = agentsRes.ok ? await agentsRes.json() : { agents: [] }
          const agents = agentsData.agents ?? []
          const ceoAgent = agents.find((a: { name: string }) => a.name.toLowerCase().includes('ceo'))

          const issueTitle = `Provision Agent: ${spec.details.agentName}`
          const issueDesc = [
            `## Agent Provisioning Request`,
            ``,
            `**Requested Agent:** ${spec.details.agentName}`,
            `**Role/Instructions:** ${spec.details.instructions}`,
            `**Workspace:** ${company.name}`,
            ``,
            `### Directive`,
            `The human operator has requested a new agent role. CEO: evaluate whether this role is needed, determine the appropriate adapter and instructions, and provision the agent.`,
          ].join('\n')

          const issueRes = await fetch('/api/paperclip/issues', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title: issueTitle,
              description: issueDesc,
              priority: 'high',
              companyId: company.id,
              assigneeId: ceoAgent?.id || undefined,
            }),
          })
          if (!issueRes.ok) throw new Error(`Issue creation failed: ${issueRes.status}`)
          const issueData = await issueRes.json()
          resultMsg = `🧠 **CEO Briefed**\n\nIssue "${issueData.issue?.title || issueTitle}" has been created and assigned to the CEO Agent in **${company.name}**.\n\nThe CEO will evaluate the request and provision the agent. Track progress in the Execution Feed.`
          mutate('/api/feed')
          break
        }

        case 'launch_campaign': {
          // CEO-ROUTED: Create a campaign-level Issue for the CEO
          const companiesRes = await fetch('/api/paperclip/api/companies')
          if (!companiesRes.ok) throw new Error('Failed to fetch companies')
          const companiesData = await companiesRes.json()
          const companies = Array.isArray(companiesData) ? companiesData : companiesData.companies ?? []
          const targetName = spec.details.project?.toLowerCase() || ''
          const company = companies.find((c: { name: string }) => c.name.toLowerCase().includes(targetName))
          if (!company) throw new Error(`Workspace "${spec.details.project}" not found`)

          // Get the CEO agent ID
          const agentsRes = await fetch(`/api/paperclip/api/companies/${company.id}/agents`)
          const agentsData = agentsRes.ok ? await agentsRes.json() : { agents: [] }
          const agents = agentsData.agents ?? []
          const ceoAgent = agents.find((a: { name: string }) => a.name.toLowerCase().includes('ceo'))

          const suggestedRoles = spec.details.suggestedRoles || 'CEO to determine'
          const constraints = spec.details.constraints || 'None specified'

          const issueTitle = `Campaign: ${spec.details.campaignGoal?.slice(0, 80) || 'New Campaign'}`
          const issueDesc = [
            `## Campaign Launch Request`,
            ``,
            `**Campaign Goal:** ${spec.details.campaignGoal}`,
            `**Suggested Agent Roles:** ${suggestedRoles}`,
            `**Constraints:** ${constraints}`,
            `**Workspace:** ${company.name}`,
            ``,
            `### Directive`,
            `The human operator has requested a multi-agent campaign. CEO: determine the optimal agent structure, provision the necessary agents, assign sub-tasks, and coordinate delivery. You have full authority to create, modify, or reassign agents as needed.`,
          ].join('\n')

          const issueRes = await fetch('/api/paperclip/issues', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title: issueTitle,
              description: issueDesc,
              priority: 'high',
              companyId: company.id,
              assigneeId: ceoAgent?.id || undefined,
            }),
          })
          if (!issueRes.ok) throw new Error(`Campaign issue creation failed: ${issueRes.status}`)
          const issueData = await issueRes.json()
          resultMsg = `🚀 **Campaign Briefed to CEO**\n\nIssue "${issueData.issue?.title || issueTitle}" has been created and assigned to the CEO Agent in **${company.name}**.\n\nThe CEO will determine the agent structure, provision the necessary roles, and coordinate the campaign. Track progress in the Execution Feed.`
          mutate('/api/feed')
          break
        }

        case 'restart_agent': {
          // Resolve the agent by name, then PATCH status to idle
          const raCompaniesRes = await fetch('/api/paperclip/api/companies')
          if (!raCompaniesRes.ok) throw new Error('Failed to fetch companies')
          const raCompaniesData = await raCompaniesRes.json()
          const raCompanies = Array.isArray(raCompaniesData) ? raCompaniesData : raCompaniesData.companies ?? []

          const raProjectRef = (spec.details.project || '').toLowerCase()
          const raAgentRef = (spec.details.agent || '').toLowerCase()
          const raTargetCompanies = raProjectRef === 'all'
            ? raCompanies
            : raCompanies.filter((c: { name: string }) => c.name.toLowerCase().includes(raProjectRef))

          let raFoundAgent: { id: string; name: string; companyId: string } | null = null
          for (const company of raTargetCompanies) {
            try {
              const agentsRes = await fetch(`/api/paperclip/api/companies/${company.id}/agents`)
              if (!agentsRes.ok) continue
              const agData = await agentsRes.json()
              const agents = agData.agents ?? []
              const match = agents.find((a: { name: string }) =>
                a.name?.toLowerCase().includes(raAgentRef)
              )
              if (match) {
                raFoundAgent = { id: match.id, name: match.name, companyId: company.id }
                break
              }
            } catch { /* skip */ }
          }

          if (!raFoundAgent) throw new Error(`Could not find agent matching "${spec.details.agent}" in "${spec.details.project}"`)

          const raRes = await fetch(`/api/paperclip/api/companies/${raFoundAgent.companyId}/agents/${raFoundAgent.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'idle' }),
          })
          if (!raRes.ok) throw new Error(`Failed to restart agent: ${raRes.status}`)

          resultMsg = `✅ **Agent Restarted**\n\n"${raFoundAgent.name}" in **${spec.details.project}** has been reset to idle and is ready for new tasks.`
          break
        }

        case 'run_audit': {
          // Fetch data and display as inline audit
          const companiesRes = await fetch('/api/paperclip/api/companies')
          if (!companiesRes.ok) throw new Error('Failed to fetch companies')
          const companiesData = await companiesRes.json()
          const companies = Array.isArray(companiesData) ? companiesData : companiesData.companies ?? []

          const auditParts: string[] = []
          for (const company of companies.slice(0, 5)) {
            try {
              const [agentsRes, issuesRes] = await Promise.all([
                fetch(`/api/paperclip/api/companies/${company.id}/agents`),
                fetch(`/api/paperclip/api/companies/${company.id}/issues?limit=100`),
              ])
              const agents = agentsRes.ok ? (await agentsRes.json()).agents ?? [] : []
              const issues = issuesRes.ok ? (await issuesRes.json()).issues ?? [] : []
              
              const healthy = agents.filter((a: { status: string }) => a.status === 'active').length
              const errored = agents.filter((a: { status: string }) => a.status === 'error').length
              const openIssues = issues.filter((i: { state: { group: string } }) => i.state?.group !== 'completed' && i.state?.group !== 'cancelled').length
              
              auditParts.push(
                `**${company.name}**\n` +
                `  • Agents: ${agents.length} (${healthy} healthy, ${errored} errored)\n` +
                `  • Issues: ${issues.length} total, ${openIssues} open\n` +
                `  • Health: ${errored === 0 ? '🟢 Healthy' : errored > agents.length / 2 ? '🔴 Critical' : '🟡 At Risk'}`
              )
            } catch { /* skip */ }
          }

          resultMsg = `🔬 **Audit Report**\n\n${auditParts.join('\n\n')}`
          break
        }

        case 'create_workspace': {
          const res = await fetch('/api/admin/workspaces', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              companyName: spec.details.name,
              issuePrefix: spec.details.issuePrefix || spec.details.name?.slice(0, 3).toUpperCase() || 'NEW',
              brandColor: spec.details.brandColor || '#C5A059',
              agentTemplate: spec.details.template || 'csuite',
            }),
          })
          if (!res.ok) throw new Error(`Workspace creation failed: ${res.status}`)
          const data = await res.json()
          resultMsg = `✅ **Workspace Created**\n\n"${data.companyName || spec.details.name}" [${data.issuePrefix || spec.details.issuePrefix}] has been provisioned with ${spec.details.template === 'ceo-only' ? 'a CEO agent' : 'the full C-Suite (CEO, CMO, CTO, CFO, COO)'}.\n\n🔄 The project dropdown has been updated.`
          mutate('/api/companies')  // Instant dropdown refresh
          mutate('/api/feed')
          break
        }

        case 'delete_workspace': {
          // Verify type-to-confirm matched
          if (spec.details.confirmName?.toLowerCase() !== spec.details.name?.toLowerCase()) {
            resultMsg = `❌ **Deletion cancelled.** The confirmation name didn't match. You typed "${spec.details.confirmName}" but the workspace is "${spec.details.name}".`
            break
          }

          // Resolve workspace by name then DELETE
          const dwCompaniesRes = await fetch('/api/paperclip/api/companies')
          if (!dwCompaniesRes.ok) throw new Error('Failed to fetch companies')
          const dwCompaniesData = await dwCompaniesRes.json()
          const dwCompanies = Array.isArray(dwCompaniesData) ? dwCompaniesData : dwCompaniesData.companies ?? []
          const dwMatch = dwCompanies.find((c: { name: string }) =>
            c.name.toLowerCase() === spec.details.name?.toLowerCase()
          )
          if (!dwMatch) throw new Error(`Workspace "${spec.details.name}" not found`)

          const dwRes = await fetch(`/api/paperclip/api/companies/${dwMatch.id}`, {
            method: 'DELETE',
          })
          if (!dwRes.ok) throw new Error(`Workspace deletion failed: ${dwRes.status}`)

          resultMsg = `🗑️ **Workspace Deleted**\n\n"${spec.details.name}" and all its agents, issues, and data have been permanently removed.\n\n🔄 The project dropdown has been updated.`
          mutate('/api/companies')  // Instant dropdown refresh
          mutate('/api/feed')
          break
        }

        case 'delete_agent': {
          // Verify type-to-confirm matched
          if (spec.details.confirmName?.toLowerCase() !== spec.details.agent?.toLowerCase()) {
            resultMsg = `❌ **Deletion cancelled.** The confirmation name didn't match. You typed "${spec.details.confirmName}" but the agent is "${spec.details.agent}".`
            break
          }

          // Resolve agent by name then DELETE
          const daCompaniesRes = await fetch('/api/paperclip/api/companies')
          if (!daCompaniesRes.ok) throw new Error('Failed to fetch companies')
          const daCompaniesData = await daCompaniesRes.json()
          const daCompanies = Array.isArray(daCompaniesData) ? daCompaniesData : daCompaniesData.companies ?? []

          const daProjectRef = (spec.details.project || '').toLowerCase()
          const daAgentRef = (spec.details.agent || '').toLowerCase()
          let daFoundAgent: { id: string; name: string; companyId: string } | null = null

          for (const company of daCompanies) {
            if (daProjectRef && !company.name.toLowerCase().includes(daProjectRef)) continue
            try {
              const agentsRes = await fetch(`/api/paperclip/api/companies/${company.id}/agents`)
              if (!agentsRes.ok) continue
              const agData = await agentsRes.json()
              const agents = agData.agents ?? []
              const match = agents.find((a: { name: string }) =>
                a.name?.toLowerCase().includes(daAgentRef)
              )
              if (match) {
                daFoundAgent = { id: match.id, name: match.name, companyId: company.id }
                break
              }
            } catch { /* skip */ }
          }

          if (!daFoundAgent) throw new Error(`Could not find agent matching "${spec.details.agent}"`)

          const daRes = await fetch(`/api/paperclip/api/companies/${daFoundAgent.companyId}/agents/${daFoundAgent.id}`, {
            method: 'DELETE',
          })
          if (!daRes.ok) throw new Error(`Agent deletion failed: ${daRes.status}`)

          resultMsg = `🗑️ **Agent Deleted**\n\n"${daFoundAgent.name}" has been permanently removed from **${spec.details.project}**.`
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

  return {
    // Session & routing
    session,
    router,

    // Project / KPI
    activeProject,
    setActiveProject,
    projects,
    kpiLoading,
    allCompanies,
    resolveActiveCompany,

    // Mobile layout
    mobileLeftOpen,
    setMobileLeftOpen,
    mobileRightOpen,
    setMobileRightOpen,
    mobileTab,
    setMobileTab,

    // Theme
    theme,
    handleThemeToggle,

    // Onboarding
    showOnboardingCard,
    setShowOnboardingCard,
    isOnboarding,

    // Google Chat
    chatPanelOpen,
    setChatPanelOpen,
    chatTotalUnread,

    // Wizard
    showWizard,
    setShowWizard,
    wizardOrg,
    setWizardOrg,

    // Role
    userRole,
    canUseInterviewMode,
    canAccessAdmin,

    // Chat
    messages,
    setMessages,
    input,
    setInput,
    isTyping,
    activeModel,
    actionExecuting,
    showScrollBtn,

    // Interview
    interviewState,
    setInterviewState,
    injectedContext,
    setInjectedContext,
    actionSpec,
    setActionSpec,

    // Context Sufficiency Score
    contextScore,
    contextWeakDim,
    isScoring,

    // Attachments
    attachments,
    setAttachments,

    // Quoted reply
    quotedReply,
    setQuotedReply,

    // Skills
    activeSkill,
    setActiveSkill,
    suggestedTools,
    setSuggestedTools,
    skillsPopoverOpen,
    setSkillsPopoverOpen,

    // Tool Panel
    toolPanelOpen,
    setToolPanelOpen,
    toolPanelCollapsed,
    setToolPanelCollapsed,
    toolArtifacts,
    setToolArtifacts,

    // Auth
    authError,

    // Computed
    chatSuggestions,
    userInitials,
    onboardingSuggestions: ONBOARDING_SUGGESTIONS,

    // Refs
    messagesEndRef,
    chatMessagesRef,
    textareaRef,
    touchStartRef,
    swipeDirRef,
    isSwipingRef,
    leftPanelRef,
    rightPanelRef,
    backdropRef,

    // Handlers
    handleSend,
    handleSuggestion,
    handleChatInject,
    handleSkillActivate,
    handleSkillDeactivate,
    handleSaveToolArtifacts,
    handleKeyDown,
    handleTextareaInput,
    handleMobileTab,
    handleClosePanels,
    handleAddAttachment,
    handleRemoveAttachment,
    handleActionApprove,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
    haptic,
    scrollToBottom,
    doSend,
    sendToApi,
  }
}
