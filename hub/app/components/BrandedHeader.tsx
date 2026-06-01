'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { signOut, useSession } from 'next-auth/react'
import Link from 'next/link'
import { useTenant } from './TenantProvider'

/* ── BrandedHeader ── */

interface BrandedHeaderProps {
  activeProject: string
  onProjectChange: (id: string) => void
  theme: 'dark' | 'light'
  onThemeToggle: () => void
}

export function BrandedHeader({
  activeProject,
  onProjectChange,
  theme,
  onThemeToggle,
}: BrandedHeaderProps) {
  const tenant = useTenant()
  const { data: session } = useSession()
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

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
  const userInitials = userName
    .split(' ')
    .map(w => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

  return (
    <header className="hub-header" role="banner">
      <div className="hub-logo">
        <h1 className="hub-logo-text rx-shimmer">
          <span className="hub-logo-accent">{tenant.logoText}</span> {tenant.logoFull}
        </h1>
        <span className="hub-logo-badge">ops</span>
      </div>

      <nav className="header-actions" aria-label="Hub controls">
        <label htmlFor="project-selector" className="sr-only">Select project</label>
        <select
          id="project-selector"
          value={activeProject}
          onChange={e => onProjectChange(e.target.value)}
          aria-label="Select project"
          className="project-selector"
        >
          <option value="all">All Projects</option>
          {tenant.projects.map(p => (
            <option key={p.id} value={p.id}>[{p.abbr}] {p.name}</option>
          ))}
        </select>

        {/* Settings gear — admin only */}
        {(session?.user as Record<string, unknown>)?.role === 'admin' && (
          <Link
            href="/settings"
            className="theme-toggle-btn"
            aria-label="Hub Settings"
            title="Hub Settings"
          >
            ⚙️
          </Link>
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
                <div className="header-dropdown-user-role">{tenant.name} · Admin</div>
              </div>

              {/* Menu items */}
              <div style={{ padding: '6px' }}>
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
