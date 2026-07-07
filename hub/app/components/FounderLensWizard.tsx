'use client'

import { useState, useCallback } from 'react'
import type { FounderLensCustomSection, AgentRoleKey } from '@/types'

/* ══════════════════════════════════════════════════════════════════════════════
   FOUNDER LENS WIZARD
   A multi-step guided form that writes to each agent's FOUNDER_LENS.md
   CUSTOM section via POST /api/orgs/[orgId]/founder-lens
   ══════════════════════════════════════════════════════════════════════════════ */

type WizardStep =
  | { type: 'intro' }
  | { type: 'role'; role: AgentRoleKey; index: number }
  | { type: 'success' }

interface RoleConfig {
  key: AgentRoleKey
  label: string
  icon: string
  description: string
  questions: Array<{
    field: keyof FounderLensCustomSection
    label: string
    placeholder: string
    hint: string
  }>
}

const ROLE_CONFIGS: RoleConfig[] = [
  {
    key: 'ceo',
    label: 'CEO',
    icon: '🎯',
    description: 'Strategic center. Sets the mission and holds all departments accountable.',
    questions: [
      {
        field: 'okrs',
        label: 'Top 3 OKRs for this organization',
        placeholder: 'e.g., Grow MRR to $50K by Q4, Launch 2 new client verticals...',
        hint: 'Be specific — these become the CEO agent\'s north star for all decisions.',
      },
      {
        field: 'uniqueInstructions',
        label: 'CEO\'s core convictions about this business',
        placeholder: 'e.g., We never compete on price. We serve clients who are already successful...',
        hint: 'What would you say if asked to describe how to run this business in 3 sentences?',
      },
      {
        field: 'annualGoals',
        label: 'Annual revenue or growth goal',
        placeholder: 'e.g., $500K ARR by end of year...',
        hint: 'This anchors the CEO\'s financial oversight decisions.',
      },
    ],
  },
  {
    key: 'cmo',
    label: 'CMO / Marketing',
    icon: '📣',
    description: 'Brand, content, and customer acquisition. The voice of the company.',
    questions: [
      {
        field: 'idealCustomer',
        label: 'Ideal customer avatar (who you serve)',
        placeholder: 'e.g., High-achieving professionals in Austin, age 35-55, already successful...',
        hint: 'The more specific, the better. Generic = generic marketing.',
      },
      {
        field: 'competitiveAdvantages',
        label: 'What makes you genuinely different from competitors',
        placeholder: 'e.g., We combine operating metrics with proven playbook design. Our clients track NDR...',
        hint: 'Specific, verifiable claims only. Not "great service" or "passion."',
      },
      {
        field: 'tonePreferences',
        label: 'Brand voice and tone rules',
        placeholder: 'e.g., Authoritative not arrogant. Data-driven. Never use growth-hacking clichés...',
        hint: 'Include what NOT to say as well as what to say.',
      },
      {
        field: 'quarterlyGoals',
        label: 'Marketing goal for this quarter',
        placeholder: 'e.g., 50 qualified leads per month from Google Search...',
        hint: 'Specific KPI target the CMO agent will work toward.',
      },
    ],
  },
  {
    key: 'cto',
    label: 'CTO / Technical',
    icon: '⚙️',
    description: 'Technical infrastructure, reliability, and development velocity.',
    questions: [
      {
        field: 'uniqueInstructions',
        label: 'Current tech stack and non-negotiable constraints',
        placeholder: 'e.g., Next.js + PostgreSQL on Railway. All PRs require passing CI...',
        hint: 'The CTO agent makes architecture decisions within these constraints.',
      },
      {
        field: 'quarterlyGoals',
        label: 'Technical goal for this quarter',
        placeholder: 'e.g., 99.9% uptime, reduce bug backlog by 50%, ship mobile app...',
        hint: 'Specific deliverable the CTO agent tracks.',
      },
      {
        field: 'competitiveAdvantages',
        label: 'Technical moats or unique infrastructure',
        placeholder: 'e.g., Proprietary AI advisory model, custom KPI-pipeline integration...',
        hint: 'What technical capabilities does this business have that others don\'t?',
      },
    ],
  },
  {
    key: 'cfo',
    label: 'CFO / Revenue',
    icon: '💰',
    description: 'Financial health, revenue tracking, and expense oversight.',
    questions: [
      {
        field: 'quarterlyGoals',
        label: 'Revenue target for this quarter',
        placeholder: 'e.g., $120K MRR by end of Q3...',
        hint: 'The CFO agent benchmarks all financial decisions against this.',
      },
      {
        field: 'uniqueInstructions',
        label: 'Financial policies and constraints',
        placeholder: 'e.g., No new hires until MRR > $50K. Expenses require 3-month payback...',
        hint: 'Rules the CFO agent never breaks without human approval.',
      },
      {
        field: 'annualGoals',
        label: 'Annual financial goal',
        placeholder: 'e.g., $1M ARR, profitable by Q2...',
        hint: 'The big number the entire org is working toward.',
      },
    ],
  },
]

