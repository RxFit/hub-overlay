import { lazy } from 'react'
import type { ComponentType } from 'react'
import type { ToolPanelContentProps } from '@/types'

type LazyPanel = React.LazyExoticComponent<ComponentType<ToolPanelContentProps>>

/**
 * Registry mapping each toolId to its lazily-loaded panel component.
 * Panels are code-split so only the active tool's panel is downloaded.
 */
export const TOOL_PANEL_MAP: Record<string, LazyPanel> = {
  'issue-tree':         lazy(() => import('./IssueTreePanel')),
  'decision-memo':      lazy(() => import('./DecisionMemoPanel')),
  'prioritization':     lazy(() => import('./PrioritizationPanel')),
  'data-insights':      lazy(() => import('./DataInsightsPanel')),
  'meeting-prep':       lazy(() => import('./MeetingPrepPanel')),
  'storyline':          lazy(() => import('./StorylinePanel')),
  'scpr':               lazy(() => import('./SCPRPanel')),
  'mckinsey-critic':    lazy(() => import('./McKinseyCriticPanel')),
  'ai-use-case-scorer': lazy(() => import('./AIUseCaseScorerPanel')),
  'deck-pipeline':      lazy(() => import('./DeckPipelinePanel')),
  'gamma-deck':         lazy(() => import('./GammaDeckPanel')),
}
