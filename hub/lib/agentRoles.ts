/**
 * Agent role classification — the ONE place agent names map to C-Suite roles.
 *
 * Before the 2026-07-19 cleanup this concern lived in three conflicting
 * places: hardcoded officer UUIDs in paperclipConfig.ts (zero consumers),
 * keyword matching inside the ceo-pulse route, and display labels in
 * useBusinessManager. Roles are resolved by NAME because agents are created
 * and renamed in Paperclip at runtime — fixed UUIDs drift.
 *
 * Pure module: safe to import from client and server code.
 */

import type { AgentRoleKey } from '@/types'

export const ROLE_KEYWORDS: Record<AgentRoleKey, string[]> = {
  ceo:       ['ceo', 'chief executive', 'board'],
  cmo:       ['cmo', 'marketing', 'content', 'seo', 'brand'],
  cto:       ['cto', 'technical', 'engineer', 'dev', 'tech'],
  cfo:       ['cfo', 'finance', 'revenue', 'billing', 'stripe'],
  coo:       ['coo', 'operations', 'ops', 'comms'],
}

export function classifyAgentRole(agentName: string): AgentRoleKey {
  const lower = agentName.toLowerCase()
  for (const [role, keywords] of Object.entries(ROLE_KEYWORDS)) {
    if (keywords.some((k) => lower.includes(k))) {
      return role as AgentRoleKey
    }
  }
  return 'ceo'
}

export const ROLE_DISPLAY: Record<AgentRoleKey, string> = {
  ceo: 'CEO',
  cmo: 'CMO',
  cto: 'CTO',
  cfo: 'CFO',
  coo: 'COO',
}

/** Human-readable label for a role key (unknown keys fall back to uppercase). */
export function roleLabel(role: string): string {
  return ROLE_DISPLAY[role as AgentRoleKey] ?? role.toUpperCase()
}
