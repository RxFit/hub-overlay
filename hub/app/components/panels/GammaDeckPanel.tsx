'use client'

import { useEffect } from 'react'
import type { ToolPanelContentProps, ToolArtifactSection } from '@/types'

const PROMPTS = [
  'Provide or select a storyline',
  'Choose a theme',
  'Set the tone',
]

type ExportStatus = 'pending' | 'generating' | 'complete'

function detectExportStatus(messages: ToolPanelContentProps['messages']): ExportStatus {
  const fullText = messages.filter(m => m.role === 'assistant').map(m => m.content).join('\n')
  if (/complete|generated|ready|download|link/i.test(fullText)) return 'complete'
  if (/generating|building|creating|in progress/i.test(fullText)) return 'generating'
  return 'pending'
}

function parseMessages(messages: ToolPanelContentProps['messages']): ToolArtifactSection[] {
  const sections: ToolArtifactSection[] = []
  const assistantMsgs = messages.filter(m => m.role === 'assistant')

  for (const msg of assistantMsgs) {
    /* Slide entries: "Slide 1: Title — Layout: full-image" */
    const slideMatches = Array.from(msg.content.matchAll(/Slide\s+(\d+):\s*(.+?)(?:\s*[-—]\s*Layout:\s*(.+?))?(?:\n|$)/gi))
    for (const m of slideMatches) {
      sections.push({
        id: `gamma-slide-${m[1]}`,
        type: 'slide',
        title: `Slide ${m[1]}`,
        content: m[2].trim(),
        score: parseInt(m[1], 10),
        status: m[3] ? 'completed' : 'active',
      })
    }
    /* Theme detection */
    const themeMatch = msg.content.match(/Theme:\s*(.+?)(?:\n|$)/i)
    if (themeMatch) {
      sections.push({ id: 'theme', type: 'generic', title: 'Theme', content: themeMatch[1].trim() })
    }
  }
  return sections
}

const STATUS_CONFIG: Record<ExportStatus, { label: string; color: string; icon: string }> = {
  pending:    { label: 'Pending',    color: 'var(--text-muted)', icon: '○' },
  generating: { label: 'Generating', color: '#ecc94b',           icon: '◉' },
  complete:   { label: 'Complete',   color: '#48bb78',            icon: '✓' },
}

export default function GammaDeckPanel({ messages, onInjectChat, onArtifactUpdate, artifacts }: ToolPanelContentProps) {
  useEffect(() => {
    const sections = parseMessages(messages)
    if (sections.length > 0) {
      onArtifactUpdate({ toolId: 'gamma-deck', title: 'Gamma Deck', sections })
    }
  }, [messages, onArtifactUpdate])

  const sections = artifacts?.sections ?? []
  const slides = sections.filter(s => s.type === 'slide')
  const theme = sections.find(s => s.id === 'theme')
  const exportStatus = detectExportStatus(messages)
  const statusCfg = STATUS_CONFIG[exportStatus]

  return (
    <div className="gamma-deck-panel" role="region" aria-label="Gamma Deck Panel">
      {/* Prompt chips */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', marginBottom: 'var(--space-4)' }}>
        {PROMPTS.map(p => (
          <button key={p} onClick={() => onInjectChat(p)} aria-label={`Suggest: ${p}`}
            style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)', borderRadius: 'var(--radius-md)', padding: '6px var(--space-3)', color: 'var(--accent)', cursor: 'pointer', fontSize: '0.8rem' }}>
            {p}
          </button>
        ))}
      </div>

      {/* Export status indicator */}
      <div className="gamma-deck-panel__status" aria-label={`Export status: ${statusCfg.label}`}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)',
          background: `${statusCfg.color}18`, border: `1px solid ${statusCfg.color}44`,
          borderRadius: 'var(--radius-md)', padding: '6px var(--space-3)', marginBottom: 'var(--space-3)',
          fontSize: '0.75rem', fontWeight: 600, color: statusCfg.color,
        }}>
        <span style={{ fontSize: '0.85rem' }}>{statusCfg.icon}</span>
        {statusCfg.label}
      </div>

      {/* Theme badge */}
      {theme && (
        <div style={{ marginBottom: 'var(--space-3)', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
          Theme: <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{theme.content}</span>
        </div>
      )}

      {/* Slide cards with layout preview */}
      {slides.length > 0 && (
        <div>
          {slides.map(s => (
            <div key={s.id} className="gamma-deck-panel__slide-card" style={{
              display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
              background: 'var(--bg-card)', border: '1px solid var(--glass-border)', borderRadius: 'var(--radius-md)',
              padding: 'var(--space-2) var(--space-3)', marginBottom: '6px',
            }}>
              {/* Layout preview placeholder */}
              <div style={{
                width: 48, height: 32, borderRadius: '4px', background: 'var(--bg-elevated)', border: '1px solid var(--glass-border)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
              }}>
                <span style={{ fontSize: '0.55rem', color: 'var(--text-muted)' }}>{s.score}</span>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ color: 'var(--text-primary)', fontSize: '0.8rem', fontWeight: 500 }}>{s.content}</div>
              </div>
              {s.status === 'completed' && (
                <span style={{ fontSize: '0.65rem', color: '#48bb78', fontWeight: 600 }}>✓</span>
              )}
            </div>
          ))}
        </div>
      )}

      {sections.length === 0 && (
        <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', textAlign: 'center', padding: 'var(--space-4)' }}>
          Provide a storyline or topic to generate a Gamma deck.
        </p>
      )}
    </div>
  )
}
