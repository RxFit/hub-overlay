'use client'

import { useState, useRef, useEffect, useCallback, useMemo, Fragment } from 'react'

/* ══════════════════════════════════════════════════════════════════════════════
   MOCK DATA — Real project names from Paperclip orchestration
   ══════════════════════════════════════════════════════════════════════════════ */

const PROJECTS = [
  { id: 'rxfit',      name: 'RxFit',      abbr: 'RX', color: '#C5A059' },
  { id: 'fridgesnap', name: 'FridgeSnap', abbr: 'FS', color: '#4A6FA5' },
  { id: 'jadecoss',   name: 'JadeCoS',    abbr: 'JC', color: '#8a6e3e' },
  { id: 'wellnessapp',name: 'WellnessApp',abbr: 'WA', color: '#d4b572' },
  { id: 'notebookrx', name: 'NotebookRx', abbr: 'NR', color: '#9aa8c6' },
  { id: 'seo-agent',  name: 'SEO Agent',  abbr: 'SE', color: '#ef4444' },
]

const KPI_DATA = [
  { label: 'Revenue MTD', value: '$124,500', trend: '+12.4%', up: true },
  { label: 'Active Clients', value: '47', trend: '+3', up: true },
  { label: 'Agent Tasks', value: '18', trend: 'In Progress', up: true },
  { label: 'Open Issues', value: '34', trend: '-8 this week', up: true },
]

const GOALS = [
  { title: 'Q2 Revenue Target — $380K', progress: 72, status: 'on-track' as const },
  { title: 'Client Retention Rate > 94%', progress: 91, status: 'on-track' as const },
  { title: 'FridgeSnap Beta Launch', progress: 45, status: 'at-risk' as const },
  { title: 'SEO Domain Authority > 35', progress: 60, status: 'on-track' as const },
  { title: 'JadeCoS Payment Integration', progress: 28, status: 'behind' as const },
]

const ISSUES = [
  { id: 'RXF-42', title: 'Client onboarding flow drops at step 3', priority: 'urgent' as const, status: 'In Progress', agent: 'CEO Agent', time: '2h ago' },
  { id: 'SNA-18', title: 'Recipe API rate limiting hitting 429s in prod', priority: 'high' as const, status: 'In Review', agent: 'Technical', time: '4h ago' },
  { id: 'CHI-7', title: 'Jade payment webhook failing for Stripe Connect', priority: 'high' as const, status: 'Todo', agent: 'Unassigned', time: '6h ago' },
  { id: 'RXF-39', title: 'Monthly performance report template automation', priority: 'medium' as const, status: 'In Progress', agent: 'COO Agent', time: '1d ago' },
  { id: 'APP-12', title: 'Wellness dashboard missing HRV data sync', priority: 'medium' as const, status: 'Todo', agent: 'Technical', time: '1d ago' },
  { id: 'SEO-5', title: 'Blog post optimization for "executive fitness Austin"', priority: 'low' as const, status: 'Done', agent: 'SEO Agent', time: '2d ago' },
  { id: 'RXN-9', title: 'NotebookRx export to PDF formatting broken', priority: 'medium' as const, status: 'In Progress', agent: 'Technical', time: '3d ago' },
  { id: 'SNA-22', title: 'FridgeSnap camera module crash on Android 14', priority: 'high' as const, status: 'In Review', agent: 'Technical', time: '3d ago' },
]

const AGENT_RUNS = [
  { agent: 'RxFit CEO Agent', issue: 'RXF-42', status: 'running' as const, duration: '12m', model: 'Gemini 2.5 Pro' },
  { agent: 'FridgeSnap Technical', issue: 'SNA-18', status: 'running' as const, duration: '8m', model: 'Claude Opus 4.7' },
  { agent: 'RxFit COO Agent', issue: 'RXF-39', status: 'completed' as const, duration: '34m', model: 'Gemini 2.5 Pro' },
  { agent: 'SEO Agent Marketing', issue: 'SEO-5', status: 'completed' as const, duration: '22m', model: 'GPT-5' },
  { agent: 'JadeCoS Technical', issue: 'CHI-7', status: 'failed' as const, duration: '3m', model: 'Claude Opus 4.7' },
  { agent: 'NotebookRx Technical', issue: 'RXN-9', status: 'completed' as const, duration: '18m', model: 'Gemini 2.5 Flash' },
]

