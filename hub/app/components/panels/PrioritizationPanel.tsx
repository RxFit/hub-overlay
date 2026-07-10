'use client'

import { useEffect } from 'react'
import { lastAssistantContent } from '@/lib/panel-artifact'
import type { ToolPanelContentProps, ToolArtifactSection } from '@/types'

const PROMPTS = [
  'List the items to prioritize',
  'What scoring framework?',
  'Set the time horizon',
]

/** Map priority tier to color */
function tierColor(tier: string): string {
  if (/do now|high|top/i.test(tier)) return 'var(--accent)'
  if (/park|medium|later/i.test(tier)) return 'var(--text-muted)'
  if (/avoid|low|drop/i.test(tier)) return '#fc8181'
  return 'var(--text-secondary)'
}

function tierBg(tier: string): string {
  if (/do now|high|top/i.test(tier)) return 'rgba(197,160,89,0.12)'
  if (/park|medium|later/i.test(tier)) return 'rgba(160,174,192,0.1)'
  if (/avoid|low|drop/i.test(tier)) return 'rgba(252,129,129,0.1)'
  return 'var(--glass-bg)'
}

function parseMessages(messages: ToolPanelContentProps['messages']): ToolArtifactSection[] {
  const sections: ToolArtifactSection[] = []
  const assistantMsgs = messages.filter(m => m.role === 'assistant')

  for (const msg of assistantMsgs) {
    /* Pattern: "1. Item Name — Score: 85 — Tier: Do Now" or similar ranked list patterns */
    const itemMatches = Array.from(msg.content.matchAll(/(?:^|\n)\s*\d+\.\s*(.+?)(?:\s*[-—]\s*Score:\s*(\d+))?(?:\s*[-—]\s*Tier:\s*(.+?))?(?:\n|$)/gi))
    for (const m of itemMatches) {
      const title = m[1].trim()
      const score = m[2] ? parseInt(m[2], 10) : undefined
      const tier = m[3]?.trim() ?? ''
      if (title.length > 2) {
        sections.push({
          id: `item-${sections.length}`,
          type: 'score',
          title,
          content: tier,
          score,
          status: /do now|high|top/i.test(tier) ? 'recommended' : /avoid|low|drop/i.test(tier) ? 'warning' : 'active',
        })
      }
    }
  }
  return sections
}

export default function PrioritizationPanel({ messages, onInjectChat, onArtifactUpdate, artifacts }: ToolPanelContentProps) {
  const lastContent = lastAssistantContent(messages)

  useEffect(() => {
    const sections = parseMessages(messages)
    if (sections.length > 0) {
      onArtifactUpdate({ toolId: 'prioritization', title: 'Prioritization Matrix', sections })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastContent, onArtifactUpdate])

  const items = artifacts?.sections ?? []

  return (
    <div className="prioritization-panel" role="region" aria-label="Prioritization Panel">
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

      {/* Ranked item list */}
      <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {items.map((item, idx) => {
          const tier = item.content || ''
          return (
            <li
              key={item.id}
              className="prioritization-panel__item"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-3)',
                background: tierBg(tier),
                border: item.status === 'recommended' ? '1px solid var(--accent)' : '1px solid var(--glass-border)',
                borderRadius: 'var(--radius-md)',
                padding: 'var(--space-2) var(--space-3)',
                marginBottom: '6px',
              }}
            >
              <span style={{ color: tierColor(tier), fontWeight: 700, fontSize: '0.85rem', minWidth: '22px' }}>
                {idx + 1}
              </span>
              <span style={{ flex: 1, color: 'var(--text-primary)', fontSize: '0.8rem', fontWeight: 500 }}>
                {item.title}
              </span>
              {item.score !== undefined && (
                <span
                  className="prioritization-panel__score-badge"
                  aria-label={`Score: ${item.score}`}
                  style={{
                    background: tierColor(tier),
                    color: '#1a1a2e',
                    borderRadius: '999px',
                    padding: '2px 10px',
                    fontSize: '0.7rem',
                    fontWeight: 700,
                  }}
                >
                  {item.score}
                </span>
              )}
              {tier && (
                <span style={{ color: tierColor(tier), fontSize: '0.7rem', fontWeight: 600 }}>
                  {tier}
                </span>
              )}
            </li>
          )
        })}
      </ol>

      {items.length === 0 && (
        <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', textAlign: 'center', padding: 'var(--space-4)' }}>
          List the items you want to prioritize to begin scoring.
        </p>
      )}
    </div>
  )
}
