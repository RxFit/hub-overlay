'use client'

import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { signOut, useSession } from 'next-auth/react'
import Link from 'next/link'
import { useTenant } from './TenantProvider'
import { useCompanies } from '@/app/hooks/useCompanies'
import { useProjects } from '@/app/hooks/useProjects'

/* ── BrandedHeader ── */

interface BrandedHeaderProps {
  activeProject: string
  onProjectChange: (id: string) => void
  theme: 'dark' | 'light'
  onThemeToggle: () => void
  onOpenGoogleChat?: () => void
  chatUnreadCount?: number
}

export function BrandedHeader({
  activeProject,
  onProjectChange,
  theme,
  onThemeToggle,
  onOpenGoogleChat,
  chatUnreadCount = 0,
}: BrandedHeaderProps) {
  const tenant = useTenant()
  const { data: session } = useSession()
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // Live data — both scoped server-side by role
  const { companies, isLoading: companiesLoading } = useCompanies()
  const { projects, isLoading: projectsLoading } = useProjects()

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [menuOpen])

  const handleSignOut = useCallback(() => {
    setMenuOpen(false)
    signOut({ callbackUrl: '/login' })
  }, [])

  // User display info
  const userName = session?.user?.name || 'User'
  const userEmail = session?.user?.email || ''
  const userRole = (session?.user as Record<string, unknown>)?.role as string | undefined
  const ROLE_LABELS: Record<string, string> = {
    superadmin: 'Super Admin',
    admin: 'Admin',
    staff: 'Staff',
    onboarding: 'Member',
  }
  const userRoleLabel = userRole ? (ROLE_LABELS[userRole] ?? userRole) : 'Member'
  const userInitials = userName
    .split(' ')
    .map(w => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

  // Role-based selector mode
  const isSuperAdmin = userRole === 'superadmin'
  const isAdminOrAbove = userRole === 'superadmin' || userRole === 'admin'
  const showSelector = userRole && userRole !== 'onboarding'

  // Group projects by company for the dropdown optgroups
  const projectsByCompany = useMemo(() => {
    const groups: Record<string, typeof projects> = {}
    for (const p of projects) {
      const key = p.companyName || 'Uncategorized'
      if (!groups[key]) groups[key] = []
      groups[key].push(p)
    }
    return groups
  }, [projects])

  // Determine loading state based on which selector mode
  const selectorLoading = isSuperAdmin ? companiesLoading : projectsLoading

  return (
    <header className="hub-header" role="banner">
      <div className="hub-logo">
        <h1 className="hub-logo-text rx-shimmer">
          <span className="hub-logo-accent">{tenant.logoText}</span> {tenant.logoFull}
        </h1>
        <span className="hub-logo-badge">ops</span>
      </div>

      <nav className="header-actions" aria-label="Hub controls">
        {/* Selector — superadmin sees companies, admin/staff see projects */}
        {showSelector && (
          <>
            <label htmlFor="project-selector" className="sr-only">
              {isSuperAdmin ? 'Select workspace' : 'Select project'}
            </label>
            {selectorLoading ? (
              /* Skeleton placeholder */
              <div
                aria-hidden="true"
                style={{
                  width: '140px',
                  height: '32px',
                  borderRadius: '6px',
                  background: 'rgba(255,255,255,0.06)',
                  animation: 'pulse 1.5s ease-in-out infinite',
                }}
              />
            ) : isSuperAdmin ? (
              /* ── SUPERADMIN: Company/workspace selector ── */
              <select
                id="project-selector"
                value={activeProject}
                onChange={e => onProjectChange(e.target.value)}
                aria-label="Select workspace"
                className="project-selector"
                disabled={companies.length === 0}
              >
                <option value="all">All Workspaces</option>
                {companies.map(c => (
                  <option key={c.id} value={c.id}>
                    [{c.identifier?.slice(0, 2).toUpperCase() ?? c.id.slice(0, 2).toUpperCase()}] {c.name}
                  </option>
                ))}
              </select>
            ) : (
              /* ── ADMIN / STAFF: Projects selector (grouped by company) ── */
              <select
                id="project-selector"
                value={activeProject}
                onChange={e => onProjectChange(e.target.value)}
                aria-label="Select project"
                className="project-selector"
                disabled={projects.length === 0}
              >
                {isAdminOrAbove && (
                  <option value="all">All Projects</option>
                )}
                {projects.length === 0 ? (
                  <option value="" disabled>No projects yet</option>
                ) : (
                  Object.entries(projectsByCompany).map(([companyName, companyProjects]) => (
                    <optgroup key={companyName} label={companyName}>
                      {companyProjects.map(p => (
                        <option key={p.id} value={p.id}>
                          {p.name}{p.status !== 'started' ? ` (${p.status})` : ''}
                        </option>
                      ))}
                    </optgroup>
                  ))
                )}
              </select>
            )}
          </>
        )}

        {/* Google Chat button — desktop view */}
        {session && onOpenGoogleChat && (
          <button
            className="theme-toggle-btn desktop-only"
            onClick={onOpenGoogleChat}
            aria-label="Google Chat"
            title="Google Chat"
            style={{ position: 'relative' }}
          >
            <span style={{ fontSize: '1.2rem', marginTop: '2px', display: 'inline-block' }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </span>
            {chatUnreadCount > 0 && (
              <span style={{
                position: 'absolute', top: '0px', right: '0px',
                background: 'var(--accent)', color: 'var(--btn-text)',
                fontSize: '10px', padding: '2px 6px', borderRadius: '12px',
                fontWeight: 'bold', transform: 'translate(25%, -25%)'
              }}>
                {chatUnreadCount > 99 ? '99+' : chatUnreadCount}
              </span>
            )}
          </button>
        )}

        <button
          className="theme-toggle-btn"
          onClick={onThemeToggle}
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
        >
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>

        {/* User menu with dropdown */}
        <div ref={menuRef} style={{ position: 'relative' }}>
          <button
            className="header-user"
            onClick={() => setMenuOpen(prev => !prev)}
            aria-label="User menu"
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            style={{ cursor: 'pointer', border: 'none', background: 'transparent' }}
          >
            <div className="header-avatar" aria-hidden="true">
              {userInitials}
            </div>
            <span className="header-username">{userName.split(' ')[0]}</span>
          </button>

          {/* Dropdown menu */}
          {menuOpen && (
            <div
              role="menu"
              aria-label="User options"
              className="header-dropdown-menu"
            >
              {/* User info */}
              <div className="header-dropdown-user-info">
                <div className="header-dropdown-user-name">{userName}</div>
                <div className="header-dropdown-user-email">{userEmail}</div>
                <div className="header-dropdown-user-role">{tenant.name} · {userRoleLabel}</div>
              </div>

              {/* Menu items */}
              <div style={{ padding: '6px' }}>
                <Link href="/settings" style={{ display: 'block', padding: '6px 12px', color: 'inherit', textDecoration: 'none' }}>
                  <span style={{ fontSize: '1rem', marginRight: '8px' }}>⚙️</span>
                  Settings
                </Link>
                <button
                  role="menuitem"
                  onClick={handleSignOut}
                  className="header-dropdown-signout"
                >
                  <span style={{ fontSize: '1rem' }}>↳</span>
                  Sign Out
                </button>
              </div>
            </div>
          )}
        </div>
      </nav>
    </header>
  )
}