const INITIAL_MESSAGES = [
  {
    id: '1',
    role: 'assistant' as const,
    content: "Welcome to CT Hub. I have context on all 6 active projects and their current agent activity.\n\nHere's your morning briefing:\n• **RxFit**: CEO agent is resolving client onboarding drop-off (RXF-42)\n• **FridgeSnap**: API rate limiting issue escalated to In Review\n• **JadeCoS**: Payment webhook is failing — needs attention\n• **SEO**: Domain authority campaign on track (+4 this month)\n\nWhat would you like to dig into?",
  },
]

const CHAT_SUGGESTIONS = [
  "What's blocking FridgeSnap revenue?",
  "Summarize today's agent activity",
  "Show Q2 goal status",
  "Create a task for the team",
]

/* ══════════════════════════════════════════════════════════════════════════════
   SIMULATED CHAT RESPONSES
   ══════════════════════════════════════════════════════════════════════════════ */

const SIMULATED_RESPONSES: Record<string, string> = {
  "What's blocking FridgeSnap revenue?": `Based on the current execution data, there are **two blockers** on FridgeSnap revenue:\n\n1. **SNA-18: API Rate Limiting** — The recipe API is hitting 429 errors in production, which directly impacts the user experience. The Technical agent has this in review, but it's been 4 hours without resolution.\n\n2. **SNA-22: Android 14 Camera Crash** — FridgeSnap's core value prop (snap → recipe) is broken for ~34% of Android users. This is in review but hasn't shipped.\n\n**Recommended actions:**\n• Escalate SNA-18 to urgent priority\n• Get an ETA from the Technical agent on the Android fix\n• Consider a hotfix deploy for the rate limiting issue today`,

  "Summarize today's agent activity": `**Today's Agent Activity Summary**\n\n| Agent | Status | Issue | Duration |\n|-------|--------|-------|----------|\n| RxFit CEO | 🟢 Running | RXF-42 | 12m |\n| FridgeSnap Technical | 🟢 Running | SNA-18 | 8m |\n| RxFit COO | ✅ Done | RXF-39 | 34m |\n| SEO Marketing | ✅ Done | SEO-5 | 22m |\n| JadeCoS Technical | 🔴 Failed | CHI-7 | 3m |\n| NotebookRx Technical | ✅ Done | RXN-9 | 18m |\n\n**Highlight:** JadeCoS Technical agent failed on CHI-7 (payment webhook). This needs manual review — the Stripe Connect integration may require API key rotation.`,

  "Show Q2 goal status": `**Q2 2026 — Goal Tracking**\n\n🟢 **Revenue Target ($380K)** — 72% complete ($274K collected)\nOn pace. FridgeSnap subscription revenue growing 18% MoM.\n\n🟢 **Client Retention > 94%** — Currently at 96.2%\nExceeding target. Zero churn in May so far.\n\n🟡 **FridgeSnap Beta Launch** — 45% complete\nAt risk. Android crash bug (SNA-22) blocking public beta. ETA slipped from June 1 → June 12.\n\n🟢 **SEO DA > 35** — Currently at 32 (60% to goal)\nOn track. 4 blog posts published this month driving organic traffic.\n\n🔴 **JadeCoS Payment Integration** — 28% complete\nBehind schedule. Stripe Connect webhook failures are blocking QA. Need a dedicated sprint.`,
}

const GRILL_RESPONSE = `🔥 **Interview Mode Activated**\n\nI need to understand this task fully before we create it. Let me walk through a few questions:\n\n**Question 1 of 5:**\nWhat specific outcome should this task produce? Not what needs to be done — what does "done" look like?`

/* ══════════════════════════════════════════════════════════════════════════════
   COMPONENTS
   ══════════════════════════════════════════════════════════════════════════════ */

