'use client'

import { useEffect } from 'react'
import type { ToolPanelContentProps, ToolArtifactSection } from '@/types'

const PROMPTS = [
  'Upload or paste your data',
  'What question are you trying to answer?',
]

function trendArrow(direction: string): string {
  if (/up|increase|grew|positive/i.test(direction)) return '↑'
  if (/down|decrease|fell|negative/i.test(direction)) return '↓'
  return '→'
}

function trendColor(direction: string): string {
  if (/up|increase|grew|positive/i.test(direction)) return '#48bb78'
  if (/down|decrease|fell|negative/i.test(direction)) return '#fc8181'
  return 'var(--text-muted)'
}

function parseMessages(messages: ToolPanelContentProps['messages']): ToolArtifactSection[] {
  const sections: ToolArtifactSection[] = []
  const assistantMsgs = messages.filter(m => m.role === 'assistant')

  for (const msg of assistantMsgs) {
    /* Metric: Label — Value (trend direction) */
    const metricMatches = Array.from(msg.content.matchAll(/Metric:\s*(.+?)\s*[-—]\s*(.+?)(?:\s*\((.+?)\))?(?:\n|$)/gi))
    for (const m of metricMatches) {
      sections.push({
        id: `metric-${sections.length}`,
        type: 'score',
        title: m[1].trim(),
        content: `${m[2].trim()}${m[3] ? ` (${m[3].trim()})` : ''}`,
        status: m[3] && /up|positive|grew/i.test(m[3]) ? 'completed' : m[3] && /down|negative|fell/i.test(m[3]) ? 'warning' : 'active',
      })
    }
    /* Insight: severity — description */
    const insightMatches = Array.from(msg.content.matchAll(/Insight(?:\s*\d*):\s*(?:\[(\w+)\]\s*)?(.+?)(?:\n|$)/gi))
    for (const m of insightMatches) {
      sections.push({
        id: `insight-${sections.length}`,
        type: 'insight',
        title: m[1] || 'Info',
        content: m[2].trim(),
        status: /critical|high/i.test(m[1] || '') ? 'warning' : 'active',
      })
    }
  }
  return sections
}

export default function DataInsightsPanel({ messages, onInjectChat, onArtifactUpdate, artifacts }: ToolPanelContentProps) {
  useEffect(() => {
    const sections = parseMessages(messages)
    if (sections.length > 0) {
      onArtifactUpdate({ toolId: 'data-insights', title: 'Data Insights', sections })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, onArtifactUpdate])

  const sections = artifacts?.sections ?? []
  const metrics = sections.filter(s => s.type === 'score')
  const insights = sections.filter(s => s.type === 'insight')

  return (
    <div className="data-insights-panel" role="region" aria-label="Data Insights Panel">
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

      {/* Metric cards */}
      {metrics.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 'var(--space-2)', marginBottom: 'var(--space-3)' }}>
          {metrics.map(m => {
            const parts = m.content.match(/^(.+?)(?:\s*\((.+?)\))?$/)
            const value = parts?.[1] ?? m.content
            const trend = parts?.[2] ?? ''
            return (
              <div
                key={m.id}
                className="data-insights-panel__metric-card"
                style={{
                  background: 'var(--bg-card)',
                  border: '1px solid var(--glass-border)',
                  borderRadius: 'var(--radius-md)',
                  padding: 'var(--space-3)',
                  textAlign: 'center',
                }}
              >
                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{m.title}</div>
                <div style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-primary)' }}>{value}</div>
                {trend && (
                  <div style={{ fontSize: '0.75rem', color: trendColor(trend), fontWeight: 600, marginTop: '2px' }}>
                    {trendArrow(trend)} {trend}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Insight cards */}
      {insights.map(ins => (
        <div
          key={ins.id}
          className="data-insights-panel__insight-card"
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 'var(--space-2)',
            background: ins.status === 'warning' ? 'rgba(252,129,129,0.08)' : 'var(--bg-card)',
            border: `1px solid ${ins.status === 'warning' ? 'rgba(252,129,129,0.25)' : 'var(--glass-border)'}`,
            borderRadius: 'var(--radius-md)',
            padding: 'var(--space-2) var(--space-3)',
            marginBottom: '6px',
          }}
        >
          <span
            style={{
              fontSize: '0.65rem',
              fontWeight: 700,
              padding: '2px 6px',
              borderRadius: '4px',
              background: ins.status === 'warning' ? 'rgba(252,129,129,0.2)' : 'rgba(197,160,89,0.15)',
              color: ins.status === 'warning' ? '#fc8181' : 'var(--accent)',
              textTransform: 'uppercase',
              flexShrink: 0,
            }}
          >
            {ins.title}
          </span>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{ins.content}</span>
        </div>
      ))}

      {sections.length === 0 && (
        <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', textAlign: 'center', padding: 'var(--space-4)' }}>
          Upload data or describe your analysis question to get started.
        </p>
      )}
    </div>
  )
}
