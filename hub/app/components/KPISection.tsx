'use client'

import { useMemo, memo } from 'react'
import type { LiveKPI } from '@/types'
import type { ChatAttachment } from '@/types'
import { AnimatedNumber } from './AnimatedNumber'
import styles from './LeftPanelSections.module.css'
import { CollapsibleSection, SkeletonBlock, SectionMessage, SectionError } from './LeftPanelShared'

/* ══════════════════════════════════════════════════════════════════════════════
   KPI SECTION — Live Paperclip + Business KPIs
   ══════════════════════════════════════════════════════════════════════════════ */

function KPISectionImpl({
  kpis: allKpis,
  isLoading,
  error,
  onRetry,
  onInjectChat,
}: {
  kpis: LiveKPI[]
  isLoading: boolean
  error?: unknown
  onRetry?: () => void
  onInjectChat: (msg: string, attachments?: ChatAttachment[]) => void
}) {
  // Mandate: Left Panel = Google ecosystem + business metrics only.
  // Paperclip orchestration metrics belong on the Right Panel.
  const kpis = useMemo(() => allKpis.filter(kpi => kpi.source !== 'paperclip'), [allKpis])

  if (isLoading) {
    return (
      <CollapsibleSection title="KPIs" protocolNum="01" defaultOpen={false}>
        <SkeletonBlock lines={4} />
      </CollapsibleSection>
    )
  }

  // A fetch FAILURE is distinct from "no KPIs configured" — never show the
  // "configure in Settings" empty copy when the cause is an error.
  if (error) {
    return (
      <CollapsibleSection title="KPIs" protocolNum="01" defaultOpen={false}>
        <SectionError message="Unable to load KPIs — try again." onRetry={onRetry} />
      </CollapsibleSection>
    )
  }

  if (kpis.length === 0) {
    return (
      <CollapsibleSection title="KPIs" protocolNum="01" defaultOpen={false}>
        <SectionMessage message="No business KPIs configured — configure KPIs in Settings" type="empty" />
      </CollapsibleSection>
    )
  }

  return (
    <CollapsibleSection title="Business KPIs" protocolNum="01" defaultOpen={false}>
      <div className="kpi-grid" role="list" aria-label="Business KPIs">
        {kpis.map((kpi: LiveKPI, i: number) => {
          const trendClass =
            kpi.trendDirection === 'up'
              ? 'kpi-trend-up'
              : kpi.trendDirection === 'down'
                ? 'kpi-trend-down'
                : 'kpi-trend-neutral'

          return (
            <button
              key={kpi.id}
              className={`kpi-card ${styles.kpiCardClickable}`}
              role="listitem"
              onClick={() => onInjectChat(`Tell me more about KPI: ${kpi.label}`)}
              aria-label={`${kpi.label}: ${kpi.value}, trend ${kpi.trend}`}
            >
              <div className="kpi-label">
                {kpi.label}
              </div>
              <div className="kpi-value">
                <AnimatedNumber value={String(kpi.value)} delay={i * 120} />
              </div>
              <div
                className={`kpi-trend ${trendClass}`}
                aria-label={`Trend: ${kpi.trendDirection} ${kpi.trend}`}
              >
                <span aria-hidden="true" className="rx-star">✦</span> {kpi.trend}
              </div>
            </button>
          )
        })}
      </div>
    </CollapsibleSection>
  )
}

export const KPISection = memo(KPISectionImpl)
