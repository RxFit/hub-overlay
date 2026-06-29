'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { useDrive } from '@/app/hooks/useHubData'
import type { DriveFile } from '@/app/hooks/useHubData'
import type { ToolArtifactRecord } from '@/types'
import styles from './LeftPanelSections.module.css'
import { CollapsibleSection, SkeletonBlock, SectionMessage } from './LeftPanelShared'
import { formatRelativeDate, getDriveIcon } from './LeftPanelUtils'

/* ══════════════════════════════════════════════════════════════════════════════
   DOCUMENTS SECTION
   ══════════════════════════════════════════════════════════════════════════════ */

type DocFilter = 'recent' | 'shared' | 'artifacts' | 'transcripts'
const DOC_FILTERS: { key: DocFilter; label: string }[] = [
  { key: 'recent', label: 'Recent' },
  { key: 'shared', label: 'Shared' },
  { key: 'artifacts', label: 'Artifacts' },
  { key: 'transcripts', label: 'Transcripts' },
]

export function DocumentsSection({ onInjectChat }: { onInjectChat: (msg: string) => void }) {
  const [activeFilter, setActiveFilter] = useState<DocFilter>('recent')
  const { files, isLoading, error } = useDrive(activeFilter === 'artifacts' ? 'recent' : activeFilter)
  
  /* Fetch tool artifacts when artifacts tab is active */
  const { data: artifactsData, isLoading: artifactsLoading, error: artifactsError } = useSWR<{ artifacts: ToolArtifactRecord[] }>(
    activeFilter === 'artifacts' ? '/api/tool-artifacts' : null,
    (url: string) => fetch(url).then(r => r.json()),
    { revalidateOnFocus: false }
  )

  const isAuthError = error && (error as any)?.status === 401

  const emptyMessages: Record<DocFilter, string> = {
    recent: 'No recent files',
    shared: 'No shared files',
    artifacts: 'No saved artifacts — complete a tool session to create one',
    transcripts: 'No transcripts found',
  }

  /* Tool icon mapping for artifact cards */
  const getToolIcon = (toolId: string): string => {
    const icons: Record<string, string> = {
      'issue-tree': '🌳', 'decision-memo': '📋', 'prioritization': '📊',
      'data-insights': '📈', 'meeting-prep': '🤝', 'storyline': '📖',
      'scpr': '🔄', 'mckinsey-critic': '🔍', 'ai-use-case-scorer': '🤖',
      'deck-pipeline': '📑', 'gamma-deck': '🎨',
    }
    return icons[toolId] || '⚡'
  }

  return (
    <CollapsibleSection title="Documents" protocolNum="04" defaultOpen={false}>
      {/* Filter tabs */}
      <div className="doc-filter-tabs" role="tablist" aria-label="Document filters">
        {DOC_FILTERS.map((f) => (
          <button
            key={f.key}
            role="tab"
            aria-selected={activeFilter === f.key}
            className={`feed-filter-btn${activeFilter === f.key ? ' active' : ''}`}
            onClick={() => setActiveFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Artifacts tab content */}
      {activeFilter === 'artifacts' ? (
        artifactsLoading ? (
          <SkeletonBlock lines={3} />
        ) : artifactsError ? (
          <SectionMessage message="Unable to load artifacts" type="error" />
        ) : !artifactsData?.artifacts?.length ? (
          <SectionMessage message={emptyMessages.artifacts} type="empty" />
        ) : (
          <div role="list" aria-label="Saved tool artifacts">
            {artifactsData.artifacts.map((artifact) => (
              <button
                key={artifact.id}
                role="listitem"
                onClick={() => onInjectChat(`Show me the ${artifact.toolId} artifact: ${artifact.title}`)}
                aria-label={`Artifact: ${artifact.title}`}
                className={styles.sectionRow}
              >
                <span aria-hidden="true" className={styles.documentIcon}>
                  {getToolIcon(artifact.toolId)}
                </span>
                <div className={styles.documentInfo}>
                  <div className={styles.documentName}>{artifact.title}</div>
                  <div className={styles.documentModified}>
                    {artifact.toolId} · {new Date(artifact.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )
      ) : (
        /* Existing Drive file content */
        <>
          {isLoading ? (
            <SkeletonBlock lines={3} />
          ) : isAuthError ? (
            <SectionMessage message="Session expired — please sign in again" type="error" />
          ) : error ? (
            <SectionMessage message="Unable to load files — try refreshing or check your connection" type="error" />
          ) : files.length === 0 ? (
            <SectionMessage message={emptyMessages[activeFilter]} type="empty" />
          ) : (
            <div role="list" aria-label={`${activeFilter} documents`}>
              {files.map((file) => (
                <DocumentRow
                  key={file.id}
                  file={file}
                  onClick={() => {
                    const msg = activeFilter === 'transcripts'
                      ? `Summarize the meeting transcript: ${file.name}`
                      : `Find document: ${file.name}`
                    onInjectChat(msg)
                  }}
                />
              ))}
            </div>
          )}
        </>
      )}
    </CollapsibleSection>
  )
}

function DocumentRow({ file, onClick }: { file: DriveFile; onClick: () => void }) {
  const icon = getDriveIcon(file.mimeType)
  const modified = formatRelativeDate(file.modifiedTime)

  return (
    <button
      role="listitem"
      onClick={onClick}
      aria-label={`Document: ${file.name}, modified ${modified}`}
      className={styles.sectionRow}
    >
      {/* File type icon */}
      <span aria-hidden="true" className={styles.documentIcon}>
        {icon}
      </span>

      {/* File info */}
      <div className={styles.documentInfo}>
        <div className={styles.documentName}>
          {file.name}
        </div>
        <div className={styles.documentModified}>
          {modified}
        </div>
      </div>
    </button>
  )
}

