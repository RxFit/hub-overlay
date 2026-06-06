'use client'

import { useEffect } from 'react'
import type { ToolPanelContentProps, ToolArtifactSection } from '@/types'

const PROMPTS = [
  'What decision needs to be made?',
  'Who is the reader?',
  'What are the options?',
]

function parseMessages(messages: ToolPanelContentProps['messages']): ToolArtifactSection[] {
  const sections: ToolArtifactSection[] = []
  const assistantMsgs = messages.filter(m => m.role === 'assistant')

  for (const msg of assistantMsgs) {
    /* Pro items */
    const proMatches = Array.from(msg.content.matchAll(/Pro(?:\s*\d*):\s*(.+)/gi))
    for (const m of proMatches) {
      sections.push({ id: `pro-${sections.length}`, type: 'pro', title: 'Pro', content: m[1].trim() })
    }
    /* Con items */
    const conMatches = Array.from(msg.content.matchAll(/Con(?:\s*\d*):\s*(.+)/gi))
    for (const m of conMatches) {
      sections.push({ id: `con-${sections.length}`, type: 'con', title: 'Con', content: m[1].trim() })
    }
    /* Recommendation */
    const recMatch = msg.content.match(/Recommendation:\s*(.+?)(?:\n|$)/i)
    if (recMatch) {
      sections.push({ id: 'rec', type: 'recommendation', title: 'Recommendation', content: recMatch[1].trim(), status: 'recommended' })
    }
    /* Risk assessment */
    const riskMatches = Array.from(msg.content.matchAll(/Risk(?:\s*\d*):\s*(.+)/gi))
    for (const m of riskMatches) {
      sections.push({ id: `risk-${sections.length}`, type: 'generic', title: 'Risk', content: m[1].trim(), status: 'warning' })
    }
  }
  return sections
}

export default function DecisionMemoPanel({ messages, onInjectChat, onArtifactUpdate, artifacts }: ToolPanelContentProps) {
  useEffect(() => {
    const sections = parseMessages(messages)
    if (sections.length > 0) {
      onArtifactUpdate({ toolId: 'decision-memo', title: 'Decision Memo', sections })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, onArtifactUpdate])

  const sections = artifacts?.sections ?? []
  const pros = sections.filter(s => s.type === 'pro')
  const cons = sections.filter(s => s.type === 'con')
  const rec = sections.find(s => s.type === 'recommendation')
  const risks = sections.filter(s => s.title === 'Risk')

  const cardBase: React.CSSProperties = {
    borderRadius: 'var(--radius-md)',
    padding: 'var(--space-2) var(--space-3)',
    marginBottom: '6px',
    fontSize: '0.8rem',
  }

  return (
    <div className="decision-memo-panel" role="region" aria-label="Decision Memo Panel">
      {/* Prompt chips */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', marginBottom: 'var(--space-4)' }}>
        {PROMPTS.map(p => (
          <button
            key={p}
            onClick={() => onInjectChat(p)}
            aria-label={`Suggest: ${p}`}
            style={{
              background: 'var(--glass-bg)',
              border: '1px solid var(--glass-border)',
              borderRadius: 'var(--radius-md)',
              padding: '6px var(--space-3)',
              color: 'var(--accent)',
              cursor: 'pointer',
              fontSize: '0.8rem',
            }}
          >
            {p}
          </button>
        ))}
      </div>

      {/* Recommendation card */}
      {rec && (
        <div
          className="decision-memo-panel__recommendation"
          style={{
            background: 'rgba(197,160,89,0.1)',
            border: '1.5px solid var(--accent)',
            borderRadius: 'var(--radius-lg)',
            padding: 'var(--space-3)',
            marginBottom: 'var(--space-3)',
            color: 'var(--text-primary)',
            fontSize: '0.85rem',
            fontWeight: 600,
          }}
        >
          ★ {rec.content}
        </div>
      )}

      {/* Two-column pro/con layout */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)', marginBottom: 'var(--space-3)' }}>
        <div>
          <h4 style={{ color: '#48bb78', fontSize: '0.75rem', fontWeight: 700, margin: '0 0 var(--space-2)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Pros</h4>
          {pros.map(p => (
            <div key={p.id} className="decision-memo-panel__pro-card" style={{ ...cardBase, background: 'rgba(72,187,120,0.08)', border: '1px solid rgba(72,187,120,0.2)', color: 'var(--text-secondary)' }}>
              {p.content}
            </div>
          ))}
          {pros.length === 0 && <p style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>No pros yet</p>}
        </div>
        <div>
          <h4 style={{ color: '#fc8181', fontSize: '0.75rem', fontWeight: 700, margin: '0 0 var(--space-2)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Cons</h4>
          {cons.map(c => (
            <div key={c.id} className="decision-memo-panel__con-card" style={{ ...cardBase, background: 'rgba(252,129,129,0.08)', border: '1px solid rgba(252,129,129,0.2)', color: 'var(--text-secondary)' }}>
              {c.content}
            </div>
          ))}
          {cons.length === 0 && <p style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>No cons yet</p>}
        </div>
      </div>

      {/* Risk badges */}
      {risks.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          {risks.map(r => (
            <span
              key={r.id}
              className="decision-memo-panel__risk-badge"
              style={{
                background: 'rgba(237,137,54,0.12)',
                color: '#ed8936',
                borderRadius: 'var(--radius-md)',
                padding: '3px var(--space-2)',
                fontSize: '0.7rem',
                fontWeight: 600,
              }}
            >
              ⚠ {r.content}
            </span>
          ))}
        </div>
      )}

      {sections.length === 0 && (
        <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', textAlign: 'center', padding: 'var(--space-4)' }}>
          Start by describing the decision that needs to be made.
        </p>
      )}
    </div>
  )
}