function AnimatedNumber({ value, delay = 0 }: { value: string; delay?: number }) {
  const [visible, setVisible] = useState(false)
  const [displayed, setDisplayed] = useState('0')
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), delay)
    return () => clearTimeout(t)
  }, [delay])
  // Animate numeric-looking values by counting up
  useEffect(() => {
    if (!visible) return
    const numMatch = value.match(/^(\$?)(\d[\d,]*)(.*)$/)
    if (!numMatch) { setDisplayed(value); return }
    const prefix = numMatch[1]
    const rawNum = parseInt(numMatch[2].replace(/,/g, ''), 10)
    const suffix = numMatch[3]
    if (isNaN(rawNum) || rawNum === 0) { setDisplayed(value); return }
    let start = 0
    const duration = 900
    const startTime = performance.now()
    const tick = (now: number) => {
      const elapsed = now - startTime
      const progress = Math.min(elapsed / duration, 1)
      // Ease out cubic
      const eased = 1 - Math.pow(1 - progress, 3)
      const current = Math.round(eased * rawNum)
      const formatted = prefix + current.toLocaleString() + suffix
      setDisplayed(formatted)
      if (progress < 1) requestAnimationFrame(tick)
      else setDisplayed(value)
    }
    requestAnimationFrame(tick)
  }, [visible, value])
  return (
    <span
      aria-label={value}
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(8px)',
        transition: 'opacity 0.4s cubic-bezier(0.16, 1, 0.3, 1), transform 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
        display: 'inline-block',
      }}
    >
      {displayed}
    </span>
  )
}

/* ── Header ── */
function HubHeader({ activeProject, onProjectChange, theme, onThemeToggle }: {
  activeProject: string
  onProjectChange: (id: string) => void
  theme: 'dark' | 'light'
  onThemeToggle: () => void
}) {
  return (
    <header className="hub-header" role="banner">
      <div className="hub-logo">
        <h1 className="hub-logo-text rx-shimmer">
          <span className="hub-logo-accent">CT</span> HUB
        </h1>
        <span className="hub-logo-badge">ops</span>
      </div>

      <nav className="header-actions" aria-label="Hub controls">
        <label htmlFor="project-selector" className="sr-only">Select project</label>
        <select
          id="project-selector"
          value={activeProject}
          onChange={e => onProjectChange(e.target.value)}
          aria-label="Select project"
          className="project-selector"
        >
          <option value="all">All Projects</option>
          {PROJECTS.map(p => (
            <option key={p.id} value={p.id}>[{p.abbr}] {p.name}</option>
          ))}
        </select>

        <a
          href="https://hub.casatrejo.com"
          target="_blank"
          rel="noopener noreferrer"
          className="power-view-btn"
          aria-label="Open Power View in new tab"
        >
          Power View <span className="rx-arrow">→</span>
        </a>

        <button
          className="theme-toggle-btn"
          onClick={onThemeToggle}
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
        >
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>

        <div className="header-user" role="button" tabIndex={0} aria-label="User menu for Danny">
          <div className="header-avatar" aria-hidden="true">DT</div>
          <span className="header-username">Danny</span>
        </div>
      </nav>
    </header>
  )
}

