'use client'

import { useState, useMemo, useCallback, memo } from 'react'
import { useRuns } from '@/app/hooks/useHubData'
import type { FeedItem } from '@/app/hooks/useHubData'

/* ══════════════════════════════════════════════════════════════════════════════
   TYPE STYLING MAP
   ══════════════════════════════════════════════════════════════════════════════ */

type FeedItemType = 'completed' | 'in_progress' | 'needs_you' | 'info'

const TYPE_ICONS: Record<FeedItemType, string> = {
  completed: '✔️',
  in_progress: '⏳',
  needs_you: '🔴',
  info: 'ℹ️',
}

const TYPE_LABELS: Record<FeedItemType, string> = {
  completed: 'Completed',
  in_progress: 'In Progress',
  needs_you: 'Needs You',
  info: 'Info',
}

/* ══════════════════════════════════════════════════════════════════════════════
   SKELETON LOADING
   ══════════════════════════════════════════════════════════════════════════════ */

function FeedSkeleton() {
  return (
    <div className="feed-skeleton" aria-label="Loading feed" role="status">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="feed-skeleton__card" aria-hidden="true">
          <div className="feed-skeleton__icon" style={{ animationDelay: `${i * 120}ms` }} />
          <div className="feed-skeleton__lines">
            <div className="feed-skeleton__line feed-skeleton__line--wide" style={{ animationDelay: `${i * 120}ms` }} />
            <div className="feed-skeleton__line feed-skeleton__line--medium" style={{ animationDelay: `${i * 120 + 60}ms` }} />
          </div>
        </div>
      ))}
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════════════════
   FEED CARD
   ══════════════════════════════════════════════════════════════════════════════ */

const FeedCard = memo(function FeedCard({
  item,
  index,
  onInjectChat,
}: {
  item: FeedItem
  index: number
  onInjectChat: (msg: string) => void
}) {
  const typeKey = (item as any).type as FeedItemType | undefined
  const feedType = typeKey ?? 'info'
  const isAiAction = item.source === 'ai_action'
  const icon = TYPE_ICONS[feedType]
  const label = TYPE_LABELS[feedType]
  const relTime = formatRelativeTimestamp(item.timestamp)
  const desc = item.description ?? ''
  const truncatedDesc = desc.length > 80 ? desc.slice(0, 77) + '…' : desc

  return (
    <button
      className="feed-card"
      data-feed-type={feedType}
      data-feed-source={item.source}
      role="listitem"
      onClick={() => onInjectChat(`Tell me more about: ${item.title}`)}
      aria-label={`${label}: ${item.title}. ${truncatedDesc}. ${relTime}`}
      style={{
        animation: `rxSlideInUp 0.35s cubic-bezier(0.16, 1, 0.3, 1) ${index * 50}ms both`,
      }}
    >
      {/* Status icon */}
      <span
        className="feed-card__icon"
        data-feed-type={feedType}
        aria-hidden="true"
      >
        {icon}
      </span>

      {/* Content */}
      <div className="feed-card__body">
        <div className="feed-card__header">
          <div className="feed-card__title">{item.title}</div>
          <span className="feed-card__dot" data-feed-type={feedType} />
        </div>
        <div className="feed-card__description">{truncatedDesc}</div>
        <div className="feed-card__time">{relTime}</div>
      </div>

      {/* Source badge — AI-initiated actions get a distinct "AI" chip (NS-9) */}
      {item.source && (
        <span className="feed-card__source">{isAiAction ? 'AI' : item.source}</span>
      )}
    </button>
  )
})

/* ══════════════════════════════════════════════════════════════════════════════
   FEED FILTER BAR
   ══════════════════════════════════════════════════════════════════════════════ */

// No 'in_progress' tab: both sources behind /api/runs are terminal-only —
// ai_runs rows are written on completion (status ok|error) and AI actions map
// to completed/needs_you/info — so the tab could never light up again.
type FilterTab = 'all' | 'needs_you' | 'completed'

const FILTER_TABS: Array<{ id: FilterTab; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'needs_you', label: 'Needs You' },
  { id: 'completed', label: 'Completed' },
]

