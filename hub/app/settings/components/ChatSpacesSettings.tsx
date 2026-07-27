'use client'

import { useCallback, useMemo, useState } from 'react'
import { signIn } from 'next-auth/react'
import { useSpaces, useSaveChatSpacePreferences } from '@/app/hooks/useGoogleChat'
import type { ChatSpace } from '@/app/hooks/useGoogleChat'
import {
  chatSpaceKindLabel,
  classifyChatSpace,
  hideAllSpaces,
  isSpaceVisible,
  showAllSpaces,
  toggleSpaceVisibility,
  type ChatSpaceKind,
  type ChatSpacePreferences,
} from '@/lib/chat-spaces'

/**
 * ChatSpacesSettings — editor for which Google Chat spaces appear in the Hub's
 * Chat panel.
 *
 * Two things changed here versus the old inline version:
 *
 *  1. The saved value is a set of OVERRIDES on the default rule, not a snapshot
 *     of pinned names. Spaces are grouped by what they actually are, and the
 *     ad-hoc groups (Meet chats, DMs, bots) start OFF, so a Google Meet call
 *     tomorrow doesn't quietly appear in the panel.
 *  2. It persists to Postgres via /api/google/chat/spaces/preferences instead of
 *     localStorage, so the choice survives sign-out, a new browser and a deploy.
 */

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

/** Order the sections so the spaces that matter are at the top. */
const KIND_ORDER: ChatSpaceKind[] = ['named', 'group', 'dm', 'bot']

const KIND_HINT: Record<ChatSpaceKind, string> = {
  named: 'Real spaces you or a teammate created and named. Shown by default.',
  group: 'Unnamed group conversations — this is what a Google Meet call creates. Hidden by default.',
  dm: 'One-to-one direct messages. Hidden by default.',
  bot: 'Conversations with Chat apps and bots. Hidden by default.',
}

