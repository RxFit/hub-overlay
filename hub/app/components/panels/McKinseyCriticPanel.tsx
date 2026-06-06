'use client'

import { useEffect } from 'react'
import type { ToolPanelContentProps, ToolArtifactSection } from '@/types'

const PROMPTS = [
  'Paste or describe the document to review',
  'Who is the audience?',
  "What's the goal?",
]

function severityIcon(severity: string): string {
  if (/critical|red|major/i.test(severity)) return '🔴'
  if (/moderate|yellow|medium/i.test(severity)) return '🟡'
  return '🟢'
}

function severityBg(severity: string): string {
  if (/critical|red|major/i.test(severity)) return 'rgba(252,129,129,0.08)'
  if (/moderate|yellow|medium/i.test(severity)) return 'rgba(237,201,54,0.08)'
  return 'rgba(72,187,120,0.08)'
}

function parseMessages(messages: ToolPanelContentProps['messages']): ToolArtifactSection[] {
  const sections: ToolArtifactSection[] = []
  const assistantMsgs = messages.filter(m => m.role === 'assistant')

  for (const msg of assistantMsgs) {
    /* Overall Grade: Green/Yellow/Red */
    const gradeMatch = msg.content.match(/(?:Overall\s+)?Grade:\s*(Green|Yellow|Red)/i)
    if (gradeMatch) {
      sections.push({ id: 'grade', type: 'score', title: 'Overall Grade', content: gradeMatch[1].trim(), status: /green/i.test(gradeMatch[1]) ? 'completed' : /red/i.test(gradeMatch[1]) ? 'warning' : 'active' })
    }
    /* Critique items: "Critique 1: [Severity] Description" */
    const critiqueMatches = Array.from(msg.content.matchAll(/Critique\s*(\d+):\s*(?:\[(\w+)\]\s*)?(.+?)(?:\n|$)/gi))
    for (const m of critiqueMatches) {
      sections.push({
        id: `critique-${m[1]}`,
        type: 'critique',
        title: `Critique ${m[1]}`,
        content: m[3].trim(),
        status: /critical|red|major/i.test(m[2] || '') ? 'warning' : 'active',
      })
    }
    /* Top fix items: "Fix 1: Description" */
    const fixMatches = Array.from(msg.content.matchAll(/Fix\s*(\d+):\s*(.+?)(?:\n|$)/gi))
    for (const m of fixMatches) {
      sections.push({ id: `fix-${m[1]}`, type: 'recommendation', title: `Fix ${m[1]}`, content: m[2].trim(), status: 'recommended' })
    }
  }
  return sections
}

export default function McKinseyCriticPanel({ messages, onInjectChat, onArtifactUpdate, artifacts }: ToolPanelContentProps) {
  useEffect(() => {
    const sections = parseMessages(messages)
    if (sections.length > 0) {
      onArtifactUpdate({ toolId: 'mckinsey-critic', title: 'McKinsey Critique', sections })
    }
  }, [messages, onArtifactUpdate])

  const sections = artifacts?.sections ?? []
  const grade = sections.find(s => s.id === 'grade')
  const critiques = sections.filter(s => s.type === 'critique')
  const fixes = sections.filter(s => s.type === 'recommendation')

  const gradeColorMap: Record<string, string> = { Green: '#48bb78', Yellow: '#ecc94b', Red: '#fc8181' }
  const gradeColor = grade ? (gradeColorMap[grade.content] ?? 'var(--text-primary)') : ''

  return (
    <div className="mckinsey-critic-panel" role="region" aria-label="McKinsey Critic Panel">
      {/* Prompt chips */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', marginBottom: 'var(--space-4)' }}>
        {PROMPTS.map(p => (
          <button key={p} onClick={() => onInjectChat(p)} aria-label={`Suggest: ${p}`}
            style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)', borderRadius: 'var(--radius-md)', padding: '6px var(--space-3)', color: 'var(--accent)', cursor: 'pointer', fontSize: '0.8rem' }}>
            {p}
          </button>
        ))}
      </div>

      {/* Grade badge */}
      {grade && (
        <div className="mckinsey-critic-panel__grade" aria-label={`Overall grade: ${grade.content}`}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)',
            background: `${gradeColor}18`, border: `1.5px solid ${gradeColor}`, borderRadius: 'var(--radius-lg)',
            padding: '8px var(--space-4)', marginBottom: 'var(--space-3)', fontWeight: 700, fontSize: '0.9rem', color: gradeColor,
          }}>
          {severityIcon(grade.content)} Overall: {grade.content}
        </div>
      )}

      {/* Critique cards */}
      {critiques.length > 0 && (
        <div style={{ marginBottom: 'var(--space-3)' }}>
          <h4 style={{ color: 'var(--text-muted)', fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 var(--space-2)' }}>Critiques</h4>
          {critiques.map(c => (
            <div key={c.id} className="mckinsey-critic-panel__critique-card" style={{
              display: 'flex', alignItems: 'flex-start', gap: 'var(--space-2)',
              background: c.status === 'warning' ? 'rgba(252,129,129,0.08)' : 'var(--bg-card)',
              border: `1px solid ${c.status === 'warning' ? 'rgba(252,129,129,0.25)' : 'var(--glass-border)'}`,
              borderRadius: 'var(--radius-md)', padding: 'var(--space-2) var(--space-3)', marginBottom: '6px',
            }}>
              <span style={{ fontSize: '0.9rem', flexShrink: 0 }}>{severityIcon(c.status === 'warning' ? 'red' : 'green')}</span>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{c.content}</span>
            </div>
          ))}
        </div>
      )}

      {/* Top fixes */}
      {fixes.length > 0 && (
        <div>
          <h4 style={{ color: 'var(--text-muted)', fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 var(--space-2)' }}>Top Fixes</h4>
          {fixes.map((f, idx) => (
            <div key={f.id} className="mckinsey-critic-panel__fix-card" style={{
              display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
              background: 'rgba(197,160,89,0.08)', border: '1px solid rgba(197,160,89,0.25)',
              borderRadius: 'var(--radius-md)', padding: 'var(--space-2) var(--space-3)', marginBottom: '4px',
            }}>
              <span style={{ color: 'var(--accent)', fontWeight: 700, fontSize: '0.8rem' }}>{idx + 1}</span>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-primary)' }}>{f.content}</span>
            </div>
          ))}
        </div>
      )}

      {sections.length === 0 && (
        <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', textAlign: 'center', padding: 'var(--space-4)' }}>
          Paste or describe a document for consulting-quality critique.
        </p>
      )}
    </div>
  )
}
