'use client'

import { useEffect, useState } from 'react'
import { lastAssistantContent } from '@/lib/panel-artifact'
import type { ToolPanelContentProps, ToolArtifactSection } from '@/types'

const PROMPTS = [
  'Who is attending?',
  "What's the desired outcome?",
  'How long is the meeting?',
]

function parseMessages(messages: ToolPanelContentProps['messages']): ToolArtifactSection[] {
  const sections: ToolArtifactSection[] = []
  const assistantMsgs = messages.filter(m => m.role === 'assistant')

  for (const msg of assistantMsgs) {
    /* Agenda items: "10:00–10:15 — Topic Name" or "Agenda 1: Topic — 15 min" */
    const agendaMatches = Array.from(msg.content.matchAll(/(?:(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})\s*[-–—]\s*(.+?)(?:\n|$))|(?:Agenda\s*\d*:\s*(.+?)(?:\s*[-–—]\s*(\d+)\s*min)?(?:\n|$))/gi))
    for (const m of agendaMatches) {
      const title = (m[3] || m[4] || '').trim()
      const timeInfo = m[1] && m[2] ? `${m[1]}–${m[2]}` : m[5] ? `${m[5]} min` : ''
      if (title) {
        sections.push({ id: `agenda-${sections.length}`, type: 'step', title, content: timeInfo })
      }
    }
    /* Attendees: "Attendee: Name — Role" */
    const attendeeMatches = Array.from(msg.content.matchAll(/Attendee:\s*(.+?)(?:\s*[-–—]\s*(.+?))?(?:\n|$)/gi))
    for (const m of attendeeMatches) {
      sections.push({ id: `attendee-${sections.length}`, type: 'generic', title: m[1].trim(), content: m[2]?.trim() || 'Participant' })
    }
    /* Talking points: "- [ ] Point" or "Talking Point: text" */
    const tpMatches = Array.from(msg.content.matchAll(/(?:Talking Point:\s*(.+?)(?:\n|$))|(?:- \[[ x]\]\s*(.+?)(?:\n|$))/gi))
    for (const m of tpMatches) {
      const text = (m[1] || m[2] || '').trim()
      if (text) {
        const checked = m[0].includes('[x]')
        sections.push({ id: `tp-${sections.length}`, type: 'narrative', title: text, content: '', status: checked ? 'completed' : 'active' })
      }
    }
  }
  return sections
}

export default function MeetingPrepPanel({ messages, onInjectChat, onArtifactUpdate, artifacts }: ToolPanelContentProps) {
  const [checked, setChecked] = useState<Record<string, boolean>>({})

  const lastContent = lastAssistantContent(messages)

  useEffect(() => {
    const sections = parseMessages(messages)
    if (sections.length > 0) {
      onArtifactUpdate({ toolId: 'meeting-prep', title: 'Meeting Prep', sections })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastContent, onArtifactUpdate])

  const sections = artifacts?.sections ?? []
  const agendaItems = sections.filter(s => s.type === 'step')
  const attendees = sections.filter(s => s.type === 'generic')
  const talkingPoints = sections.filter(s => s.type === 'narrative')

  return (
    <div className="meeting-prep-panel" role="region" aria-label="Meeting Prep Panel">
      {/* Prompt chips */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', marginBottom: 'var(--space-4)' }}>
        {PROMPTS.map(p => (
          <button key={p} onClick={() => onInjectChat(p)} aria-label={`Suggest: ${p}`}
            style={{ background: 'var(--glass-bg)', border: '1px solid var(--glass-border)', borderRadius: 'var(--radius-md)', padding: '6px var(--space-3)', color: 'var(--accent)', cursor: 'pointer', fontSize: '0.8rem' }}>
            {p}
          </button>
        ))}
      </div>

      {/* Attendee cards */}
      {attendees.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: 'var(--space-3)' }}>
          {attendees.map(a => (
            <div key={a.id} className="meeting-prep-panel__attendee" style={{ background: 'var(--bg-card)', border: '1px solid var(--glass-border)', borderRadius: '999px', padding: '4px var(--space-3)', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ width: 18, height: 18, borderRadius: '50%', background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.55rem', color: '#1a1a2e', fontWeight: 700 }}>
                {a.title[0]?.toUpperCase()}
              </span>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-primary)' }}>{a.title}</span>
              <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{a.content}</span>
            </div>
          ))}
        </div>
      )}

      {/* Agenda timeline */}
      {agendaItems.length > 0 && (
        <div style={{ marginBottom: 'var(--space-3)' }}>
          <h4 style={{ color: 'var(--text-muted)', fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 var(--space-2)' }}>Agenda</h4>
          {agendaItems.map((item, idx) => (
            <div key={item.id} className="meeting-prep-panel__agenda-card" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', background: 'var(--bg-card)', border: '1px solid var(--glass-border)', borderRadius: 'var(--radius-md)', padding: 'var(--space-2) var(--space-3)', marginBottom: '4px' }}>
              <span style={{ color: 'var(--accent)', fontWeight: 700, fontSize: '0.75rem', minWidth: '20px' }}>{idx + 1}</span>
              <span style={{ flex: 1, color: 'var(--text-primary)', fontSize: '0.8rem' }}>{item.title}</span>
              {item.content && <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem', fontWeight: 600, background: 'var(--glass-bg)', borderRadius: '4px', padding: '2px 6px' }}>{item.content}</span>}
            </div>
          ))}
        </div>
      )}

      {/* Talking points checklist */}
      {talkingPoints.length > 0 && (
        <div>
          <h4 style={{ color: 'var(--text-muted)', fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 var(--space-2)' }}>Talking Points</h4>
          {talkingPoints.map(tp => (
            <label key={tp.id} className="meeting-prep-panel__talking-point" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', padding: '4px 0', cursor: 'pointer', fontSize: '0.8rem', color: checked[tp.id] ? 'var(--text-muted)' : 'var(--text-secondary)', textDecoration: checked[tp.id] ? 'line-through' : 'none' }}>
              <input type="checkbox" checked={checked[tp.id] ?? tp.status === 'completed'} onChange={() => setChecked(p => ({ ...p, [tp.id]: !p[tp.id] }))}
                style={{ accentColor: 'var(--accent)' }} aria-label={tp.title} />
              {tp.title}
            </label>
          ))}
        </div>
      )}

      {sections.length === 0 && (
        <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', textAlign: 'center', padding: 'var(--space-4)' }}>
          Describe your meeting to generate an agenda and talking points.
        </p>
      )}
    </div>
  )
}
