'use client'

import { useState, useEffect, memo } from 'react'
import { useTasks } from '@/app/hooks/useHubData'
import { writeFetch } from '@/app/hooks/useWriteFetch'
import type { TaskItem } from '@/app/hooks/useHubData'
import type { ChatAttachment } from '@/types'
import styles from './LeftPanelSections.module.css'
import { CollapsibleSection, SkeletonBlock, SectionMessage } from './LeftPanelShared'
import { formatRelativeDate } from './LeftPanelUtils'

/* ══════════════════════════════════════════════════════════════════════════════
   TASKS SECTION
   NOTE: The monolith used a CollapsibleSection render-prop pattern that passed
   `isOpen` to useTasks() to gate SWR polling on collapsed sections. This
   optimisation is deferred until CollapsibleSection supports render-prop children.
   ══════════════════════════════════════════════════════════════════════════════ */

function TasksSectionImpl({ onInjectChat, onInjectAction }: { onInjectChat: (msg: string, attachments?: ChatAttachment[]) => void; onInjectAction: (msg: string, attachments?: ChatAttachment[]) => void }) {
  const { taskLists, tasksByList, isLoading, error, mutate } = useTasks()
  const [activeListId, setActiveListId] = useState<string | null>(null)

  // Auto-select first list once loaded
  const firstListId = taskLists[0]?.id ?? null
  const resolvedListId = activeListId ?? firstListId

  // Local optimistic state: task IDs that are being toggled
  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set())
  // IDs that have been completed and are fading out
  const [fadingIds, setFadingIds] = useState<Set<string>>(new Set())
  // IDs to hide from the list (after fade completes)
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set())

  // Clear all optimistic state when switching lists — prevents hidden/fading
  // tasks from one list bleeding into another tab's view
  useEffect(() => {
    setFadingIds(new Set())
    setHiddenIds(new Set())
    setTogglingIds(new Set())
  }, [resolvedListId])

  if (isLoading) {
    return (
      <CollapsibleSection title="Tasks" protocolNum="03" defaultOpen>
        <SkeletonBlock lines={4} />
      </CollapsibleSection>
    )
  }

  const isAuthError = error && (error as any)?.status === 401
  if (isAuthError) {
    return (
      <CollapsibleSection title="Tasks" protocolNum="03" defaultOpen>
        <SectionMessage message="Session expired — please sign in again" type="error" />
      </CollapsibleSection>
    )
  }

  if (error) {
    return (
      <CollapsibleSection title="Tasks" protocolNum="03" defaultOpen>
        <SectionMessage message="Unable to load tasks — try refreshing" type="error" />
      </CollapsibleSection>
    )
  }

  const currentTasks = resolvedListId ? (tasksByList[resolvedListId] ?? []) : []
  const visibleTasks = currentTasks.filter(t => !hiddenIds.has(t.id))

  async function handleToggleTask(task: TaskItem, listId: string) {
    if (togglingIds.has(task.id)) return
    const wasCompleted = task.status === 'completed'
    const newAction = wasCompleted ? 'uncomplete' : 'complete'

    if (!wasCompleted) {
      // Mark as fading immediately for optimistic UX
      setFadingIds(prev => new Set(prev).add(task.id))
      setTimeout(() => {
        setHiddenIds(prev => new Set(prev).add(task.id))
        setFadingIds(prev => { const s = new Set(prev); s.delete(task.id); return s })
      }, 1500)
    }

    setTogglingIds(prev => new Set(prev).add(task.id))
    try {
      await writeFetch('/api/google/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: newAction, taskListId: listId, taskId: task.id }),
      })
      mutate?.()
    } catch {
      // Rollback optimistic UI on ANY failure (HTTP error or network).
      // writeFetch already routed a 401 into signIn('google').
      setFadingIds(prev => { const s = new Set(prev); s.delete(task.id); return s })
      setHiddenIds(prev => { const s = new Set(prev); s.delete(task.id); return s })
    } finally {
      setTogglingIds(prev => { const s = new Set(prev); s.delete(task.id); return s })
    }
  }

  const activeListName = taskLists.find(l => l.id === resolvedListId)?.title ?? 'Tasks'

  return (
    <CollapsibleSection title="Tasks" protocolNum="03" defaultOpen>
      {/* List tab strip */}
      {taskLists.length > 1 && (
        <div className="doc-filter-tabs" role="tablist" aria-label="Task lists" style={{ marginBottom: '6px' }}>
          {taskLists.map(list => (
            <button
              key={list.id}
              role="tab"
              aria-selected={resolvedListId === list.id}
              className={`feed-filter-btn${resolvedListId === list.id ? ' active' : ''}`}
              onClick={() => setActiveListId(list.id)}
              title={list.title}
            >
              {list.title.length > 9 ? list.title.slice(0, 8) + '…' : list.title}
            </button>
          ))}
        </div>
      )}

      {/* Task list */}
      {visibleTasks.length === 0 ? (
        <SectionMessage message={`No pending tasks in ${activeListName}`} type="empty" />
      ) : (
        <div role="list" aria-label={`${activeListName} tasks`}>
          {visibleTasks.map(task => (
            <TaskRow
              key={task.id}
              task={task}
              isFading={fadingIds.has(task.id)}
              isToggling={togglingIds.has(task.id)}
              onToggle={() => resolvedListId && handleToggleTask(task, resolvedListId)}
              onInjectChat={() => {
                // Carry the task's real details inline so the assistant has the
                // data even if this item is outside the live-context snapshot
                const due = task.due ? `, due ${new Date(task.due).toLocaleDateString('en-US', { timeZone: 'America/Chicago' })}` : ''
                const status = task.status === 'completed' ? ' (completed)' : ''
                const notes = task.notes ? `. Notes: ${task.notes.replace(/\s+/g, ' ').slice(0, 500)}` : ''
                onInjectChat(`Tell me about this task from my "${activeListName}" list: "${task.title}"${due}${status}${notes}`)
              }}
            />
          ))}
        </div>
      )}

      {/* FAB: open AI chat to create a task */}
      <button
        className={styles.tasksFab}
        onClick={() => onInjectAction(`Add a task to my ${activeListName} list: `)}
        aria-label={`Ask AI to add a task to ${activeListName}`}
        title={`Ask AI to add a task to ${activeListName}`}
      >
        + Task
      </button>
    </CollapsibleSection>
  )
}

