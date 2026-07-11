'use client'

import { useState, useEffect, useRef, memo } from 'react'
import { useTasks } from '@/app/hooks/useHubData'
import { writeFetch } from '@/app/hooks/useWriteFetch'
import { createHideTimers } from '@/lib/hide-timers'
import type { TaskItem } from '@/app/hooks/useHubData'
import type { ChatAttachment } from '@/types'
import styles from './LeftPanelSections.module.css'
import { CollapsibleSection, SkeletonBlock, SectionMessage } from './LeftPanelShared'
import { buildTaskInjectMessage, formatDueDate } from '@/lib/panel-inject'
import {
  addRecentlyCompleted,
  removeRecentlyCompleted,
  type CompletedTaskEntry,
} from '@/lib/recently-completed'

/** How long a completed-task undo affordance stays offered before auto-dismissing (ms). */
const UNDO_TIMEOUT_MS = 10_000

/* ══════════════════════════════════════════════════════════════════════════════
   TASKS SECTION
   NOTE: The monolith used a CollapsibleSection render-prop pattern that passed
   `isOpen` to useTasks() to gate query polling on collapsed sections. This
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
  // Just-completed tasks kept locally so the panel can offer an "Undo" affordance
  // even though the fetch (showCompleted=false) has dropped them from the list.
  const [recentlyCompleted, setRecentlyCompleted] = useState<CompletedTaskEntry[]>([])
  // Pending "hide after fade" timers, keyed by task id. Captured so a sub-1.5s
  // write failure can cancel the timer before it re-hides a rolled-back row.
  const hideTimersRef = useRef(createHideTimers())

  // Clear all optimistic state when switching lists — prevents hidden/fading
  // tasks from one list bleeding into another tab's view
  useEffect(() => {
    hideTimersRef.current.clearAll()
    setFadingIds(new Set())
    setHiddenIds(new Set())
    setTogglingIds(new Set())
    setRecentlyCompleted([])
  }, [resolvedListId])

  // Cancel any in-flight hide timers on unmount so they can't fire into an
  // unmounted tree.
  useEffect(() => {
    const timers = hideTimersRef.current
    return () => timers.clearAll()
  }, [])

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

  // Single write path shared by complete, uncomplete, and undo. Posts the action
  // and refreshes the tasks query; callers own their own optimistic UI.
  async function postTaskAction(action: 'complete' | 'uncomplete', listId: string, taskId: string) {
    await writeFetch('/api/google/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, taskListId: listId, taskId }),
    })
    mutate?.()
  }

  async function handleToggleTask(task: TaskItem, listId: string) {
    if (togglingIds.has(task.id)) return
    const wasCompleted = task.status === 'completed'
    const newAction = wasCompleted ? 'uncomplete' : 'complete'

    if (!wasCompleted) {
      // Mark as fading immediately for optimistic UX, then hide after the fade.
      // The timer handle is captured (keyed by task id) so the failure path can
      // cancel it — otherwise a fast write failure rolls the row back and this
      // timer then re-hides it 1.5s later, defeating the rollback.
      setFadingIds(prev => new Set(prev).add(task.id))
      hideTimersRef.current.schedule(task.id, () => {
        setHiddenIds(prev => new Set(prev).add(task.id))
        setFadingIds(prev => { const s = new Set(prev); s.delete(task.id); return s })
      }, 1500)
    }

    setTogglingIds(prev => new Set(prev).add(task.id))
    try {
      await postTaskAction(newAction, listId, task.id)
      if (!wasCompleted) {
        // Offer an in-panel undo for the just-completed task, then auto-dismiss.
        const entry: CompletedTaskEntry = { id: task.id, title: task.title, listId }
        setRecentlyCompleted(prev => addRecentlyCompleted(prev, entry))
        setTimeout(() => {
          setRecentlyCompleted(prev => removeRecentlyCompleted(prev, task.id))
        }, UNDO_TIMEOUT_MS)
      }
    } catch {
      // Rollback optimistic UI on ANY failure (HTTP error or network).
      // writeFetch already routed a 401 into signIn('google').
      // Cancel the pending hide timer FIRST so it can't re-hide the row after
      // we restore it (the sub-1.5s failure race).
      hideTimersRef.current.cancel(task.id)
      setFadingIds(prev => { const s = new Set(prev); s.delete(task.id); return s })
      setHiddenIds(prev => { const s = new Set(prev); s.delete(task.id); return s })
    } finally {
      setTogglingIds(prev => { const s = new Set(prev); s.delete(task.id); return s })
    }
  }

  // Undo a completion: reuse the existing uncomplete write path, then restore the
  // row (un-hide / un-fade) and drop the undo entry.
  async function handleUndoComplete(entry: CompletedTaskEntry) {
    if (togglingIds.has(entry.id)) return
    setTogglingIds(prev => new Set(prev).add(entry.id))
    try {
      await postTaskAction('uncomplete', entry.listId, entry.id)
      setHiddenIds(prev => { const s = new Set(prev); s.delete(entry.id); return s })
      setFadingIds(prev => { const s = new Set(prev); s.delete(entry.id); return s })
      setRecentlyCompleted(prev => removeRecentlyCompleted(prev, entry.id))
    } catch {
      // Leave the undo affordance in place so the user can retry.
      // writeFetch already routed a 401 into signIn('google').
    } finally {
      setTogglingIds(prev => { const s = new Set(prev); s.delete(entry.id); return s })
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
              onInjectChat={() => onInjectChat(buildTaskInjectMessage(task, activeListName))}
            />
          ))}
        </div>
      )}

      {/* Recently-completed undo affordance — restores accidental completions
          without leaving for the Google Tasks app */}
      {recentlyCompleted.some(e => e.listId === resolvedListId) && (
        <div className={styles.undoStack} role="status" aria-live="polite">
          {recentlyCompleted
            .filter(e => e.listId === resolvedListId)
            .map(entry => (
              <div key={entry.id} className={styles.undoRow}>
                <span className={styles.undoLabel}>
                  Completed “{entry.title}”
                </span>
                <button
                  type="button"
                  className={styles.undoBtn}
                  onClick={() => handleUndoComplete(entry)}
                  disabled={togglingIds.has(entry.id)}
                  aria-label={`Undo completing ${entry.title}`}
                >
                  Undo
                </button>
              </div>
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
  // formatDueDate handles Google Tasks' date-only UTC-midnight `due` values:
  // future deltas + overdue, without the "just now" bug formatRelativeDate has.
  const dueDate = task.due ? formatDueDate(task.due) : null
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
