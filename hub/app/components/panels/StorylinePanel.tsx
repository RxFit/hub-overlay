'use client'

import { useEffect } from 'react'
import type { ToolPanelContentProps, ToolArtifactSection } from '@/types'

const PROMPTS = [
  'Who is the audience?',
  'What decision do you need?',
  'How many slides?',
]

function parseMessages(messages: ToolPanelContentProps['messages']): ToolArtifactSection[] {
  const sections: ToolArtifactSection[] = []
  const assistantMsgs = messages.filter(m => m.role === 'assistant')

  for (const msg of assistantMsgs) {
    /* Governing thought: "Governing Thought: ..." */
    const govMatch = msg.content.match(/Governing Thought:\s*(.+?)(?:\n|$)/i)
    if (govMatch) {
      sections.push({ id: 'gov-thought', type: 'narrative', title: 'Governing Thought', content: govMatch[1].trim(), status: 'recommended' })
    }
    /* Supporting arguments: "Argument 1: ..." or "Supporting Point 1: ..." */
    const argMatches = Array.from(msg.content.matchAll(/(?:Argument|Supporting Point)\s*(\d+):\s*(.+?)(?:\n|$)/gi))
    for (const m of argMatches) {
      sections.push({ id: `arg-${m[1]}`, type: 'narrative', title: `Argument ${m[1]}`, content: m[2].trim() })
    }
    /* Slide titles: "Slide 1: Title" */
    const slideMatches = Array.from(msg.content.matchAll(/Slide\s+(\d+):\s*(.+?)(?:\n|$)/gi))
    for (const m of slideMatches) {
      sections.push({ id: `slide-${m[1]}`, type: 'slide', title: `Slide ${m[1]}`, content: m[2].trim(), score: parseInt(m[1], 10) })
    }
  }
  return sections
}

export default function StorylinePanel({ messages, onInjectChat, onArtifactUpdate, artifacts }: ToolPanelContentProps) {
  useEffect(() => {
    const sections = parseMessages(messages)
    if (sections.length > 0) {
      onArtifactUpdate({ toolId: 'storyline', title: 'Storyline', sections })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, onArtifactUpdate])

  const sections = artifacts?.sections ?? []
  const govThought = sections.find(s => s.id === 'gov-thought')
  const args = sections.filter(s => s.type === 'narrative' && s.id !== 'gov-thought')
  const slides = sections.filter(s => s.type === 'slide')

  return (
    <div className="storyline-panel" role="region" aria-label="Storyline Panel">
      {/* Prompt chips */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', marginBottom: 'var(--space-4)' }}>
        {PROMPTS.map(p => (
          <button key={p} onClick={() => onInjectChat(p)} aria-label={`Suggest: ${p}`}
            style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)', borderRadius: 'var(--radius-md)', padding: '6px var(--space-3)', color: 'var(--accent)', cursor: 'pointer', fontSize: '0.8rem' }}>
            {p}
          </button>
        ))}
      </div>

      {/* Governing thought */}
      {govThought && (
        <div className="storyline-panel__governing-thought" style={{
          background: 'rgba(197,160,89,0.1)', border: '1.5px solid var(--accent)', borderRadius: 'var(--radius-lg)', padding: 'var(--space-3)', marginBottom: 'var(--space-3)',
        }}>
          <div style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px' }}>Governing Thought</div>
          <p style={{ color: 'var(--text-primary)', fontSize: '0.85rem', fontWeight: 600, margin: 0 }}>{govThought.content}</p>
        </div>
      )}

      {/* Supporting arguments as a vertical flow */}
      {args.length > 0 && (
        <div style={{ marginBottom: 'var(--space-3)' }}>
          {args.map((arg, idx) => (
            <div key={arg.id} className="storyline-panel__argument" style={{
              display: 'flex', alignItems: 'flex-start', gap: 'var(--space-2)',
              background: 'var(--bg-card)', border: '1px solid var(--glass-border)', borderRadius: 'var(--radius-md)',
              padding: 'var(--space-2) var(--space-3)', marginBottom: '4px',
            }}>
              <span style={{ color: 'var(--accent)', fontWeight: 700, fontSize: '0.8rem', minWidth: '18px' }}>{idx + 1}</span>
              <div>
                <div style={{ color: 'var(--text-primary)', fontSize: '0.8rem', fontWeight: 600 }}>{arg.title}</div>
                <div style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', marginTop: '2px' }}>{arg.content}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Numbered slide title cards */}
      {slides.length > 0 && (
        <div>
          <h4 style={{ color: 'var(--text-muted)', fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 var(--space-2)' }}>Slide Outline</h4>
          {slides.map(s => (
            <div key={s.id} className="storyline-panel__slide-card" style={{
              display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
              background: 'var(--bg-elevated)', border: '1px solid var(--glass-border)', borderRadius: 'var(--radius-md)',
              padding: 'var(--space-2) var(--space-3)', marginBottom: '4px',
            }}>
              <span style={{
                width: 24, height: 24, borderRadius: '50%', background: 'var(--accent)', color: '#1a1a2e',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.7rem', fontWeight: 700, flexShrink: 0,
              }}>{s.score}</span>
              <span style={{ color: 'var(--text-primary)', fontSize: '0.8rem' }}>{s.content}</span>
            </div>
          ))}
        </div>
      )}

      {sections.length === 0 && (
        <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', textAlign: 'center', padding: 'var(--space-4)' }}>
          Define your audience and the decision you need to craft a storyline.
        </p>
      )}
    </div>
  )
}
