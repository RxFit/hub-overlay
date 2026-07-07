import { describe, it, expect } from 'vitest'
import {
  DEFAULT_ROLES,
  canAssignRole,
  canAccessAdminRoute,
  resolveRole,
  roleHasModule,
  getPanelModulesForRole,
  listAvailableRoles,
} from './roles'
import type { RoleConfig, TenantConfig } from '@/types'

/* ════════════════════════════════════════════════════════════════════════════
   RBAC / role helpers — the pure decisions behind /admin access and role
   assignment. These are the guard predicates the middleware and admin/KPI API
   routes delegate to, so their behavior is locked here.
   ════════════════════════════════════════════════════════════════════════════ */

describe('canAccessAdminRoute', () => {
  it('allows only admin and superadmin', () => {
    expect(canAccessAdminRoute('admin')).toBe(true)
    expect(canAccessAdminRoute('superadmin')).toBe(true)
  })

  it('denies staff, onboarding, unknown roles, and missing role', () => {
    expect(canAccessAdminRoute('staff')).toBe(false)
    expect(canAccessAdminRoute('onboarding')).toBe(false)
    expect(canAccessAdminRoute('editor')).toBe(false)
    expect(canAccessAdminRoute('')).toBe(false)
    expect(canAccessAdminRoute(undefined)).toBe(false)
    expect(canAccessAdminRoute(null)).toBe(false)
  })

  it('matches the DEFAULT_ROLES.canAccessAdmin flag for every built-in role', () => {
    for (const [id, cfg] of Object.entries(DEFAULT_ROLES)) {
      expect(canAccessAdminRoute(id)).toBe(cfg.canAccessAdmin)
    }
  })
})

describe('canAssignRole', () => {
  it('lets superadmin assign any role', () => {
    for (const target of ['superadmin', 'admin', 'staff', 'onboarding']) {
      expect(canAssignRole('superadmin', target)).toBe(true)
    }
  })

  it('lets admin assign only staff and onboarding (never admin or superadmin)', () => {
    expect(canAssignRole('admin', 'staff')).toBe(true)
    expect(canAssignRole('admin', 'onboarding')).toBe(true)
    expect(canAssignRole('admin', 'admin')).toBe(false)
    expect(canAssignRole('admin', 'superadmin')).toBe(false)
  })

  it('denies non-privileged and unknown caller roles entirely', () => {
    for (const caller of ['staff', 'onboarding', 'editor', '']) {
      for (const target of ['superadmin', 'admin', 'staff', 'onboarding']) {
        expect(canAssignRole(caller, target)).toBe(false)
      }
    }
  })
})

describe('resolveRole', () => {
  it('returns the built-in config for known role ids', () => {
    expect(resolveRole('admin').id).toBe('admin')
    expect(resolveRole('staff').canAccessAdmin).toBe(false)
  })

  it('falls back to the safe onboarding config for unknown roles', () => {
    const resolved = resolveRole('does-not-exist')
    expect(resolved.id).toBe('onboarding')
    expect(resolved.canAccessAdmin).toBe(false)
    expect(resolved.canManageRoles).toBe(false)
  })

  it('prefers a tenant-specific override when present', () => {
    const custom: RoleConfig = {
      ...DEFAULT_ROLES.staff,
      id: 'staff',
      name: 'Custom Staff',
      canAccessAdmin: true,
    }
    const tenantConfig = { roles: { staff: custom } } as unknown as TenantConfig
    const resolved = resolveRole('staff', tenantConfig)
    expect(resolved.name).toBe('Custom Staff')
    expect(resolved.canAccessAdmin).toBe(true)
  })
})

describe('roleHasModule', () => {
  it('detects modules in either panel', () => {
    expect(roleHasModule(DEFAULT_ROLES.admin, 'kpi')).toBe(true)      // left
    expect(roleHasModule(DEFAULT_ROLES.admin, 'issues')).toBe(true)   // right
    expect(roleHasModule(DEFAULT_ROLES.staff, 'issues')).toBe(false)  // staff lacks issues
    expect(roleHasModule(DEFAULT_ROLES.admin, 'nonexistent')).toBe(false)
  })
})

describe('getPanelModulesForRole', () => {
  it('resolves configured module ids to real module objects, dropping unknowns', () => {
    const { left, right } = getPanelModulesForRole(DEFAULT_ROLES.admin)
    expect(left.map(m => m.id)).toEqual(['tasks', 'calendar', 'drive', 'kpi'])
    expect(right.map(m => m.id)).toContain('issues')
    // every returned entry is a fully-resolved module, never undefined
    expect([...left, ...right].every(m => typeof m.label === 'string')).toBe(true)
  })

  it('returns an empty right panel for onboarding', () => {
    const { right } = getPanelModulesForRole(DEFAULT_ROLES.onboarding)
    expect(right).toHaveLength(0)
  })
})

describe('listAvailableRoles', () => {
  it('lists the built-in roles by default', () => {
    expect(listAvailableRoles().sort()).toEqual(['admin', 'onboarding', 'staff', 'superadmin'])
  })

  it('merges tenant-specific roles without duplicating built-ins', () => {
    const tenantConfig = {
      roles: { staff: DEFAULT_ROLES.staff, viewer: DEFAULT_ROLES.onboarding },
    } as unknown as TenantConfig
    const roles = listAvailableRoles(tenantConfig)
    expect(roles).toContain('viewer')
    expect(roles.filter(r => r === 'staff')).toHaveLength(1) // no duplicate
  })
})
