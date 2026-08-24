'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ToolPanelContentProps } from '@/types'
import { MessageContent } from '@/app/components/MessageContent'
import { parseDeepReport, type DeepReport } from '@/lib/deep-report'

/* ══════════════════════════════════════════════════════════════════════════════
   DEEP RUN PANEL — shared workspace for Deep Research / Deep Think
   (docs/architecture/DEEP_LANE_2026-08-23.md §4.5-§4.6, PR C)

   A deep run is asynchronous and durable: this panel briefs it, watches it by
   POLLING /api/deep-runs (state, never fabricated percentages — agy emits
   nothing until a run completes), and renders the landed report. Closing the
   panel or refreshing loses nothing — on mount the panel reattaches to the
   latest run for its tool.
   ══════════════════════════════════════════════════════════════════════════════ */

interface RunView {
  id: string
  tool: string
  status: string
  liveStatus: 'queued' | 'running' | 'finishing' | 'succeeded' | 'failed' | 'cancelled'
  brief: string
  resultMd: string | null
  errorClass: string | null
  error: string | null
  liveAttempt?: number
  liveMaxAttempts?: number
  leaseFresh?: boolean
  createdAt: string
  finishedAt: string | null
}

const POLL_MS = 5_000

const TOOL_COPY: Record<string, { verb: string; briefPlaceholder: string; runningNote: string }> = {
  'deep-research': {
    verb: 'Research',
    briefPlaceholder: 'What should be researched? State the question, any scope limits, and what a useful answer looks like…',
    runningNote: 'Searching and reading sources on your desktop engine. This typically takes several minutes.',
  },
  'deep-think': {
    verb: 'Think',
    briefPlaceholder: 'What should be thought through? State the decision or problem, the options on the table, and any hard constraints…',
    runningNote: 'Deliberating at high reasoning effort on your desktop engine. This typically takes a few minutes.',
  },
}

/** Friendly names for the typed failure classes a run can land with. */
function failureMessage(errorClass: string | null, error: string | null): string {
  switch (errorClass) {
    case 'lease_expired': return 'The desktop worker dropped the run and no attempts were left.'
    case 'deadline': return 'No worker picked the run up before its deadline — check that the desktop worker is running with a work slot.'
    case 'timeout': return 'The run exceeded its time budget.'
    case 'abort': return 'The run was cancelled.'
    case 'orphaned': return 'The run lost its engine job — start a new one.'
    case 'empty': return 'The engine returned nothing — empty output is never success. Try again.'
    default: return error || 'The run failed.'
  }
}

/** Friendly copy for the reasons POST /api/deep-runs refuses to start. */
function startRefusalMessage(reason: string | undefined, fallback: string): string {
  switch (reason) {
    case 'no_worker': return 'The engine is offline — deep runs execute on your desktop worker, and no work-capable slot has checked in. Start it with WORKER_WORK_SLOTS=1, then try again.'
    case 'dispatch_disabled': return 'The deep engine is not enabled on this deployment.'
    case 'queue_full': return 'The engine is at capacity right now — try again in a few minutes.'
    case 'active_run_exists': return 'You already have a deep run in flight. Wait for it to finish or cancel it first.'
    case 'not_migrated': return 'The deep-run tables are missing — an admin needs to run migrations.'
    default: return fallback
  }
}

