'use client'

import { useState, useMemo, useCallback } from 'react'
import { useFeed } from '@/app/hooks/useHubData'
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

function FeedCard({
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
  const icon = TYPE_ICONS[feedType]
  const label = TYPE_LABELS[feedType]
  const relTime = formatRelativeTimestamp(item.timestamp)
  const truncatedDesc =
    item.description.length > 80
      ? item.description.slice(0, 77) + '…'
      : item.description

  return (
    <button
      className="feed-card"
      data-feed-type={feedType}
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

      {/* Source badge */}
      {item.source && (
        <span className="feed-card__source">{item.source}</span>
      )}
    </button>
  )
}

/* ══════════════════════════════════════════════════════════════════════════════
   FEED FILTER BAR
   ══════════════════════════════════════════════════════════════════════════════ */

type FilterTab = 'all' | 'needs_you' | 'completed' | 'in_progress'

const FILTER_TABS: Array<{ id: FilterTab; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'needs_you', label: 'Needs You' },
  { id: 'completed', label: 'Completed' },
  { id: 'in_progress', label: 'In Progress' },
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
      <span style={{ color: 'var(--accent)', fontWeight: 700, opacity: 0.7 }}>// </span>
      {label}
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════════════════
   EXECUTION FEED (main export)
   ══════════════════════════════════════════════════════════════════════════════ */

export function ExecutionFeed({ onInjectChat }: { onInjectChat: (msg: string) => void }) {
  const { items, isLoading, error } = useFeed()
  const [activeFilter, setActiveFilter] = useState<FilterTab>('all')
  const [retrying, setRetrying] = useState(false)

  // Compute counts per filter tab
  const counts = useMemo(() => {
    const c: Record<FilterTab, number> = { all: items.length, needs_you: 0, completed: 0, in_progress: 0 }
    for (const item of items) {
      const t = (item as any).type as FeedItemType | undefined
      if (t === 'needs_you') c.needs_you++
      else if (t === 'completed') c.completed++
      else if (t === 'in_progress') c.in_progress++
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

  // Retry handler
  const handleRetry = useCallback(() => {
    setRetrying(true)
    window.location.reload()
  }, [])

  // Loading state
  if (isLoading) {
    return (
      <div style={{ padding: 'var(--space-4, 16px)' }}>
        <FeedFilterBar active={activeFilter} onChange={setActiveFilter} counts={{ all: 0, needs_you: 0, completed: 0, in_progress: 0 }} />
        <FeedSkeleton />
      </div>
    )
  }

  // Error state
  if (error) {
    return (
      <div style={{ padding: 'var(--space-4, 16px)' }}>
        <FeedFilterBar active={activeFilter} onChange={setActiveFilter} counts={counts} />
        <div className="feed-empty" role="alert">
          <div className="feed-empty__icon">⚠️</div>
          <div className="feed-empty__text">Unable to load activity feed — try refreshing</div>
          <button
            className="feed-filter-btn"
            onClick={handleRetry}
            disabled={retrying}
            style={{ marginTop: 'var(--space-3)' }}
          >
            {retrying ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      </div>
    )
  }

  // Empty state
  if (filteredItems.length === 0) {
    return (
      <div style={{ padding: 'var(--space-4, 16px)' }}>
        <FeedFilterBar active={activeFilter} onChange={setActiveFilter} counts={counts} />
        <div className="feed-empty" role="status">
          <div className="feed-empty__icon">💤</div>
          <div className="feed-empty__text">
            {activeFilter === 'all'
              ? 'No activity yet — your agents are idle'
              : `No ${activeFilter.replace('_', ' ')} items`}
          </div>
        </div>
      </div>
    )
  }

  // Feed content
  return (
    <div style={{ padding: 'var(--space-4, 16px)' }}>
      <FeedFilterBar active={activeFilter} onChange={setActiveFilter} counts={counts} />

      <div role="list" aria-label="Activity feed">
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
