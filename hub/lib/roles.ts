/**
 * Dynamic Role Configuration System
 *
 * Roles are admin-configured per tenant. This module provides:
 * - Default role definitions (superadmin, admin, staff, onboarding)
 * - Panel module registry
 * - Helpers to check module access and resolve effective roles
 */

import type { RoleConfig, PanelModule, TenantConfig } from '@/types'

/* ── All available panel modules ── */

export const ALL_PANEL_MODULES: PanelModule[] = [
  // Left Panel — Context Layer (WHAT to do)
  { id: 'tasks', label: 'Google Tasks', panel: 'left', icon: 'check-square' },
  { id: 'calendar', label: 'Calendar', panel: 'left', icon: 'calendar' },
  { id: 'drive', label: 'Drive Files', panel: 'left', icon: 'folder' },
  { id: 'kpi', label: 'KPI Dashboard', panel: 'left', icon: 'bar-chart' },

  // Right Panel — Execution Layer (HOW it's happening)
  { id: 'feed', label: 'Activity Feed', panel: 'right', icon: 'activity' },
  { id: 'agent-runs', label: 'Agent Runs', panel: 'right', icon: 'cpu' },
  { id: 'issues', label: 'Issues', panel: 'right', icon: 'alert-circle' },
  { id: 'notifications', label: 'Notifications', panel: 'right', icon: 'bell' },
]

/* ── Default role configs ── */

export const DEFAULT_ROLES: Record<string, RoleConfig> = {
  superadmin: {
    id: 'superadmin',
    name: 'Super Admin',
    description: 'Master orchestrator — can assign admin roles across companies',
    leftPanelModules: ['tasks', 'calendar', 'drive', 'kpi'],
    rightPanelModules: ['feed', 'agent-runs', 'issues', 'notifications'],
    canChat: true,
    canManageRoles: true,
    canViewAllProjects: true,
    canUseInterviewMode: true,
    canAccessAdmin: true,
  },
  admin: {
    id: 'admin',
    name: 'Admin',
    description: 'Business admin — can assign roles up to staff within their company',
    leftPanelModules: ['tasks', 'calendar', 'drive', 'kpi'],
    rightPanelModules: ['feed', 'agent-runs', 'issues', 'notifications'],
    canChat: true,
    canManageRoles: true,
    canViewAllProjects: true,
    canUseInterviewMode: true,
    canAccessAdmin: true,
  },
  staff: {
    id: 'staff',
    name: 'Staff',
    description: 'Full operational access to assigned projects',
    leftPanelModules: ['tasks', 'calendar', 'drive', 'kpi'],
    rightPanelModules: ['feed', 'notifications'],
    canChat: true,
    canManageRoles: false,
    canViewAllProjects: false,
    canUseInterviewMode: true,
    canAccessAdmin: false,
  },
  onboarding: {
    id: 'onboarding',
    name: 'Onboarding',
    description: 'Default role for new users — full left panel + chat, awaiting role assignment',
    leftPanelModules: ['tasks', 'calendar', 'drive', 'kpi'],
    rightPanelModules: [],  // right panel hidden until assigned
    canChat: true,
    canManageRoles: false,
    canViewAllProjects: false,
    canUseInterviewMode: false,  // Interview Mode disabled until assigned
    canAccessAdmin: false,
  },
}

/* ── Helpers ── */

/**
 * Check if a role has access to a specific panel module.
 */
export function roleHasModule(role: RoleConfig, moduleId: string): boolean {
  return (
    role.leftPanelModules.includes(moduleId) ||
    role.rightPanelModules.includes(moduleId)
  )
}

/**
 * Get the RoleConfig for a given role ID.
 * Falls back to DEFAULT_ROLES if no tenant config is provided.
 * Unknown roles default to 'onboarding' (safe default).
 */
export function resolveRole(
  roleId: string,
  tenantConfig?: TenantConfig
): RoleConfig {
  // Check tenant-specific overrides first
  if (tenantConfig?.roles?.[roleId]) {
    return tenantConfig.roles[roleId]
  }

  // Fall back to defaults
  return DEFAULT_ROLES[roleId] ?? DEFAULT_ROLES.onboarding
}

/**
 * Get the panel modules for a role, split into left and right.
 */
export function getPanelModulesForRole(role: RoleConfig): {
  left: PanelModule[]
  right: PanelModule[]
} {
  const moduleMap = new Map(ALL_PANEL_MODULES.map((m) => [m.id, m]))

  return {
    left: role.leftPanelModules
      .map((id) => moduleMap.get(id))
      .filter((m): m is PanelModule => m !== undefined),
    right: role.rightPanelModules
      .map((id) => moduleMap.get(id))
      .filter((m): m is PanelModule => m !== undefined),
  }
}

/**
 * List all available role IDs (default + tenant-specific).
 */
export function listAvailableRoles(tenantConfig?: TenantConfig): string[] {
  const defaultIds = Object.keys(DEFAULT_ROLES)
  const tenantIds = tenantConfig?.roles ? Object.keys(tenantConfig.roles) : []
  return Array.from(new Set([...defaultIds, ...tenantIds]))
}

/**
 * Check if a caller role can assign a target role.
 * superadmin → can assign any role
 * admin → can assign staff or onboarding only
 */
export function canAssignRole(callerRole: string, targetRole: string): boolean {
  if (callerRole === 'superadmin') return true
  if (callerRole === 'admin') return ['staff', 'onboarding'].includes(targetRole)
  return false
}

/**
 * The single predicate that decides who may reach the /admin surface: only
 * `admin` and `superadmin`. Extracted as a pure function so the guard can be
 * unit-tested directly (middleware.ts and the admin/KPI API routes are otherwise
 * hard to exercise). Any other role — including `staff`, `onboarding`, unknown
 * strings, and undefined/null — is denied.
 */
export function canAccessAdminRoute(role: string | null | undefined): boolean {
  return role === 'admin' || role === 'superadmin'
}
