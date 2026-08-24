'use client'

import { useState, useEffect, useCallback, Suspense } from 'react'
import type { ActiveSkill, ToolArtifactData, ToolContextCard } from '@/types'
import { TOOL_PANEL_MAP } from './panels'

/* ══════════════════════════════════════════════════════════════════════════════
   TOOL PANEL — Right-side contextual workflow panel
   
   Auto-opens when a skill is activated. Provides:
   - AI-generated context card summarizing the pre-activation conversation
   - Hybrid prompts (static tool-specific + dynamic contextual)
   - Live artifact workspace rendered by tool-specific panel components
   - Save & Close to persist artifacts to Postgres + pgvector
   ══════════════════════════════════════════════════════════════════════════════ */

interface ToolPanelProps {
  activeSkill: ActiveSkill
  messages: Array<{ id: string; role: 'user' | 'assistant'; content: string }>
  onDismiss: () => void
  onInjectChat: (msg: string) => void
  onSaveArtifacts: (artifacts: ToolArtifactData) => Promise<void>
  isCollapsed: boolean
  onToggleCollapse: () => void
  /** Live conversation id, threaded through to panels that attach work to
   *  the chat (the deep-run panels). */
  chatId?: string | null
}

/** Static fallback prompts per tool when no context is available */
const FALLBACK_PROMPTS: Record<string, string[]> = {
  'issue-tree': ['Define the governing question', 'Set a target metric', 'List any constraints'],
  'decision-memo': ['What decision needs to be made?', 'Who is the reader?', 'What are the options?'],
  'prioritization': ['List the items to prioritize', 'Choose a scoring framework', 'Set the time horizon'],
  'data-insights': ['Upload or paste your data', 'What question are you trying to answer?'],
  'meeting-prep': ['Who is attending?', 'What\'s the desired outcome?', 'How long is the meeting?'],
  'storyline': ['Who is the audience?', 'What decision do you need?', 'How many slides?'],
  'scpr': ['Describe the situation', 'What\'s the complication?', 'What do you promise?'],
  'mckinsey-critic': ['Paste the document to review', 'Who is the audience?', 'What\'s the goal?'],
  'ai-use-case-scorer': ['List your AI use cases', 'What are your goals?', 'What risks concern you?'],
  'deck-pipeline': ['What\'s the topic?', 'Who\'s the audience?', 'What decision do you need?'],
  'gamma-deck': ['Provide a storyline', 'Choose a theme', 'Set the tone'],
}

