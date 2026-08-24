'use client'

import dynamic from 'next/dynamic'
import type { ComponentType } from 'react'
import type { ToolPanelContentProps } from '@/types'

type ToolPanel = ComponentType<ToolPanelContentProps>

/** Lightweight fallback shown while a panel chunk is fetched (first show only). */
const PanelLoading = () => (
  <div className="tool-panel__loading">Loading panel…</div>
)

/**
 * Registry mapping each toolId to its dynamically-loaded panel component.
 *
 * Panels are code-split with `next/dynamic` so only the active tool's panel
 * chunk is downloaded — a meaningful win on mobile, where all ~11 panels would
 * otherwise ship in one client bundle even though one is shown at a time.
 *
 * `ssr: false` is correct here: the panels are client-only (they read the live
 * chat state / DOM), are rendered conditionally inside an already-client tree,
 * and skipping SSR avoids hydration concerns. Next caches each loaded chunk, so
 * re-showing a panel does not re-fetch or re-flash the fallback.
 */
export const TOOL_PANEL_MAP: Record<string, ToolPanel> = {
  // Deep lane (DEEP_LANE_2026-08-23.md): both tools share one async-run
  // panel — brief → watch → report — differing only in copy and protocol.
  'deep-research':      dynamic(() => import('./DeepRunPanel'),         { ssr: false, loading: PanelLoading }),
  'deep-think':         dynamic(() => import('./DeepRunPanel'),         { ssr: false, loading: PanelLoading }),
  'issue-tree':         dynamic(() => import('./IssueTreePanel'),       { ssr: false, loading: PanelLoading }),
  'decision-memo':      dynamic(() => import('./DecisionMemoPanel'),    { ssr: false, loading: PanelLoading }),
  'prioritization':     dynamic(() => import('./PrioritizationPanel'),  { ssr: false, loading: PanelLoading }),
  'data-insights':      dynamic(() => import('./DataInsightsPanel'),    { ssr: false, loading: PanelLoading }),
  'meeting-prep':       dynamic(() => import('./MeetingPrepPanel'),     { ssr: false, loading: PanelLoading }),
  'storyline':          dynamic(() => import('./StorylinePanel'),       { ssr: false, loading: PanelLoading }),
  'scpr':               dynamic(() => import('./SCPRPanel'),            { ssr: false, loading: PanelLoading }),
  'mckinsey-critic':    dynamic(() => import('./McKinseyCriticPanel'),  { ssr: false, loading: PanelLoading }),
  'ai-use-case-scorer': dynamic(() => import('./AIUseCaseScorerPanel'), { ssr: false, loading: PanelLoading }),
  'deck-pipeline':      dynamic(() => import('./DeckPipelinePanel'),    { ssr: false, loading: PanelLoading }),
  'gamma-deck':         dynamic(() => import('./GammaDeckPanel'),       { ssr: false, loading: PanelLoading }),
}
