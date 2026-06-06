'use client'

import { useEffect, useState, useCallback } from 'react'
import type { ToolPanelContentProps, ToolArtifactSection } from '@/types'

const PROMPTS = [
  'Define the governing question',
  'Set a target metric',
  'Add constraints',
]

/** Parse assistant messages for branch/hypothesis/MECE structures */
function parseMessages(messages: ToolPanelContentProps['messages']): ToolArtifactSection[] {
  const sections: ToolArtifactSection[] = []
  const assistantMsgs = messages.filter(m => m.role === 'assistant')
  let meceStatus: string | null = null

  for (const msg of assistantMsgs) {
    const branchMatches = Array.from(msg.content.matchAll(/Branch\s+([A-Z\d]+):\s*([\s\S]+?)(?=Branch\s+[A-Z\d]+:|MECE Check:|$)/gi))
    for (const match of branchMatches) {
      const branchId = match[1]
      const branchBody = match[2].trim()
      const children: ToolArtifactSection[] = []
      const hypMatches = Array.from(branchBody.matchAll(/Hypothesis\s+([A-Z\d]+):\s*([\s\S]+?)(?=Hypothesis\s+[A-Z\d]+:|$)/gi))
      for (const hm of hypMatches) {
        children.push({
          id: `hyp-${branchId}-${hm[1]}`,
          type: 'hypothesis',
          title: `Hypothesis ${hm[1]}`,
          content: hm[2].trim(),
        })
      }
      const isRecommended = /recommended|priority|focus/i.test(branchBody)
      sections.push({
        id: `branch-${branchId}`,
        type: 'branch',
        title: `Branch ${branchId}`,
        content: branchBody.split('\n')[0],
        children,
        status: isRecommended ? 'recommended' : 'active',
        collapsed: false,
      })
    }
    const meceMatch = msg.content.match(/MECE Check:\s*(.+)/i)
    if (meceMatch) meceStatus = meceMatch[1].trim()
  }

  if (meceStatus) {
    sections.push({
      id: 'mece-check',
      type: 'generic',
      title: 'MECE Check',
      content: meceStatus,
      status: /pass/i.test(meceStatus) ? 'completed' : 'warning',
    })
  }
  return sections
}

export default function IssueTreePanel({ messages, onInjectChat, onArtifactUpdate, artifacts }: ToolPanelContentProps) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const toggle = useCallback((id: string) => {
    setCollapsed(prev => ({ ...prev, [id]: !prev[id] }))
  }, [])

  useEffect(() => {
    const sections = parseMessages(messages)
    if (sections.length > 0) {
      onArtifactUpdate({ toolId: 'issue-tree', title: 'Issue Tree', sections })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, onArtifactUpdate])

  const sections = artifacts?.sections ?? []
  const branches = sections.filter(s => s.type === 'branch')
  const meceCheck = sections.find(s => s.id === 'mece-check')

  return (
    <div className="issue-tree-panel" role="region" aria-label="Issue Tree Panel">
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
              transition: 'background 0.2s',
            }}
          >
            {p}
          </button>
        ))}
      </div>

      {/* MECE badge */}
      {meceCheck && (
        <div
          className="issue-tree-panel__mece-badge"
          aria-label={`MECE status: ${meceCheck.content}`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            padding: '4px var(--space-3)',
            borderRadius: 'var(--radius-md)',
            background: meceCheck.status === 'completed' ? 'rgba(72,187,120,0.15)' : 'rgba(237,137,54,0.15)',
            color: meceCheck.status === 'completed' ? '#48bb78' : '#ed8936',
            fontSize: '0.75rem',
            fontWeight: 600,
            marginBottom: 'var(--space-3)',
          }}
        >
          {meceCheck.status === 'completed' ? '✓' : '⚠'} {meceCheck.content}
        </div>
      )}

      {/* Branch cards */}
      {branches.map(branch => (
        <div
          key={branch.id}
          className="issue-tree-panel__branch"
          style={{
            background: 'var(--bg-card)',
            border: branch.status === 'recommended' ? '1.5px solid var(--accent)' : '1px solid var(--glass-border)',
            borderRadius: 'var(--radius-lg)',
            padding: 'var(--space-3)',
            marginBottom: 'var(--space-2)',
          }}
        >
          <button
            onClick={() => toggle(branch.id)}
            aria-expanded={!collapsed[branch.id]}
            style={{
              all: 'unset',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
              width: '100%',
              color: 'var(--text-primary)',
              fontWeight: 600,
              fontSize: '0.85rem',
            }}
          >
            <span style={{ transform: collapsed[branch.id] ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}>▾</span>
            {branch.status === 'recommended' && <span aria-label="Recommended">★</span>}
            {branch.title}
          </button>

          {!collapsed[branch.id] && (
            <div style={{ paddingLeft: 'var(--space-4)', marginTop: 'var(--space-2)' }}>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', margin: '0 0 var(--space-2)' }}>{branch.content}</p>
              {branch.children?.map(hyp => (
                <div
                  key={hyp.id}
                  className="issue-tree-panel__hypothesis"
                  style={{
                    background: 'var(--bg-elevated)',
                    borderRadius: 'var(--radius-md)',
                    padding: 'var(--space-2) var(--space-3)',
                    marginBottom: '4px',
                    fontSize: '0.8rem',
                    color: 'var(--text-secondary)',
                  }}
                >
                  <strong style={{ color: 'var(--text-primary)' }}>{hyp.title}:</strong> {hyp.content}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}

      {branches.length === 0 && (
        <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', textAlign: 'center', padding: 'var(--space-4)' }}>
          Start by defining your governing question to build the issue tree.
        </p>
      )}
    </div>
  )
}