export function ToolPanel({
  activeSkill,
  messages,
  onDismiss,
  onInjectChat,
  onSaveArtifacts,
  isCollapsed,
  onToggleCollapse,
  chatId,
}: ToolPanelProps) {
  const [contextCard, setContextCard] = useState<ToolContextCard | null>(null)
  const [contextLoading, setContextLoading] = useState(true)
  const [artifacts, setArtifacts] = useState<ToolArtifactData | null>(null)
  const [saving, setSaving] = useState(false)

  /* ── Fetch context card on mount ── */
  useEffect(() => {
    let cancelled = false
    setContextLoading(true)
    setContextCard(null)

    const recentMessages = messages.slice(-10).map(m => ({
      role: m.role,
      content: m.content.slice(0, 500), // Truncate for speed
    }))

    fetch('/api/tool-context', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolId: activeSkill.id, recentMessages }),
    })
      .then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return r.json()
    })
      .then(data => {
        if (!cancelled && data.contextCard) {
          setContextCard(data.contextCard)
        }
      })
      .catch(() => {
        /* Fail silently — fallback prompts will show */
      })
      .finally(() => {
        if (!cancelled) setContextLoading(false)
      })

    return () => { cancelled = true }
  }, [activeSkill.id]) // Only re-fetch when tool changes, not on every message

  /* ── Artifact update handler ── */
  const handleArtifactUpdate = useCallback((data: ToolArtifactData) => {
    setArtifacts(data)
  }, [])

  /* ── Save & Close ── */
  const handleSaveAndClose = useCallback(async () => {
    if (saving) return // Prevent double-click
    if (!artifacts) {
      onDismiss()
      return
    }
    setSaving(true)
    try {
      await onSaveArtifacts(artifacts)
    } catch {
      /* Fail silently — artifacts remain in memory */
    } finally {
      setSaving(false)
      onDismiss()
    }
  }, [artifacts, onDismiss, onSaveArtifacts])

  /* ── Get prompts (hybrid: contextual + static) ── */
  const rawPrompts = [
    ...(contextCard?.suggestedPrompts || []),
    ...(FALLBACK_PROMPTS[activeSkill.id] || []),
  ]
  const prompts = [...new Set(rawPrompts)].slice(0, 6)

  /* ── Resolve tool-specific panel component ── */
  const PanelContent = TOOL_PANEL_MAP[activeSkill.id]

  if (isCollapsed) return null // Collapsed rail handles its own render

  return (
    <aside
      className="tool-panel"
      aria-label={`${activeSkill.name} Tool Panel`}
      role="complementary"
    >
      {/* ── Header ── */}
      <div className="tool-panel__header">
        <div className="tool-panel__header-info">
          <span className="tool-panel__icon" aria-hidden="true">⚡</span>
          <div>
            <div className="tool-panel__title">{activeSkill.name}</div>
            <div className="tool-panel__plugin">
              {activeSkill.plugin === 'enterprise-ai' ? 'Enterprise AI' : 'GStack'}
            </div>
          </div>
        </div>
        <div className="tool-panel__header-actions">
          <button
            className="tool-panel__collapse-btn"
            onClick={onToggleCollapse}
            aria-label="Collapse tool panel"
            title="Collapse"
          >
            ⟫
          </button>
          <button
            className="tool-panel__close-btn"
            onClick={handleSaveAndClose}
            aria-label="Save and close tool panel"
            title={artifacts ? 'Save & Close' : 'Close'}
          >
            {saving ? '…' : '✕'}
          </button>
        </div>
      </div>

      {/* ── Context Card ── */}
      <div className="tool-panel__context">
        {contextLoading ? (
          <div className="tool-panel__context-loading">
            <div className="tool-panel__context-skeleton" />
            <div className="tool-panel__context-skeleton tool-panel__context-skeleton--short" />
          </div>
        ) : contextCard?.summary ? (
          <div className="tool-panel__context-card">
            <span className="tool-panel__context-label">Context</span>
            <p className="tool-panel__context-summary">{contextCard.summary}</p>
            {contextCard.keyEntities.length > 0 && (
              <div className="tool-panel__context-entities">
                {contextCard.keyEntities.map((entity, i) => (
                  <span key={i} className="tool-panel__entity-chip">{entity}</span>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="tool-panel__context-card">
            <span className="tool-panel__context-label">Context</span>
            <p className="tool-panel__context-summary" style={{ fontStyle: 'italic' }}>
              Start chatting to build context for this tool.
            </p>
          </div>
        )}
      </div>

      {/* ── Prompt Chips ── */}
      {prompts.length > 0 && (
        <div className="tool-panel__prompts">
          <span className="tool-panel__prompts-label">Suggested</span>
          <div className="tool-panel__prompt-chips">
            {prompts.map((prompt, i) => (
              <button
                key={i}
                className="tool-panel__prompt-chip"
                onClick={() => onInjectChat(prompt)}
                aria-label={`Send: ${prompt}`}
              >
                {prompt}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Artifact Workspace ── */}
      <div className="tool-panel__workspace">
        {PanelContent ? (
          <Suspense fallback={
            <div className="tool-panel__loading">Loading panel…</div>
          }>
            <PanelContent
              toolId={activeSkill.id}
              contextSummary={contextCard?.summary || null}
              messages={messages}
              onInjectChat={onInjectChat}
              onArtifactUpdate={handleArtifactUpdate}
              artifacts={artifacts}
              chatId={chatId}
            />
          </Suspense>
        ) : (
          <div className="tool-panel__generic">
            <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
              Chat with the AI to generate {activeSkill.name} artifacts.
              They will appear here as structured cards.
            </p>
          </div>
        )}
      </div>

      {/* ── Footer ── */}
      {artifacts && artifacts.sections.length > 0 && (
        <div className="tool-panel__footer">
          <span className="tool-panel__artifact-count">
            {artifacts.sections.length} artifact{artifacts.sections.length !== 1 ? 's' : ''}
          </span>
          <button
            className="tool-panel__save-btn"
            onClick={handleSaveAndClose}
            disabled={saving}
          >
            {saving ? 'Saving…' : '💾 Save & Close'}
          </button>
        </div>
      )}
    </aside>
  )
}