export const TasksSection = memo(TasksSectionImpl)

function TaskRow({
  task,
  isFading,
  isToggling,
  onToggle,
  onInjectChat,
}: {
  task: TaskItem
  isFading: boolean
  isToggling: boolean
  onToggle: () => void
  onInjectChat: () => void
}) {
  const dueDate = task.due ? formatRelativeDate(task.due) : null
  const isCompleted = task.status === 'completed'

  return (
    <div
      role="listitem"
      className={`${styles.sectionRow} ${styles.taskRow} ${isFading ? styles.taskRowFading : ''}`}
      style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'default' }}
    >
      {/* Interactive checkbox */}
      <button
        onClick={(e) => { e.stopPropagation(); onToggle() }}
        disabled={isToggling}
        aria-label={isCompleted ? 'Mark incomplete' : 'Mark complete'}
        aria-pressed={isCompleted}
        className={`${styles.taskCheckbox} ${styles.taskCheckboxBtn} ${isCompleted ? styles.taskCheckboxCompleted : styles.taskCheckboxPending} ${isToggling ? styles.taskCheckboxToggling : ''}`}
      >
        {isCompleted && '✓'}
      </button>

      {/* Content — click to inject into chat */}
      <div
        className={styles.taskContent}
        onClick={onInjectChat}
        style={{ flex: 1, cursor: 'pointer', minWidth: 0 }}
      >
        <div className={`${styles.taskTitle} ${isCompleted || isFading ? styles.taskTitleCompleted : styles.taskTitlePending}`}>
          {task.title}
        </div>
        {dueDate && (
          <div className={styles.taskDue}>Due {dueDate}</div>
        )}
      </div>

      {/* Status dot */}
      <span
        aria-hidden="true"
        className={`${styles.taskStatusDot} ${isCompleted ? styles.taskStatusDotCompleted : styles.taskStatusDotPending}`}
      />
    </div>
  )
}
