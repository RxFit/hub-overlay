'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import type { SkillPlugin } from '@/types'

interface SkillSummary {
  id: string
  name: string
  description: string
  plugin: SkillPlugin
}

interface SkillsPopoverProps {
  isOpen: boolean
  onClose: () => void
  onActivate: (skillId: string) => void
  suggestedTools: string[]
  activeSkillId: string | null
  skillCatalog: SkillSummary[]
}

export function SkillsPopover({
  isOpen,
  onClose,
  onActivate,
  suggestedTools,
  activeSkillId,
  skillCatalog,
}: SkillsPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null)
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    'enterprise-ai': true,
    'gstack': true,
  })

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    // Delay to avoid the opening click triggering close
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside)
    }, 50)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen, onClose])

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [isOpen, onClose])

  const toggleSection = useCallback((section: string) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }))
  }, [])

  if (!isOpen) return null

  // Filter skills to only those suggested by the AI
  const hasSuggestions = suggestedTools.length > 0
  const filteredCatalog = hasSuggestions
    ? skillCatalog.filter(s => suggestedTools.includes(s.id))
    : []

  // Group by plugin
  const grouped: Record<string, SkillSummary[]> = {}
  for (const skill of filteredCatalog) {
    if (!grouped[skill.plugin]) grouped[skill.plugin] = []
    grouped[skill.plugin].push(skill)
  }

  const sectionLabels: Record<string, string> = {
    'enterprise-ai': 'Enterprise AI',
    'gstack': 'gstack',
  }

  return (
    <div ref={popoverRef} className="skills-popover" role="menu" aria-label="Available skills">
      {/* Close button */}
      <button
        className="skills-popover__close"
        onClick={onClose}
        aria-label="Close skills menu"
      >
        ✕
      </button>

      {!hasSuggestions ? (
        /* Empty state hint */
        <div className="skills-popover__hint">
          <span className="skills-popover__hint-icon" aria-hidden="true">✦</span>
          <p>Start a conversation and I&apos;ll suggest relevant tools for your task.</p>
        </div>
      ) : (
        /* Skill sections */
        Object.entries(grouped).map(([plugin, skills]) => (
          <div key={plugin} className="skills-popover__section">
            <button
              className="skills-popover__section-header"
              onClick={() => toggleSection(plugin)}
              aria-expanded={expandedSections[plugin]}
            >
              <span className="skills-popover__section-label">
                {sectionLabels[plugin] || plugin}
              </span>
              <span className="skills-popover__section-count">{skills.length}</span>
              <span
                className={`skills-popover__chevron ${expandedSections[plugin] ? 'skills-popover__chevron--open' : ''}`}
                aria-hidden="true"
              >
                ›
              </span>
            </button>

            {expandedSections[plugin] && (
              <div className="skills-popover__skill-list">
                {skills.map(skill => (
                  <button
                    key={skill.id}
                    className={`skills-popover__skill-row ${activeSkillId === skill.id ? 'skills-popover__skill-row--active' : ''}`}
                    onClick={() => onActivate(skill.id)}
                    role="menuitem"
                  >
                    <span className="skills-popover__skill-name">{skill.name || skill.id}</span>
                    <span className="skills-popover__skill-desc">{skill.description}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ))
      )}
    </div>
  )
}
