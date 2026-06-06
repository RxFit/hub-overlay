'use client'

import { useEffect } from 'react'
import type { ToolPanelContentProps, ToolArtifactSection } from '@/types'

const PROMPTS = [
  "What's the topic?",
  "Who's the audience?",
  'What decision do you need?',
]

const PIPELINE_STEPS = [
  { key: 'strategist', label: 'Strategist', icon: '🎯' },
  { key: 'builder',    label: 'Builder',    icon: '🔨' },
  { key: 'critic',     label: 'Critic',     icon: '🔍' },
  { key: 'fixer',      label: 'Fixer',      icon: '✨' },
]

function stepStatus(key: string, content: string): 'active' | 'completed' | 'warning' | undefined {
  const regex = new RegExp(`${key}.*(?:complete|done|finished)`, 'i')
  if (regex.test(content)) return 'completed'
  const activeRegex = new RegExp(`${key}.*(?:active|running|in progress|current)`, 'i')
  if (activeRegex.test(content)) return 'active'
  return undefined
}

function parseMessages(messages: ToolPanelContentProps['messages']): ToolArtifactSection[] {
  const sections: ToolArtifactSection[] = []
  const assistantMsgs = messages.filter(m => m.role === 'assistant')
  const fullText = assistantMsgs.map(m => m.content).join('\n')

  /* Detect pipeline step statuses */
  for (const ps of PIPELINE_STEPS) {
    const status = stepStatus(ps.key, fullText)
    if (status) {
      sections.push({ id: `step-${ps.key}`, type: 'step', title: ps.label, content: ps.icon, status })
    }
  }

  /* Slide outlines within steps */
  for (const msg of assistantMsgs) {
    const slideMatches = Array.from(msg.content.matchAll(/Slide\s+(\d+):\s*(.+?)(?:\n|$)/gi))
    for (const m of slideMatches) {
      sections.push({ id: `pipeline-slide-${m[1]}`, type: 'slide', title: `Slide ${m[1]}`, content: m[2].trim(), score: parseInt(m[1], 10) })
    }
  }
  return sections
}

export default function DeckPipelinePanel({ messages, onInjectChat, onArtifactUpdate, artifacts }: ToolPanelContentProps) {
  useEffect(() => {
    const sections = parseMessages(messages)
    if (sections.length > 0) {
      onArtifactUpdate({ toolId: 'deck-pipeline', title: 'Deck Pipeline', sections })
    }
  }, [messages, onArtifactUpdate])

  const sections = artifacts?.sections ?? []
  const stepSections = sections.filter(s => s.type === 'step')
  const slides = sections.filter(s => s.type === 'slide')

  return (
    <div className="deck-pipeline-panel" role="region" aria-label="Deck Pipeline Panel">
      {/* Prompt chips */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', marginBottom: 'var(--space-4)' }}>
        {PROMPTS.map(p => (
          <button key={p} onClick={() => onInjectChat(p)} aria-label={`Suggest: ${p}`}
            style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)', borderRadius: 'var(--radius-md)', padding: '6px var(--space-3)', color: 'var(--accent)', cursor: 'pointer', fontSize: '0.8rem' }}>
            {p}
          </button>
        ))}
      </div>

      {/* Pipeline progress bar */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: 'var(--space-4)' }}>
        {PIPELINE_STEPS.map((ps, idx) => {
          const found = stepSections.find(s => s.id === `step-${ps.key}`)
          const isCompleted = found?.status === 'completed'
          const isActive = found?.status === 'active'
          return (
            <div key={ps.key} style={{ flex: 1, textAlign: 'center' }}>
              <div style={{
                height: '4px',
                borderRadius: '2px',
                background: isCompleted ? 'var(--accent)' : isActive ? 'rgba(197,160,89,0.5)' : 'var(--glass-border)',
                marginBottom: '6px',
                transition: 'background 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
              }} />
              <div style={{ fontSize: '1rem' }}>{ps.icon}</div>
              <div style={{
                fontSize: '0.65rem',
                fontWeight: 700,
                color: isCompleted ? 'var(--accent)' : isActive ? 'var(--text-primary)' : 'var(--text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                marginTop: '2px',
              }}>
                {ps.label}
              </div>
              {isCompleted && <span style={{ fontSize: '0.6rem', color: '#48bb78' }}>✓ Done</span>}
              {isActive && <span style={{ fontSize: '0.6rem', color: 'var(--accent)' }}>● Active</span>}
            </div>
          )
        })}
      </div>

      {/* Slide outline cards */}
      {slides.length > 0 && (
        <div>
          <h4 style={{ color: 'var(--text-muted)', fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 var(--space-2)' }}>Slide Outline</h4>
          {slides.map(s => (
            <div key={s.id} className="deck-pipeline-panel__slide" style={{
              display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
              background: 'var(--bg-card)', border: '1px solid var(--glass-border)', borderRadius: 'var(--radius-md)',
              padding: 'var(--space-2) var(--space-3)', marginBottom: '4px',
            }}>
              <span style={{
                width: 22, height: 22, borderRadius: '50%', background: 'var(--bg-elevated)', color: 'var(--accent)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.65rem', fontWeight: 700, flexShrink: 0, border: '1px solid var(--glass-border)',
              }}>{s.score}</span>
              <span style={{ color: 'var(--text-primary)', fontSize: '0.8rem' }}>{s.content}</span>
            </div>
          ))}
        </div>
      )}

      {sections.length === 0 && (
        <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', textAlign: 'center', padding: 'var(--space-4)' }}>
          Define your deck topic to kick off the 4-step pipeline.
        </p>
      )}
    </div>
  )
}
