'use client'

import { useEffect } from 'react'
import type { ToolPanelContentProps, ToolArtifactSection } from '@/types'

const PROMPTS = [
  'Describe the situation',
  "What's the complication?",
  'What do you promise?',
]

const QUADRANT_META: Record<string, { label: string; color: string; bg: string }> = {
  situation:     { label: 'Situation',     color: '#63b3ed', bg: 'rgba(99,179,237,0.08)' },
  complication:  { label: 'Complication',  color: '#ed8936', bg: 'rgba(237,137,54,0.08)' },
  promise:       { label: 'Promise',       color: '#48bb78', bg: 'rgba(72,187,120,0.08)' },
  resolution:    { label: 'Resolution',    color: 'var(--accent)', bg: 'rgba(197,160,89,0.1)' },
}

function parseMessages(messages: ToolPanelContentProps['messages']): ToolArtifactSection[] {
  const sections: ToolArtifactSection[] = []
  const assistantMsgs = messages.filter(m => m.role === 'assistant')

  for (const msg of assistantMsgs) {
    for (const key of Object.keys(QUADRANT_META)) {
      const regex = new RegExp(`${key}:\\s*(.+?)(?=(?:situation|complication|promise|resolution|Gap Analysis):|$)`, 'gis')
      const match = regex.exec(msg.content)
      if (match) {
        sections.push({ id: key, type: 'narrative', title: QUADRANT_META[key].label, content: match[1].trim() })
      }
    }
    /* Gap analysis badges */
    const gapMatches = Array.from(msg.content.matchAll(/Gap(?:\s*\d*):\s*(.+?)(?:\n|$)/gi))
    for (const m of gapMatches) {
      sections.push({ id: `gap-${sections.length}`, type: 'generic', title: 'Gap', content: m[1].trim(), status: 'warning' })
    }
  }
  return sections
}

export default function SCPRPanel({ messages, onInjectChat, onArtifactUpdate, artifacts }: ToolPanelContentProps) {
  useEffect(() => {
    const sections = parseMessages(messages)
    if (sections.length > 0) {
      onArtifactUpdate({ toolId: 'scpr', title: 'SCPR Framework', sections })
    }
  }, [messages, onArtifactUpdate])

  const sections = artifacts?.sections ?? []
  const quadrants = sections.filter(s => s.type === 'narrative')
  const gaps = sections.filter(s => s.title === 'Gap')

  return (
    <div className="scpr-panel" role="region" aria-label="SCPR Panel">
      {/* Prompt chips */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', marginBottom: 'var(--space-4)' }}>
        {PROMPTS.map(p => (
          <button key={p} onClick={() => onInjectChat(p)} aria-label={`Suggest: ${p}`}
            style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)', borderRadius: 'var(--radius-md)', padding: '6px var(--space-3)', color: 'var(--accent)', cursor: 'pointer', fontSize: '0.8rem' }}>
            {p}
          </button>
        ))}
      </div>

      {/* Four-quadrant layout */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-2)', marginBottom: 'var(--space-3)' }}>
        {['situation', 'complication', 'promise', 'resolution'].map(key => {
          const q = quadrants.find(s => s.id === key)
          const meta = QUADRANT_META[key]
          return (
            <div
              key={key}
              className={`scpr-panel__${key}`}
              style={{
                background: meta.bg,
                border: `1px solid ${meta.color}33`,
                borderRadius: 'var(--radius-lg)',
                padding: 'var(--space-3)',
                minHeight: '80px',
              }}
            >
              <div style={{ fontSize: '0.65rem', fontWeight: 700, color: meta.color, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '6px' }}>
                {meta.label}
              </div>
              {q ? (
                <p style={{ color: 'var(--text-primary)', fontSize: '0.8rem', margin: 0, lineHeight: 1.5 }}>{q.content}</p>
              ) : (
                <p style={{ color: 'var(--text-muted)', fontSize: '0.75rem', margin: 0, fontStyle: 'italic' }}>Not yet defined</p>
              )}
            </div>
          )
        })}
      </div>

      {/* Gap analysis badges */}
      {gaps.length > 0 && (
        <div>
          <h4 style={{ color: 'var(--text-muted)', fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 var(--space-2)' }}>Gap Analysis</h4>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {gaps.map(g => (
              <span key={g.id} className="scpr-panel__gap-badge" style={{
                background: 'rgba(237,137,54,0.12)', color: '#ed8936',
                borderRadius: 'var(--radius-md)', padding: '3px var(--space-2)',
                fontSize: '0.7rem', fontWeight: 600,
              }}>
                ⚠ {g.content}
              </span>
            ))}
          </div>
        </div>
      )}

      {sections.length === 0 && (
        <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', textAlign: 'center', padding: 'var(--space-4)' }}>
          Start by describing the current situation to build your SCPR framework.
        </p>
      )}
    </div>
  )
}