/* ── Field input component ── */

function QuestionField({
  question,
  value,
  onChange,
}: {
  question: RoleConfig['questions'][0]
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div className="flw-field">
      <label className="flw-field__label">{question.label}</label>
      <p className="flw-field__hint">{question.hint}</p>
      <textarea
        className="flw-field__input"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={question.placeholder}
        rows={3}
      />
    </div>
  )
}

/* ── Role step ── */

function RoleStep({
  config,
  data,
  onUpdate,
}: {
  config: RoleConfig
  data: Partial<FounderLensCustomSection>
  onUpdate: (field: keyof FounderLensCustomSection, value: string) => void
}) {
  return (
    <div className="flw-role-step">
      <div className="flw-role-step__header">
        <span className="flw-role-step__icon" aria-hidden="true">{config.icon}</span>
        <div>
          <div className="flw-role-step__title">{config.label}</div>
          <div className="flw-role-step__desc">{config.description}</div>
        </div>
      </div>
      <div className="flw-role-step__fields">
        {config.questions.map(q => (
          <QuestionField
            key={q.field}
            question={q}
            value={data[q.field] ?? ''}
            onChange={v => onUpdate(q.field, v)}
          />
        ))}
      </div>
    </div>
  )
}

/* ── Progress bar ── */

function WizardProgress({ current, total }: { current: number; total: number }) {
  const pct = Math.round((current / total) * 100)
  return (
    <div className="flw-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className="flw-progress__bar" style={{ width: `${pct}%` }} />
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════════════════
   MAIN WIZARD COMPONENT
   ══════════════════════════════════════════════════════════════════════════════ */

export function FounderLensWizard({
  orgId,
  orgName,
  onClose,
}: {
  orgId: string
  orgName: string
  onClose: () => void
}) {
  const [step, setStep] = useState<WizardStep>({ type: 'intro' })
  const [formData, setFormData] = useState<Record<AgentRoleKey, Partial<FounderLensCustomSection>>>(
    Object.fromEntries(ROLE_CONFIGS.map(r => [r.key, { role: r.key }])) as any
  )
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const currentRoleIndex = step.type === 'role' ? step.index : -1
  const totalSteps = ROLE_CONFIGS.length

  const updateField = useCallback((role: AgentRoleKey, field: keyof FounderLensCustomSection, value: string) => {
    setFormData(prev => ({
      ...prev,
      [role]: { ...prev[role], [field]: value },
    }))
  }, [])

  const goToRole = (index: number) => {
    if (index < ROLE_CONFIGS.length) {
      setStep({ type: 'role', role: ROLE_CONFIGS[index].key, index })
    } else {
      handleSave()
    }
  }

  const handleSave = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      const roles = ROLE_CONFIGS.map(r => ({
        ...formData[r.key],
        role: r.key,
      }))

      const res = await fetch(`/api/orgs/${encodeURIComponent(orgId)}/founder-lens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId, roles, updatedAt: new Date().toISOString() }),
      })

      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error ?? `Save failed (${res.status})`)
      }

      setStep({ type: 'success' })
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save')
    }
    setSaving(false)
  }

  return (
    <>
      {/* Backdrop */}
      <div className="flw-backdrop" onClick={onClose} aria-hidden="true" />

      {/* Modal */}
      <div
        className="flw-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Customize Your C-Suite"
      >
        {/* Header */}
        <div className="flw-modal__header">
          <div className="flw-modal__title">
            <span aria-hidden="true">⚙ </span>
            Customize Your C-Suite
            {orgName && <span className="flw-modal__org"> — {orgName}</span>}
          </div>
          <button onClick={onClose} className="flw-modal__close" aria-label="Close wizard">✕</button>
        </div>

        {/* Progress */}
        {step.type === 'role' && (
          <WizardProgress current={step.index + 1} total={totalSteps} />
        )}

        {/* Content */}
        <div className="flw-modal__body">

          {/* Intro step */}
          {step.type === 'intro' && (
            <div className="flw-intro">
              <div className="flw-intro__icon" aria-hidden="true">✦</div>
              <h2 className="flw-intro__title">Customize Your C-Suite Agents</h2>
              <p className="flw-intro__desc">
                Answer a few questions about your business to give each agent a custom operating philosophy.
                Your answers replace the default world-class archetype instructions with guidance specific to your org.
              </p>
              <p className="flw-intro__note">
                <strong>Default mode</strong> is already active — your agents use best-in-class archetypes (Paul Graham, Seth Godin, etc.).
                Custom mode layers your specific OKRs, customer avatar, and competitive advantages on top.
              </p>
              <div className="flw-intro__roles">
                {ROLE_CONFIGS.map(r => (
                  <div key={r.key} className="flw-intro__role-pill">
                    <span aria-hidden="true">{r.icon}</span> {r.label}
                  </div>
                ))}
              </div>
              <button
                id="flw-start-btn"
                className="bm-cta bm-cta--primary"
                onClick={() => goToRole(0)}
                style={{ marginTop: '24px', width: '100%', justifyContent: 'center' }}
              >
                Start Customizing →
              </button>
            </div>
          )}

          {/* Role step */}
          {step.type === 'role' && (
            <>
              <RoleStep
                config={ROLE_CONFIGS[step.index]}
                data={formData[step.role]}
                onUpdate={(field, value) => updateField(step.role, field, value)}
              />
              {saveError && (
                <div className="flw-error" role="alert">{saveError}</div>
              )}
              <div className="flw-modal__actions">
                {step.index > 0 && (
                  <button
                    className="bm-cta bm-cta--secondary"
                    onClick={() => goToRole(step.index - 1)}
                  >
                    ← Back
                  </button>
                )}
                <span style={{ flex: 1 }} />
                <span className="flw-step-count">
                  {step.index + 1} of {totalSteps}
                </span>
                <button
                  id="flw-next-btn"
                  className="bm-cta bm-cta--primary"
                  onClick={() => goToRole(step.index + 1)}
                  disabled={saving}
                >
                  {step.index === totalSteps - 1
                    ? (saving ? 'Saving…' : 'Save & Finish ✓')
                    : 'Next →'}
                </button>
              </div>
            </>
          )}

          {/* Success step */}
          {step.type === 'success' && (
            <div className="flw-success">
              <div className="flw-success__icon" aria-hidden="true">✓</div>
              <h2 className="flw-success__title">C-Suite Customized</h2>
              <p className="flw-success__desc">
                Your agent configurations have been saved. Each C-Suite agent will now operate with
                your specific OKRs, customer avatar, and competitive context on top of their default
                world-class archetype thinking.
              </p>
              <button
                className="bm-cta bm-cta--primary"
                onClick={onClose}
                style={{ marginTop: '24px', width: '100%', justifyContent: 'center' }}
              >
                Back to Business Manager
              </button>
            </div>
          )}

        </div>
      </div>
    </>
  )
}
