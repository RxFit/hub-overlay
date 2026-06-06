'use client'

import { useEffect } from 'react'
import type { ToolPanelContentProps, ToolArtifactSection } from '@/types'

const PROMPTS = [
  'List your AI use cases',
  'What are your personal goals?',
  'What risks concern you?',
]

const TIER_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  'do-now': { label: 'Do Now',  color: 'var(--accent)',    bg: 'rgba(197,160,89,0.1)' },
  'park':   { label: 'Park',    color: 'var(--text-muted)', bg: 'rgba(160,174,192,0.08)' },
  'avoid':  { label: 'Avoid',   color: '#fc8181',          bg: 'rgba(252,129,129,0.08)' },
}

function classifyTier(content: string): string {
  if (/do now|proceed|high priority/i.test(content)) return 'do-now'
  if (/avoid|reject|do not|unsafe/i.test(content)) return 'avoid'
  return 'park'
}

function parseMessages(messages: ToolPanelContentProps['messages']): ToolArtifactSection[] {
  const sections: ToolArtifactSection[] = []
  const assistantMsgs = messages.filter(m => m.role === 'assistant')

  for (const msg of assistantMsgs) {
    /* Use Case: Name — Value: 4 — Feasibility: 3 — Safety: 5 — Tier: Do Now */
    const ucMatches = Array.from(msg.content.matchAll(/Use Case(?:\s*\d*):\s*(.+?)(?:\s*[-—]\s*Value:\s*(\d))?(?:\s*[-—]\s*Feasibility:\s*(\d))?(?:\s*[-—]\s*Safety:\s*(\d))?(?:\s*[-—]\s*Tier:\s*(.+?))?(?:\n|$)/gi))
    for (const m of ucMatches) {
      const title = m[1].trim()
      const value = m[2] ? parseInt(m[2], 10) : undefined
      const feasibility = m[3] ? parseInt(m[3], 10) : undefined
      const safety = m[4] ? parseInt(m[4], 10) : undefined
      const tier = m[5]?.trim() || ''
      const totalScore = value && feasibility && safety ? Math.round((value + feasibility + safety) / 3 * 20) : undefined
      sections.push({
        id: `uc-${sections.length}`,
        type: 'score',
        title,
        content: JSON.stringify({ value, feasibility, safety, tier }),
        score: totalScore,
        status: /do now|proceed/i.test(tier) ? 'recommended' : /avoid/i.test(tier) ? 'warning' : 'active',
      })
    }
  }
  return sections
}

export default function AIUseCaseScorerPanel({ messages, onInjectChat, onArtifactUpdate, artifacts }: ToolPanelContentProps) {
  useEffect(() => {
    const sections = parseMessages(messages)
    if (sections.length > 0) {
      onArtifactUpdate({ toolId: 'ai-use-case-scorer', title: 'AI Use Case Scorer', sections })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, onArtifactUpdate])

  const items = artifacts?.sections ?? []
  const grouped: Record<string, typeof items> = { 'do-now': [], 'park': [], 'avoid': [] }
  for (const item of items) {
    let dims: Record<string, string> = {}
    try { dims = JSON.parse(item.content) } catch { /* content isn't JSON, classify from raw text */ }
    const tier = dims.tier ? classifyTier(dims.tier) : classifyTier(item.content)
    grouped[tier].push(item)
  }

  return (
    <div className="ai-use-case-scorer-panel" role="region" aria-label="AI Use Case Scorer Panel">
      {/* Prompt chips */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', marginBottom: 'var(--space-4)' }}>
        {PROMPTS.map(p => (
          <button key={p} onClick={() => onInjectChat(p)} aria-label={`Suggest: ${p}`}
            style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)', borderRadius: 'var(--radius-md)', padding: '6px var(--space-3)', color: 'var(--accent)', cursor: 'pointer', fontSize: '0.8rem' }}>
            {p}
          </button>
        ))}
      </div>

      {/* Tiered groups */}
      {Object.entries(TIER_CONFIG).map(([key, cfg]) => {
        const tierItems = grouped[key]
        if (!tierItems || tierItems.length === 0) return null
        return (
          <div key={key} style={{ marginBottom: 'var(--space-3)' }}>
            <h4 style={{ color: cfg.color, fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 var(--space-2)' }}>{cfg.label}</h4>
            {tierItems.map(item => {
              let dims: { value?: number; feasibility?: number; safety?: number } = {}
              try { dims = JSON.parse(item.content) } catch { /* use defaults */ }
              return (
                <div key={item.id} className="ai-use-case-scorer-panel__card" style={{
                  background: cfg.bg, border: `1px solid ${cfg.color}33`,
                  borderRadius: 'var(--radius-md)', padding: 'var(--space-2) var(--space-3)', marginBottom: '6px',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ color: 'var(--text-primary)', fontSize: '0.8rem', fontWeight: 600 }}>{item.title}</span>
                    {item.score !== undefined && (
                      <span style={{ background: cfg.color, color: '#1a1a2e', borderRadius: '999px', padding: '2px 8px', fontSize: '0.65rem', fontWeight: 700 }}>{item.score}</span>
                    )}
                  </div>
                  {(dims.value || dims.feasibility || dims.safety) && (
                    <div style={{ display: 'flex', gap: 'var(--space-3)', marginTop: '4px' }}>
                      {dims.value !== undefined && <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Val: {dims.value}/5</span>}
                      {dims.feasibility !== undefined && <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Feas: {dims.feasibility}/5</span>}
                      {dims.safety !== undefined && <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Safe: {dims.safety}/5</span>}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )
      })}

      {items.length === 0 && (
        <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', textAlign: 'center', padding: 'var(--space-4)' }}>
          List your AI use cases to begin Value × Feasibility × Safety scoring.
        </p>
      )}
    </div>
  )
}