function FeedFilterBar({
  active,
  onChange,
  counts,
}: {
  active: FilterTab
  onChange: (tab: FilterTab) => void
  counts: Record<FilterTab, number>
}) {
  return (
    <div className="feed-filter-bar" role="tablist" aria-label="Feed filters">
      {FILTER_TABS.map((tab) => {
        const isActive = active === tab.id
        const count = counts[tab.id]
        return (
          <button
            key={tab.id}
            className={`feed-filter-btn ${isActive ? 'active' : ''}`}
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(tab.id)}
          >
            {tab.label}
            {count > 0 && <span>{count}</span>}
          </button>
        )
      })}
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════════════════
   DATE GROUPING
   ══════════════════════════════════════════════════════════════════════════════ */

function getDateGroup(timestamp: string): string {
  try {
    const d = new Date(timestamp)
    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const yesterday = new Date(today)
    yesterday.setDate(yesterday.getDate() - 1)

    const itemDate = new Date(d.getFullYear(), d.getMonth(), d.getDate())

    if (itemDate.getTime() >= today.getTime()) return 'Today'
    if (itemDate.getTime() >= yesterday.getTime()) return 'Yesterday'
    return 'Earlier'
  } catch {
    return 'Earlier'
  }
}

function DateGroupLabel({ label }: { label: string }) {
  return (
    <div className="feed-date-group">
      <span style={{ color: 'var(--accent)', fontWeight: 700, opacity: 0.7 }}>{'// '}</span>
      {label}
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════════════════
   EXECUTION FEED (main export)

   Phase 3 PR 2 (docs/architecture/PHASE3_EXECUTION_PANEL_2026-08-22.md §4):
   same presentation layer, new engine — the source is now the Hub's own
   ai_runs ledger via /api/runs (runs + the caller's AI actions), replacing
   the Paperclip activity feed. The BusinessManagerPanel header is no longer
   rendered: its data source (Paperclip ceo-pulse) is retired, so it opened
   every panel visit with a red failure card (§6.4's rule — do not render
   components whose data source is gone; the file itself dies in PR 5).
   ══════════════════════════════════════════════════════════════════════════════ */

export function ExecutionFeed({
  onInjectChat,
  canViewRuns,
}: {
  // Read-style feed-card taps ("tell me more about: …") — direct, intent-free path.
  onInjectChat: (msg: string) => void
  // Runs data is admin-gated (§3.4 — chat ledger rows have no attribution yet,
  // so a staff view cannot be scoped). False renders a quiet admin-only state
  // and never fetches.
  canViewRuns: boolean
}) {
  const { items, isLoading, error, refetch } = useRuns(canViewRuns)
  const [activeFilter, setActiveFilter] = useState<FilterTab>('all')
  const [retrying, setRetrying] = useState(false)

  // Compute counts per filter tab
  const counts = useMemo(() => {
    const c: Record<FilterTab, number> = { all: items.length, needs_you: 0, completed: 0 }
    for (const item of items) {
      const t = (item as any).type as FeedItemType | undefined
      if (t === 'needs_you') c.needs_you++
      else if (t === 'completed') c.completed++
    }
    return c
  }, [items])

  // Filter items
  const filteredItems = useMemo(() => {
    if (activeFilter === 'all') return items
    return items.filter((i) => (i as any).type === activeFilter)
  }, [items, activeFilter])

  // Group by date
  const grouped = useMemo(() => {
    const groups: Array<{ label: string; items: Array<{ item: FeedItem; globalIndex: number }> }> = []
    const order = ['Today', 'Yesterday', 'Earlier']
    const buckets: Record<string, Array<{ item: FeedItem; globalIndex: number }>> = {}

    filteredItems.forEach((item, idx) => {
      const group = getDateGroup(item.timestamp)
      if (!buckets[group]) buckets[group] = []
      buckets[group].push({ item, globalIndex: idx })
    })

    for (const label of order) {
      if (buckets[label]?.length) {
        groups.push({ label, items: buckets[label] })
      }
    }
    return groups
  }, [filteredItems])

  // Retry handler — revalidate ONLY the runs query. A full window.location.reload()
  // would discard in-progress chat/compose/thread state (#28 / NS6), so refetch
  // in place instead.
  const handleRetry = useCallback(async () => {
    setRetrying(true)
    try {
      await refetch()
    } finally {
      setRetrying(false)
    }
  }, [refetch])

  if (!canViewRuns) {
    return (
      <div style={{ padding: 'var(--space-4, 16px)' }}>
        <div className="feed-empty" role="status">
          <div className="feed-empty__icon">🔒</div>
          <div className="feed-empty__text">
            Run history is admin-only for now — ask an admin if you need a run looked up
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ padding: 'var(--space-4, 16px)' }}>

      {/* Filter bar — rendered once; counts are all-zero while loading (items is empty) */}
      <FeedFilterBar active={activeFilter} onChange={setActiveFilter} counts={counts} />

      {isLoading ? (
        <FeedSkeleton />
      ) : error ? (
        <div className="feed-empty" role="alert">
          <div className="feed-empty__icon">⚠️</div>
          <div className="feed-empty__text">Unable to load the runs feed — try refreshing</div>
          <button
            className="feed-filter-btn"
            onClick={handleRetry}
            disabled={retrying}
            style={{ marginTop: 'var(--space-3)' }}
          >
            {retrying ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      ) : filteredItems.length === 0 ? (
        <div className="feed-empty" role="status">
          <div className="feed-empty__icon">💤</div>
          <div className="feed-empty__text">
            {activeFilter === 'all'
              ? 'No runs yet — the engine is idle'
              : `No ${activeFilter.replace('_', ' ')} items`}
          </div>
        </div>
      ) : (
        <div role="list" aria-label="Runs feed">
          {grouped.map((group) => (
            <div key={group.label}>
              <DateGroupLabel label={group.label} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2, 8px)' }}>
                {group.items.map(({ item, globalIndex }) => (
                  <FeedCard
                    key={item.id}
                    item={item}
                    index={globalIndex}
                    onInjectChat={onInjectChat}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

    </div>
  )
}


/* ══════════════════════════════════════════════════════════════════════════════
   UTILITY
   ══════════════════════════════════════════════════════════════════════════════ */

function formatRelativeTimestamp(isoString: string): string {
  try {
    const d = new Date(isoString)
    const now = new Date()
    const diffMs = now.getTime() - d.getTime()
    const diffMins = Math.floor(diffMs / 60_000)
    const diffHours = Math.floor(diffMs / 3_600_000)
    const diffDays = Math.floor(diffMs / 86_400_000)

    if (diffMins < 1) return 'now'
    if (diffMins < 60) return `${diffMins}m`
    if (diffHours < 24) return `${diffHours}h`
    if (diffDays < 7) return `${diffDays}d`
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  } catch {
    return ''
  }
}