function elapsedLabel(fromIso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - Date.parse(fromIso)) / 1000))
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`
}

export default function DeepRunPanel({
  toolId,
  contextSummary,
  onInjectChat,
  onArtifactUpdate,
  chatId,
}: ToolPanelContentProps) {
  const copy = TOOL_COPY[toolId] ?? TOOL_COPY['deep-research']
  const [phase, setPhase] = useState<'loading' | 'brief' | 'starting' | 'watching' | 'done' | 'failed'>('loading')
  const [brief, setBrief] = useState('')
  const [run, setRun] = useState<RunView | null>(null)
  const [report, setReport] = useState<DeepReport | null>(null)
  const [banner, setBanner] = useState<string | null>(null)
  const [confirmingCancel, setConfirmingCancel] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  /* One-second clock for the elapsed label while a run is live. */
  useEffect(() => {
    if (phase !== 'watching' && phase !== 'starting') return
    const t = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(t)
  }, [phase])

  const adoptTerminal = useCallback((view: RunView) => {
    setRun(view)
    if (view.liveStatus === 'succeeded') {
      const parsed = parseDeepReport(view.resultMd)
      setReport(parsed)
      setPhase('done')
      // Feed the existing Save & Close path: the report becomes a normal
      // tool artifact (Postgres + pgvector) without any new plumbing.
      onArtifactUpdate({
        toolId: view.tool,
        title: parsed?.title ?? view.brief.slice(0, 80),
        sections: parsed
          ? [
              { id: `${view.id}-summary`, type: 'recommendation', title: 'Summary', content: parsed.summary },
              ...parsed.sections.map((s, i) => ({
                id: `${view.id}-s${i}`, type: 'insight' as const, title: s.heading, content: s.body,
              })),
              ...(parsed.sources.length > 0
                ? [{
                    id: `${view.id}-sources`, type: 'generic' as const, title: 'Sources',
                    content: parsed.sources.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}`).join('\n'),
                  }]
                : []),
            ]
          : [{ id: `${view.id}-report`, type: 'generic' as const, title: 'Report', content: view.resultMd ?? '' }],
        metadata: { deepRunId: view.id, chatId: chatId ?? undefined },
      })
    } else {
      setPhase('failed')
    }
  }, [chatId, onArtifactUpdate])

  const pollOnce = useCallback(async (runId: string): Promise<void> => {
    const res = await fetch(`/api/deep-runs/${runId}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const { run: view } = (await res.json()) as { run: RunView }
    if (!aliveRef.current) return
    if (view.liveStatus === 'succeeded' || view.liveStatus === 'failed' || view.liveStatus === 'cancelled') {
      adoptTerminal(view)
    } else {
      setRun(view)
      setPhase('watching')
    }
  }, [adoptTerminal])

  /* Reattach on mount: a deep run outlives the panel that started it. */
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/deep-runs?tool=${toolId}&limit=1`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const { runs } = (await res.json()) as { runs: RunView[] }
        if (cancelled || !aliveRef.current) return
        const latest = runs[0]
        if (latest && latest.status === 'queued') {
          setRun(latest)
          setPhase('watching')
          void pollOnce(latest.id).catch(() => {})
        } else if (latest && latest.status === 'succeeded' && latest.resultMd) {
          adoptTerminal({ ...latest, liveStatus: 'succeeded' })
        } else {
          setPhase('brief')
        }
      } catch {
        if (!cancelled && aliveRef.current) setPhase('brief')
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolId])

  /* The poll loop, active only while watching. */
  useEffect(() => {
    if (phase !== 'watching' || !run) return
    const t = setInterval(() => {
      void pollOnce(run.id).catch(() => {
        /* transient poll failure — keep the last known state, try again */
      })
    }, POLL_MS)
    return () => clearInterval(t)
  }, [phase, run, pollOnce])

  const startRun = useCallback(async () => {
    if (brief.trim().length < 3) {
      setBanner('Write a brief first — a sentence or two is enough.')
      return
    }
    setBanner(null)
    setPhase('starting')
    try {
      const res = await fetch('/api/deep-runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: toolId, brief: brief.trim(), chatId: chatId ?? undefined }),
      })
      const body = (await res.json()) as { run?: RunView; error?: string; reason?: string }
      if (!aliveRef.current) return
      if (!res.ok || !body.run) {
        if (body.reason === 'active_run_exists') {
          // Adopt the run that's already in flight instead of arguing.
          const list = await fetch(`/api/deep-runs?tool=${toolId}&limit=1`)
          const { runs } = (await list.json()) as { runs: RunView[] }
          if (runs[0] && runs[0].status === 'queued') {
            setRun(runs[0])
            setPhase('watching')
            return
          }
        }
        setBanner(startRefusalMessage(body.reason, body.error ?? 'Failed to start the run.'))
        setPhase('brief')
        return
      }
      setRun({ ...body.run, liveStatus: 'queued' })
      setPhase('watching')
    } catch {
      if (!aliveRef.current) return
      setBanner('Could not reach the Hub — check your connection and try again.')
      setPhase('brief')
    }
  }, [brief, chatId, toolId])

  const cancelRun = useCallback(async () => {
    if (!run) return
    if (!confirmingCancel) {
      setConfirmingCancel(true)
      return
    }
    setConfirmingCancel(false)
    try {
      const res = await fetch(`/api/deep-runs/${run.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel' }),
      })
      const { run: view } = (await res.json()) as { run: RunView }
      if (aliveRef.current && view) adoptTerminal(view)
    } catch {
      /* next poll shows the truth either way */
    }
  }, [run, confirmingCancel, adoptTerminal])

  const newRun = useCallback(() => {
    setRun(null)
    setReport(null)
    setBanner(null)
    setPhase('brief')
  }, [])

  /* ── Render ── */

  if (phase === 'loading') {
    return <div className="deep-run__loading">Checking for a run in flight…</div>
  }

  if (phase === 'brief' || phase === 'starting') {
    return (
      <div className="deep-run">
        {banner && <div className="deep-run__banner" role="alert">{banner}</div>}
        <label className="deep-run__label" htmlFor={`deep-brief-${toolId}`}>The brief</label>
        <textarea
          id={`deep-brief-${toolId}`}
          className="deep-run__brief"
          placeholder={copy.briefPlaceholder}
          value={brief}
          onChange={e => setBrief(e.target.value)}
          rows={5}
          disabled={phase === 'starting'}
        />
        {contextSummary && brief.trim() === '' && (
          <button
            className="deep-run__context-btn"
            onClick={() => setBrief(contextSummary)}
            title="Start the brief from the conversation context above"
          >
            Use conversation context as the brief
          </button>
        )}
        <button
          className="deep-run__start-btn"
          onClick={() => void startRun()}
          disabled={phase === 'starting' || brief.trim().length < 3}
        >
          {phase === 'starting' ? 'Starting…' : `Run Deep ${copy.verb}`}
        </button>
        <p className="deep-run__hint">
          Runs in the background on your desktop engine&apos;s allotment. You can close this panel — the run keeps going.
        </p>
      </div>
    )
  }

  if (phase === 'watching' && run) {
    const attempt = run.liveAttempt && run.liveAttempt > 1 ? ` · attempt ${run.liveAttempt} of ${run.liveMaxAttempts ?? 3}` : ''
    return (
      <div className="deep-run">
        <div className="deep-run__status-card">
          <span className={`deep-run__dot deep-run__dot--${run.liveStatus === 'running' ? 'live' : 'wait'}`} aria-hidden="true" />
          <div className="deep-run__status-text">
            <div className="deep-run__status-title">
              {run.liveStatus === 'queued' && 'Queued for the desktop worker'}
              {run.liveStatus === 'running' && `Running${attempt}`}
              {run.liveStatus === 'finishing' && 'Landing the report…'}
            </div>
            <div className="deep-run__status-sub">
              {elapsedLabel(run.createdAt, now)} elapsed
              {run.liveStatus === 'running' && run.leaseFresh === false && ' · worker heartbeat missing — recovering or retrying'}
            </div>
          </div>
        </div>
        <p className="deep-run__brief-echo">“{run.brief}”</p>
        <p className="deep-run__hint">{copy.runningNote} Closing this panel won&apos;t stop it.</p>
        <button className="deep-run__cancel-btn" onClick={() => void cancelRun()}>
          {confirmingCancel ? 'Really cancel this run?' : 'Cancel run'}
        </button>
      </div>
    )
  }

  if (phase === 'failed' && run) {
    return (
      <div className="deep-run">
        <div className="deep-run__banner" role="alert">
          {run.liveStatus === 'cancelled' ? 'Run cancelled.' : failureMessage(run.errorClass, run.error)}
        </div>
        <p className="deep-run__brief-echo">“{run.brief}”</p>
        <button className="deep-run__start-btn" onClick={() => { setBrief(run.brief); newRun() }}>
          Edit brief & run again
        </button>
      </div>
    )
  }

  if (phase === 'done' && run) {
    return (
      <div className="deep-run deep-run--report">
        <div className="deep-run__report-head">
          <h3 className="deep-run__report-title">{report?.title ?? 'Report'}</h3>
          <div className="deep-run__report-meta">
            finished {run.finishedAt ? elapsedLabel(run.createdAt, Date.parse(run.finishedAt)) : ''} after start
          </div>
        </div>
        {report ? (
          <>
            <div className="deep-run__summary">
              <MessageContent content={report.summary} />
            </div>
            {report.sections.map((s, i) => (
              <section key={i} className="deep-run__section">
                <h4 className="deep-run__section-heading">{s.heading}</h4>
                <MessageContent content={s.body} />
              </section>
            ))}
            {report.sources.length > 0 && (
              <section className="deep-run__section">
                <h4 className="deep-run__section-heading">Sources</h4>
                <ol className="deep-run__sources">
                  {report.sources.map((s, i) => (
                    <li key={i}>
                      <a href={s.url} target="_blank" rel="noopener noreferrer" className="chat-link">{s.title}</a>
                    </li>
                  ))}
                </ol>
              </section>
            )}
          </>
        ) : (
          /* No parsable JSON block — the markdown IS the report. */
          <div className="deep-run__raw">
            <MessageContent content={run.resultMd ?? ''} />
          </div>
        )}
        <div className="deep-run__actions">
          <button
            className="deep-run__context-btn"
            onClick={() => onInjectChat(`Let's discuss the ${copy.verb.toLowerCase()} report "${report?.title ?? run.brief.slice(0, 60)}" — start with its biggest implication for us.`)}
          >
            Discuss in chat
          </button>
          <button className="deep-run__context-btn" onClick={newRun}>New run</button>
        </div>
        <p className="deep-run__hint">Save &amp; Close (top right) stores this report in your tool artifacts.</p>
      </div>
    )
  }

  return null
}