/* ── Left Panel: Command Center ── */
function LeftPanel({ isOpen, onClose }: { isOpen?: boolean; onClose?: () => void }) {
  return (
    <aside className={`panel-left ${isOpen ? 'mobile-open' : ''}`} aria-label="Command Center">
      <div className="panel-header">
        <h2 className="panel-title">
          <span className="rx-comment-label">01 //</span>
          <span className="panel-title-display">Command Center</span>
        </h2>
        {onClose && (
          <button className="panel-close-btn" onClick={onClose} aria-label="Close Command Center">
            &times;
          </button>
        )}
      </div>

      <div className="panel-content">
        {/* KPI Grid */}
        <div className="kpi-grid" role="list" aria-label="Key performance indicators">
          {KPI_DATA.map((kpi, i) => (
            <div key={kpi.label} className="kpi-card" role="listitem">
              <div className="kpi-label">{kpi.label}</div>
              <div className="kpi-value">
                <AnimatedNumber value={kpi.value} delay={i * 120} />
              </div>
              <div className={`kpi-trend ${kpi.up ? 'kpi-trend-up' : 'kpi-trend-down'}`} aria-label={`Trend: ${kpi.up ? 'up' : 'down'} ${kpi.trend}`}>
                <span aria-hidden="true" className="rx-star">✦</span> {kpi.trend}
              </div>
            </div>
          ))}
        </div>

        {/* Project Health */}
        <h3 className="section-label">Project Health</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }} role="list" aria-label="Project health status">
          {PROJECTS.map(p => {
            const healthStatus = p.id === 'jadecoss' ? 'critical' : p.id === 'fridgesnap' ? 'at risk' : 'healthy'
            const statusColor = p.id === 'jadecoss' ? 'var(--danger)' : p.id === 'fridgesnap' ? 'var(--warn)' : 'var(--accent)'
            return (
              <div
                key={p.id}
                role="listitem"
                tabIndex={0}
                aria-label={`${p.name}: ${healthStatus}`}
                className="project-health-item"
              >
                {/* Color-coded monogram circle replaces emoji */}
                <span
                  aria-hidden="true"
                  style={{
                    width: '22px',
                    height: '22px',
                    borderRadius: '6px',
                    background: `${p.color}1a`,
                    border: `1px solid ${p.color}44`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.55rem',
                    fontWeight: 700,
                    color: p.color,
                    letterSpacing: '0.02em',
                    flexShrink: 0,
                  }}
                >
                  {p.abbr}
                </span>
                <span style={{ flex: 1 }}>{p.name}</span>
                <span
                  aria-hidden="true"
                  className="project-status-pulse"
                  style={{
                    width: '7px',
                    height: '7px',
                    borderRadius: '50%',
                    background: statusColor,
                    boxShadow: `0 0 6px ${statusColor}`,
                    flexShrink: 0,
                  }}
                />
              </div>
            )
          })}
        </div>

        {/* Q2 Goals */}
        <h3 className="section-label">Q2 Objectives</h3>
        <div role="list" aria-label="Quarterly objectives">
          {GOALS.map((goal) => (
            <div key={goal.title} className="goal-item" role="listitem">
              <span className={`goal-status-dot ${goal.status}`} aria-hidden="true" />
              <div style={{ flex: 1 }}>
                <div className="goal-text">{goal.title}</div>
                <div
                  className="goal-progress-bar"
                  role="progressbar"
                  aria-valuenow={goal.progress}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`${goal.title}: ${goal.progress}% complete`}
                >
                  <div
                    className="goal-progress-fill"
                    style={{
                      width: `${goal.progress}%`,
                      background: goal.status === 'behind' ? 'var(--danger)' : goal.status === 'at-risk' ? 'var(--warn)' : undefined,
                    }}
                  />
                </div>
                <div style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.65rem',
                  color: 'var(--text-muted)',
                  marginTop: '2px',
                }}>
                  {goal.progress}%
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </aside>
  )
}

