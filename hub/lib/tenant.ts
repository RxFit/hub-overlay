/**
 * White-Label Tenant Configuration
 *
 * Each tenant gets its own branding, projects, roles, and Google Workspace config.
 * The active tenant is determined by NEXT_PUBLIC_TENANT_ID env var (defaults to 'rxfit').
 *
 * The TenantConfig drives:
 * - Header logo text & tagline
 * - CSS custom properties (brand colors) injected at runtime
 * - Project selector options
 * - Role permissions
 * - KPI sheet binding
 */

import type { RoleConfig } from '@/types'

/* ── Tenant Config Interface ── */

export interface TenantBrandColors {
  accent: string
  accentDim: string
  accentBright: string
  bgVoid: string
  bgPrimary: string
}

export interface TenantProject {
  id: string
  name: string
  abbr: string
  color: string
}

export interface TenantConfig {
  id: string
  name: string                     // 'RxFit', 'Rose Pop Parties'
  domain: string                   // 'hub.casatrejo.com'
  tagline: string                  // 'Biological Performance Command Center'
  logoText: string                 // 'CT' (the accent text in header)
  logoFull: string                 // 'HUB' (text after accent)
  brandColors: TenantBrandColors
  googleWorkspaceId?: string
  kpiSheetId?: string
  kpiSheetRange?: string           // default 'KPIs!A2:D10'
  hubRolesSheetId?: string         // Hub Roles Google Sheet ID for role management
  roles: Record<string, RoleConfig>
  projects: TenantProject[]
}

/* ── Default Role Configs ── */

const SUPERADMIN_ROLE: RoleConfig = {
  id: 'superadmin',
  name: 'Super Admin',
  description: 'Master orchestrator — can assign admin roles across companies',
  leftPanelModules: ['tasks', 'calendar', 'drive', 'sheets-kpi'],
  rightPanelModules: ['feed', 'agent-runs', 'issues', 'notifications'],
  canChat: true,
  canManageRoles: true,
  canViewAllProjects: true,
  canUseInterviewMode: true,
  canAccessAdmin: true,
}

const ADMIN_ROLE: RoleConfig = {
  id: 'admin',
  name: 'Admin',
  description: 'Business admin — can assign roles up to staff within their company',
  leftPanelModules: ['tasks', 'calendar', 'drive', 'sheets-kpi'],
  rightPanelModules: ['feed', 'agent-runs', 'issues', 'notifications'],
  canChat: true,
  canManageRoles: true,
  canViewAllProjects: true,
  canUseInterviewMode: true,
  canAccessAdmin: true,
}

const STAFF_ROLE: RoleConfig = {
  id: 'staff',
  name: 'Staff',
  description: 'Full operational access to assigned projects',
  leftPanelModules: ['tasks', 'calendar', 'drive', 'sheets-kpi'],
  rightPanelModules: ['feed', 'notifications'],
  canChat: true,
  canManageRoles: false,
  canViewAllProjects: false,
  canUseInterviewMode: true,
  canAccessAdmin: false,
}

const ONBOARDING_ROLE: RoleConfig = {
  id: 'onboarding',
  name: 'Onboarding',
  description: 'Default role for new users — full left panel + chat, awaiting role assignment',
  leftPanelModules: ['tasks', 'calendar', 'drive', 'sheets-kpi'],
  rightPanelModules: [],
  canChat: true,
  canManageRoles: false,
  canViewAllProjects: false,
  canUseInterviewMode: false,
  canAccessAdmin: false,
}

/* ── Tenant Configs Map ── */

export const TENANT_CONFIGS: Record<string, TenantConfig> = {
  rxfit: {
    id: 'rxfit',
    name: 'RxFit',
    domain: 'hub.casatrejo.com',
    tagline: 'Biological Performance Command Center',
    logoText: 'CT',
    logoFull: 'HUB',
    brandColors: {
      accent: '#C5A059',
      accentDim: '#8a6e3e',
      accentBright: '#d4b572',
      bgVoid: '#060d1f',
      bgPrimary: '#0a1128',
    },
    kpiSheetRange: 'KPIs!A2:D10',
    hubRolesSheetId: process.env.HUB_ROLES_SHEET_ID,
    roles: { superadmin: SUPERADMIN_ROLE, admin: ADMIN_ROLE, staff: STAFF_ROLE, onboarding: ONBOARDING_ROLE },
    projects: [
      { id: 'rxfit',       name: 'RxFit',       abbr: 'RX', color: '#C5A059' },
      { id: 'fridgesnap',  name: 'FridgeSnap',  abbr: 'FS', color: '#4A6FA5' },
      { id: 'jadecoss',    name: 'JadeCoS',     abbr: 'JC', color: '#8a6e3e' },
      { id: 'wellnessapp', name: 'WellnessApp', abbr: 'WA', color: '#d4b572' },
      { id: 'notebookrx',  name: 'NotebookRx',  abbr: 'NR', color: '#9aa8c6' },
      { id: 'seo-agent',   name: 'RxFit SEO',   abbr: 'SE', color: '#ef4444' },
    ],
  },

  rosepop: {
    id: 'rosepop',
    name: 'Rose Pop Parties',
    domain: 'rosepop.hub.casatrejo.com',
    tagline: 'Event Operations Command Center',
    logoText: 'RP',
    logoFull: 'HUB',
    brandColors: {
      accent: '#E91E8C',
      accentDim: '#B0156A',
      accentBright: '#FF69B4',
      bgVoid: '#1a0a14',
      bgPrimary: '#220e1a',
    },
    kpiSheetRange: 'KPIs!A2:D10',
    hubRolesSheetId: process.env.HUB_ROLES_SHEET_ID,
    roles: { superadmin: SUPERADMIN_ROLE, admin: ADMIN_ROLE, staff: STAFF_ROLE, onboarding: ONBOARDING_ROLE },
    projects: [
      { id: 'events',     name: 'Events',      abbr: 'EV', color: '#E91E8C' },
      { id: 'venues',     name: 'Venues',       abbr: 'VN', color: '#FF69B4' },
      { id: 'vendors',    name: 'Vendors',      abbr: 'VD', color: '#B0156A' },
      { id: 'marketing',  name: 'Marketing',    abbr: 'MK', color: '#FF1493' },
    ],
  },
}

/* ── Helper: get active tenant config ── */

/**
 * Returns the TenantConfig for the current tenant.
 * Reads from NEXT_PUBLIC_TENANT_ID env var, defaults to 'rxfit'.
 */
export function getTenantConfig(): TenantConfig {
  const tenantId =
    (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_TENANT_ID) || 'rxfit'
  return TENANT_CONFIGS[tenantId] ?? TENANT_CONFIGS.rxfit
}

/**
 * Get a tenant config by explicit ID.
 */
export function getTenantConfigById(id: string): TenantConfig | undefined {
  return TENANT_CONFIGS[id]
}

/**
 * List all registered tenant IDs.
 */
export function listTenantIds(): string[] {
  return Object.keys(TENANT_CONFIGS)
}