export function ChatSpacesSettings() {
  const { allSpaces, preferences, isLoading, missingScope } = useSpaces()
  const { save } = useSaveChatSpacePreferences()

  // Local working copy so toggles feel instant; `preferences` (server truth)
  // seeds it and wins whenever there are no unsaved edits.
  const [draft, setDraft] = useState<ChatSpacePreferences | null>(null)
  const [status, setStatus] = useState<SaveStatus>('idle')
  const [error, setError] = useState<string | null>(null)

  const current = draft ?? preferences

  const grouped = useMemo(() => {
    const map = new Map<ChatSpaceKind, ChatSpace[]>()
    for (const space of allSpaces) {
      const kind = space.kind ?? classifyChatSpace(space)
      if (!map.has(kind)) map.set(kind, [])
      map.get(kind)!.push(space)
    }
    for (const list of Array.from(map.values())) {
      list.sort((a, b) => (a.displayName || a.name).localeCompare(b.displayName || b.name))
    }
    return map
  }, [allSpaces])

  const visibleCount = useMemo(
    () => allSpaces.filter(s => isSpaceVisible(s, current)).length,
    [allSpaces, current],
  )

  const edit = useCallback((next: ChatSpacePreferences) => {
    setStatus('idle')
    setError(null)
    setDraft(next)
  }, [])

  const toggle = useCallback((space: ChatSpace) => {
    edit(toggleSpaceVisibility(space, draft ?? preferences))
  }, [draft, preferences, edit])

  const handleSave = useCallback(async () => {
    if (!draft) return
    setStatus('saving')
    setError(null)
    const ok = await save(draft)
    if (ok) {
      // Drop the local copy so the freshly-saved server value takes over.
      setDraft(null)
      setStatus('saved')
      setTimeout(() => setStatus('idle'), 2000)
    } else {
      setStatus('error')
      setError('Could not save your space choices — please try again.')
    }
  }, [draft, save])

  if (missingScope) {
    return (
      <section className="settings-section" aria-label="Google Chat spaces">
        <h2 className="settings-section-title">
          <span className="rx-comment-label">01.5 //</span> Google Chat Spaces
        </h2>
        <div className="settings-scope-warning">
          <span style={{ fontSize: '1.5rem' }}>🔐</span>
          <div>
            <strong>Google Chat not yet authorized.</strong>
            <p style={{ margin: '4px 0 12px 0', fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
              To view and send messages to your Google Chat spaces, please grant Chat permissions.
            </p>
            <button
              className="settings-auth-btn"
              onClick={() => signIn('google', { callbackUrl: '/settings' }, { prompt: 'consent' })}
            >
              Authorize Google Chat
            </button>
          </div>
        </div>
      </section>
    )
  }

  return (
    <section className="settings-section" aria-label="Google Chat spaces">
      <h2 className="settings-section-title">
        <span className="rx-comment-label">01.5 //</span> Google Chat Spaces
      </h2>
      <p className="settings-section-desc">
        Choose which spaces appear in your Chat panel. Named spaces are on by default; direct
        messages, Google Meet chats and bot conversations stay off until you turn them on here —
        including ones Google creates later. Saved to your account, not this browser.
      </p>

      {isLoading ? (
        <div className="settings-spaces-loading" role="status">
          {[1, 2, 3].map(i => <div key={i} className="settings-space-skeleton" />)}
        </div>
      ) : allSpaces.length === 0 ? (
        <p className="settings-empty">No Google Chat spaces found.</p>
      ) : (
        <>
          <div className="settings-spaces-actions">
            <button className="settings-link-btn" onClick={() => edit(showAllSpaces(allSpaces))}>Show all</button>
            <button className="settings-link-btn" onClick={() => edit(hideAllSpaces(allSpaces))}>Hide all</button>
            <button className="settings-link-btn" onClick={() => edit({ shown: [], hidden: [] })}>Reset to defaults</button>
          </div>

          <details
            className="settings-collapsible"
            open={(() => { try { return localStorage.getItem('hub-settings-spaces-open') === 'true' } catch { return false } })()}
            onToggle={(e: React.SyntheticEvent<HTMLDetailsElement>) => {
              try { localStorage.setItem('hub-settings-spaces-open', String((e.target as HTMLDetailsElement).open)) } catch {}
            }}
          >
            <summary className="settings-collapsible__trigger">
              <span className="settings-collapsible__arrow">▶</span>
              {allSpaces.length} spaces · {visibleCount} visible
            </summary>

            <div className="settings-spaces-list" role="list">
              {KIND_ORDER.filter(kind => grouped.has(kind)).map(kind => {
                const spaces = grouped.get(kind)!
                return (
                  <div key={kind} className="settings-space-group">
                    <h3 className="settings-space-group__title">
                      {chatSpaceKindLabel(kind)} <span className="settings-space-group__count">{spaces.length}</span>
                    </h3>
                    <p className="settings-space-group__hint">{KIND_HINT[kind]}</p>
                    {spaces.map(space => {
                      const visible = isSpaceVisible(space, current)
                      const label = space.displayName || space.name.split('/')[1]
                      return (
                        <label key={space.name} className="settings-space-row">
                          <div className="settings-space-row__info">
                            <span className="settings-space-row__icon" aria-hidden="true">
                              {kind === 'named' ? '#' : kind === 'dm' ? '👤' : kind === 'bot' ? '🤖' : '👥'}
                            </span>
                            <span className="settings-space-row__name">{label}</span>
                          </div>
                          <div
                            role="switch"
                            aria-checked={visible}
                            tabIndex={0}
                            className={`settings-toggle ${visible ? 'settings-toggle--on' : ''}`}
                            onClick={() => toggle(space)}
                            onKeyDown={e => {
                              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(space) }
                            }}
                            aria-label={`${visible ? 'Hide' : 'Show'} ${label}`}
                          >
                            <span className="settings-toggle__thumb" />
                          </div>
                        </label>
                      )
                    })}
                  </div>
                )
              })}
            </div>
          </details>

          {error && <p className="settings-error" role="alert">{error}</p>}

          <div className="settings-save-row">
            <button
              id="settings-save-chat-btn"
              className="settings-save-btn"
              onClick={handleSave}
              disabled={!draft || status === 'saving'}
            >
              {status === 'saving' ? 'Saving…' : status === 'saved' ? '✓ Saved' : 'Save Chat Preferences'}
            </button>
          </div>
        </>
      )}
    </section>
  )
}