/* ── Center Panel: AI Chat ── */
function CenterPanel() {
  const [messages, setMessages] = useState<Array<{ id: string; role: 'user' | 'assistant'; content: string }>>(INITIAL_MESSAGES)
  const [input, setInput] = useState('')
  const [isTyping, setIsTyping] = useState(false)
  const [grillActive, setGrillActive] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  useEffect(() => { scrollToBottom() }, [messages, scrollToBottom])

  const sendToApi = useCallback(async (userMessage: string, allMessages: Array<{ id: string; role: 'user' | 'assistant'; content: string }>) => {
    setIsTyping(true)

    // Check for task creation intent → activate grill mode
    const taskIntent = /\b(create|add|make|need to|let'?s|we should|i want to)\b/i.test(userMessage)

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

      if (taskIntent) setGrillActive(true)
      return // Success — no fallback needed
    } catch {
      // API unavailable — fall back to mock responses
      setIsTyping(true)
      const responseText = taskIntent
        ? GRILL_RESPONSE
        : SIMULATED_RESPONSES[userMessage] || `I'll look into that. Based on the current project data across your 6 active workspaces, here's what I can tell you:\n\nThe query "${userMessage}" touches multiple departments. Let me pull the relevant execution data and agent activity to give you a comprehensive answer.\n\n*This is a demo — in production, I'll query Paperclip's API and your intelligence nodes in real-time.*`

      setTimeout(() => {
        setIsTyping(false)
        if (taskIntent) setGrillActive(true)
        setMessages(prev => [...prev, {
          id: String(Date.now()),
          role: 'assistant' as const,
          content: responseText,
        }])
      }, 1200 + Math.random() * 800)
    }
  }, [])

  const handleSend = useCallback(() => {
    const msg = input.trim()
    if (!msg) return

    const newMessage = {
      id: String(Date.now()),
      role: 'user' as const,
      content: msg,
    }
    const updatedMessages = [...messages, newMessage]
    setMessages(updatedMessages)
    setInput('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'

    sendToApi(msg, updatedMessages)
  }, [input, messages, sendToApi])

  const handleSuggestion = useCallback((suggestion: string) => {
    const newMessage = {
      id: String(Date.now()),
      role: 'user' as const,
      content: suggestion,
    }
    const updatedMessages = [...messages, newMessage]
    setMessages(updatedMessages)
    sendToApi(suggestion, updatedMessages)
  }, [messages, sendToApi])

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

  return (
    <main className="panel-center" aria-label="AI Chat">
      <div className="chat-container">
        {/* Chat Header */}
        <div className="chat-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span className="panel-title-dot" aria-hidden="true" />
            <h2 style={{
              fontFamily: 'var(--font-display)',
              fontSize: '0.95rem',
              fontWeight: 800,
              color: 'var(--text-primary)',
              margin: 0,
              letterSpacing: '-0.02em',
            }}>
              <span aria-hidden="true">✦ </span>AI Assistant
            </h2>
            <span style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.6rem',
              color: 'var(--text-muted)',
              background: 'var(--bg-elevated)',
              padding: '2px 6px',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border)',
            }}>
              Gemini 2.5
            </span>
          </div>
        </div>

        {/* Grill-me banner */}
        {grillActive && (
          <div className="grill-mode-banner" role="alert">
            <span className="grill-mode-banner-icon" aria-hidden="true">🔥</span>
            <span><strong>Interview Mode</strong> — Task creation requires full specification before submission</span>
          </div>
        )}

        {/* Messages */}
        <div className="chat-messages" role="log" aria-label="Chat messages" aria-live="polite">
          {messages.map(msg => (
            <div key={msg.id} className={`chat-message ${msg.role === 'user' ? 'chat-message-user' : ''}`}>
              <div
                className={`chat-message-avatar ${msg.role === 'user' ? 'chat-message-avatar-user' : 'chat-message-avatar-ai'}`}
                aria-hidden="true"
              >
                {msg.role === 'user' ? 'DT' : '✦'}
              </div>
              <div className={`chat-bubble ${msg.role === 'user' ? 'chat-bubble-user' : 'chat-bubble-ai'}`}>
                <MessageContent content={msg.content} />
              </div>
            </div>
          ))}

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
        </div>

        {/* Suggestion chips (shown when chat is fresh) */}
        {messages.length <= 1 && (
          <div className="chat-suggestions" role="group" aria-label="Suggested prompts">
            {CHAT_SUGGESTIONS.map(s => (
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
          <div className="chat-input-wrapper">
            <textarea
              ref={textareaRef}
              className="chat-input"
              aria-label="Chat message input"
              placeholder={grillActive ? "Answer the interview question..." : "Ask about your projects, create tasks, check status..."}
              value={input}
              onChange={handleTextareaInput}
              onKeyDown={handleKeyDown}
              rows={1}
            />
            <button
              className="chat-send-btn"
              onClick={handleSend}
              disabled={!input.trim() || isTyping}
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
          if (cells.every(c => /^[\s-]+$/.test(c))) return <Fragment key={i} /> // separator line
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
function RightPanel({ isOpen, onClose }: { isOpen?: boolean; onClose?: () => void }) {
  const [activeTab, setActiveTab] = useState<'inbox' | 'runs' | 'orgs'>('inbox')

  return (
    <aside className={`panel-right ${isOpen ? 'mobile-open' : ''}`} aria-label="Execution Layer">
      <div className="panel-header">
        <h2 className="panel-title">
          <span className="rx-comment-label">02 //</span>
          <span className="panel-title-display">Execution Layer</span>
        </h2>
        {onClose && (
          <button className="panel-close-btn" onClick={onClose} aria-label="Close Execution Layer">
            &times;
          </button>
        )}
      </div>

      <div className="tab-bar" role="tablist" aria-label="Execution tabs">
        {(['inbox', 'runs', 'orgs'] as const).map(tab => (
          <button
            key={tab}
            role="tab"
            aria-selected={activeTab === tab}
            aria-controls={`tabpanel-${tab}`}
            className={`tab-btn ${activeTab === tab ? 'active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab === 'inbox' ? `Inbox (${ISSUES.length})` : tab === 'runs' ? 'Agent Runs' : 'Orgs'}
          </button>
        ))}
      </div>

      <div
        id={`tabpanel-${activeTab}`}
        role="tabpanel"
        aria-label={`${activeTab} panel`}
        style={{ flex: 1, overflow: 'auto' }}
      >
        {activeTab === 'inbox' && <IssueInbox />}
        {activeTab === 'runs' && <AgentRunFeed />}
        {activeTab === 'orgs' && <OrgList />}
      </div>
    </aside>
  )
}

function IssueInbox() {
  return (
    <div role="list" aria-label="Issue inbox">
      {ISSUES.map(issue => (
        <div key={issue.id} className="issue-item" role="listitem" aria-label={`${issue.id}: ${issue.title}, ${issue.priority} priority, ${issue.status}`}>
          <span className={`issue-priority-dot ${issue.priority}`} aria-hidden="true" title={`${issue.priority} priority`} />
          <div className="issue-content">
            <div className="issue-title">{issue.title}</div>
            <div className="issue-meta">
              <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 500 }}>{issue.id}</span>
              <span aria-hidden="true">•</span>
              <StatusBadge status={issue.status} />
              <span aria-hidden="true">•</span>
              <span>{issue.time}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const cls = status.toLowerCase().replace(/\s+/g, '-')
  const classMap: Record<string, string> = {
    'todo': 'todo',
    'in-progress': 'in-progress',
    'in-review': 'in-review',
    'done': 'done',
  }
  return (
    <span className={`issue-status-badge ${classMap[cls] || 'todo'}`}>
      {status}
    </span>
  )
}

function AgentRunFeed() {
  return (
    <div role="list" aria-label="Agent runs">
      {AGENT_RUNS.map((run) => (
        <div key={`${run.agent}-${run.issue}`} className="agent-run-item" role="listitem">
          <span className={`agent-run-status ${run.status}`} />
          <div className="agent-run-info">
            <div className="agent-run-name">{run.agent}</div>
            <div className="agent-run-detail">
              {run.issue} · {run.duration} · {run.model}
            </div>
          </div>
          <span style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.6rem',
            padding: '2px 6px',
            borderRadius: 'var(--radius-sm)',
            background: run.status === 'running' ? 'rgba(197,160,89,0.1)' : run.status === 'failed' ? 'rgba(239,68,68,0.1)' : 'rgba(255,255,255,0.03)',
            color: run.status === 'running' ? 'var(--accent)' : run.status === 'failed' ? 'var(--danger)' : 'var(--text-muted)',
            textTransform: 'uppercase',
          }}>
            {run.status}
          </span>
        </div>
      ))}
    </div>
  )
}

const ORGS = [
  { name: 'RxFit Revenue', members: 3, issues: 12 },
  { name: 'RxFit Technical', members: 2, issues: 8 },
  { name: 'RxFit - Organic Growth Marketing', members: 2, issues: 5 },
  { name: 'CEO - RxFit', members: 1, issues: 4 },
  { name: 'COO - RxFit', members: 1, issues: 3 },
  { name: 'FridgeSnap Technical', members: 2, issues: 7 },
  { name: 'FridgeSnap Revenue', members: 1, issues: 4 },
  { name: 'FridgeSnap - Marketing', members: 1, issues: 3 },
  { name: 'JadeCoS Technical', members: 2, issues: 6 },
  { name: 'JadeCoS Revenue', members: 1, issues: 2 },
  { name: 'JadeCoS - Marketing', members: 1, issues: 2 },
  { name: 'Wellness Technical', members: 2, issues: 5 },
  { name: 'NotebookRx Technical', members: 1, issues: 4 },
  { name: 'SEO Agent Technical', members: 1, issues: 3 },
]

function OrgList() {
  return (
    <div role="list" aria-label="Organizations">
      {ORGS.map((org) => (
        <div key={org.name} className="issue-item" role="listitem">
          <span
            aria-hidden="true"
            style={{
              width: '28px',
              height: '28px',
              borderRadius: 'var(--radius-md)',
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '0.7rem',
              color: 'var(--text-muted)',
              fontFamily: 'var(--font-mono)',
              flexShrink: 0,
            }}
          >
            {org.name.split(' ').map(w => w[0]).slice(0, 2).join('')}
          </span>
          <div className="issue-content">
            <div className="issue-title">{org.name}</div>
            <div className="issue-meta">
              <span>{org.members} members</span>
              <span aria-hidden="true">•</span>
              <span>{org.issues} issues</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════════════════
   MAIN PAGE
   ══════════════════════════════════════════════════════════════════════════════ */

type MobileTab = 'chat' | 'command' | 'execution'

export default function HubPage() {
  const [activeProject, setActiveProject] = useState('all')
  const [mobileLeftOpen, setMobileLeftOpen] = useState(false)
  const [mobileRightOpen, setMobileRightOpen] = useState(false)
  const [mobileTab, setMobileTab] = useState<MobileTab>('chat')
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')

  // Initialize theme from localStorage and apply to <html>
  useEffect(() => {
    const saved = (typeof window !== 'undefined' && localStorage.getItem('rx-hub-theme')) as 'dark' | 'light' | null
    const initial = saved || 'dark'
    setTheme(initial)
    document.documentElement.setAttribute('data-theme', initial)
  }, [])

  const handleThemeToggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    document.documentElement.setAttribute('data-theme', next)
    localStorage.setItem('rx-hub-theme', next)
  }

  const handleMobileTab = (tab: MobileTab) => {
    setMobileTab(tab)
    if (tab === 'command') {
      setMobileLeftOpen(true)
      setMobileRightOpen(false)
    } else if (tab === 'execution') {
      setMobileRightOpen(true)
      setMobileLeftOpen(false)
    } else {
      setMobileLeftOpen(false)
      setMobileRightOpen(false)
    }
  }

  const handleClosePanels = () => {
    setMobileLeftOpen(false)
    setMobileRightOpen(false)
    setMobileTab('chat')
  }

  return (
    <div className="hub-shell">
      <HubHeader
        activeProject={activeProject}
        onProjectChange={setActiveProject}
        theme={theme}
        onThemeToggle={handleThemeToggle}
      />

      {/* Tablet: control bar (shown only between 641px–1024px) */}
      <div className="mobile-control-bar">
        <button
          className="mobile-control-btn"
          onClick={() => { setMobileLeftOpen(true); setMobileRightOpen(false) }}
          aria-label="Open Command Center"
        >
          <span style={{ color: 'var(--accent)', marginRight: '6px', fontFamily: 'var(--font-mono)' }}>01 //</span> Command
        </button>
        <button
          className="mobile-control-btn"
          onClick={() => { setMobileRightOpen(true); setMobileLeftOpen(false) }}
          aria-label="Open Execution Layer"
        >
          <span style={{ color: 'var(--accent)', marginRight: '6px', fontFamily: 'var(--font-mono)' }}>02 //</span> Execution
        </button>
      </div>

      <div className="panels-container">
        <LeftPanel isOpen={mobileLeftOpen} onClose={handleClosePanels} />
        <CenterPanel />
        <RightPanel isOpen={mobileRightOpen} onClose={handleClosePanels} />
      </div>

      {/* Mobile: Glassmorphism Bottom Navigation Bar */}
      <nav className="mobile-bottom-nav" aria-label="Mobile navigation">
        <button
          className={`mobile-nav-btn ${mobileTab === 'chat' ? 'active' : ''}`}
          onClick={() => handleMobileTab('chat')}
          aria-label="AI Chat"
          aria-pressed={mobileTab === 'chat'}
        >
          <span className="mobile-nav-icon" aria-hidden="true" style={{ fontFamily: 'var(--font-body)', fontSize: '1.1rem', letterSpacing: '-0.02em' }}>✦</span>
          <span className="mobile-nav-label">AI Chat</span>
        </button>
        <button
          className={`mobile-nav-btn ${mobileTab === 'command' ? 'active' : ''}`}
          onClick={() => handleMobileTab('command')}
          aria-label="Command Center"
          aria-pressed={mobileTab === 'command'}
        >
          <span className="mobile-nav-icon" aria-hidden="true" style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', fontWeight: 700, letterSpacing: '0.02em' }}>01//</span>
          <span className="mobile-nav-label">Command</span>
        </button>
        <button
          className={`mobile-nav-btn ${mobileTab === 'execution' ? 'active' : ''}`}
          onClick={() => handleMobileTab('execution')}
          aria-label="Execution Layer"
          aria-pressed={mobileTab === 'execution'}
        >
          <span className="mobile-nav-icon" aria-hidden="true" style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', fontWeight: 700, letterSpacing: '0.02em' }}>02//</span>
          <span className="mobile-nav-label">Execution</span>
        </button>
      </nav>

      {/* Backdrop (tablet + mobile) */}
      {(mobileLeftOpen || mobileRightOpen) && (
        <div
          className="mobile-backdrop"
          onClick={handleClosePanels}
          aria-hidden="true"
        />
      )}
    </div>
  )
}
