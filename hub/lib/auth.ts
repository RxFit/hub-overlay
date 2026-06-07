import type { NextAuthOptions } from 'next-auth'
import type { JWT } from 'next-auth/jwt'
import GoogleProvider from 'next-auth/providers/google'
import { getAllRoleEntries } from '@/lib/userRoles'

/* ── Admin email lists (comma-separated env vars) ── */
const SUPERADMIN_EMAILS = (process.env.SUPERADMIN_EMAILS || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean)

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean)

/* ── Google Workspace OAuth scopes ── */

/** Base scopes — minimal permissions for dashboard access on initial sign-in */
const BASE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive.readonly',
]

/**
 * Elevated scopes — requested alongside base scopes today, but structured
 * for future incremental auth (request only when the feature is first used).
 * TODO: Implement /api/auth/upgrade-scopes endpoint + frontend prompt.
 */
export const ELEVATED_SCOPES = {
  gmail: [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.modify',
  ],
  chat: [
    'https://www.googleapis.com/auth/chat.spaces.readonly',
    'https://www.googleapis.com/auth/chat.messages',
    'https://www.googleapis.com/auth/chat.messages.create',
    'https://www.googleapis.com/auth/chat.memberships.readonly',
    'https://www.googleapis.com/auth/chat.users.readstate.readonly',
  ],
  analytics: [
    'https://www.googleapis.com/auth/analytics.readonly',
    'https://www.googleapis.com/auth/webmasters.readonly',
  ],
}

/** Combined scopes — used for sign-in until incremental auth is implemented */
const GOOGLE_SCOPES = [
  ...BASE_SCOPES,
  ...ELEVATED_SCOPES.gmail,
  ...ELEVATED_SCOPES.chat,
  ...ELEVATED_SCOPES.analytics,
].join(' ')


/* ── Token refresh helper ── */
async function refreshAccessToken(token: JWT): Promise<JWT> {
  try {
    const url = 'https://oauth2.googleapis.com/token'
    const body = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID || '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
      grant_type: 'refresh_token',
      refresh_token: token.refreshToken as string,
    })

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })

    const refreshed = await res.json()
    if (!res.ok) throw refreshed

    return {
      ...token,
      accessToken: refreshed.access_token as string,
      accessTokenExpires: Date.now() + (refreshed.expires_in as number) * 1000,
      refreshToken: (refreshed.refresh_token as string) ?? token.refreshToken,
    }
  } catch (error) {
    console.error('Error refreshing access token:', error)
    return { ...token, error: 'RefreshAccessTokenError' }
  }
}

/**
 * Resolve the effective role for an email address.
 *
 * Priority:
 * 1. SUPERADMIN_EMAILS env var → 'superadmin' (bypass DB lookup)
 * 2. ADMIN_EMAILS env var → 'admin' (bypass DB lookup)
 * 3. Database lookup → assigned role or 'onboarding' fallback
 */
async function resolveUserRole(
  email: string
): Promise<{ role: string; assignedProjects: string[] }> {
  const normalized = email.toLowerCase()

  // Env var overrides always win — these are infra-level assignments
  if (SUPERADMIN_EMAILS.includes(normalized)) {
    return { role: 'superadmin', assignedProjects: ['*'] }
  }
  if (ADMIN_EMAILS.includes(normalized)) {
    return { role: 'admin', assignedProjects: ['*'] }
  }

  // Database lookup — falls back to { role: 'onboarding', assignedProjects: [] }
  try {
    // Check if user has an existing row in DB
    const allEntries = await getAllRoleEntries()
    const existingEntry = allEntries.find(e => e.email === normalized)

    if (existingEntry) {
      // User has an explicit row — return their assigned role
      return { role: existingEntry.role, assignedProjects: existingEntry.assignedProjects }
    }

    // User not found in DB — auto-create as onboarding
    try {
      const { upsertUserRole } = await import('@/lib/userRoles')
      await upsertUserRole({
        email: normalized,
        role: 'onboarding',
        assignedProjects: [],
        assignedBy: 'system',
      })
    } catch (err) {
      console.error('[auth] Failed to auto-create user row:', err)
    }

    return { role: 'onboarding', assignedProjects: [] }
  } catch {
    return { role: 'onboarding', assignedProjects: [] }
  }
}

export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID || '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
      authorization: {
        params: {
          scope: GOOGLE_SCOPES,
          access_type: 'offline',
          prompt: 'consent',
        },
      },
    }),
  ],
  session: {
    strategy: 'jwt',
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },
  callbacks: {
    async jwt({ token, user, account }) {
      // ── Initial sign-in: capture OAuth tokens and resolve role ──
      if (account && user) {
        const email = (user.email || '').toLowerCase()
        const accessToken = account.access_token as string

        const { role, assignedProjects } = await resolveUserRole(email)

        // Save refresh token to database for background tasks
        if (account.refresh_token) {
          const { upsertUserRole } = await import('@/lib/userRoles')
          await upsertUserRole({
            email,
            role,
            assignedProjects,
            assignedBy: 'system',
            googleRefreshToken: account.refresh_token as string,
          }).catch(err => console.error('[auth] Failed to save refresh token:', err))
        }

        return {
          ...token,
          accessToken,
          refreshToken: account.refresh_token as string,
          accessTokenExpires: (account.expires_at as number) * 1000,
          role,
          assignedProjects,
        }
      }

      // ── Token still valid: return as-is ──
      if (Date.now() < (token.accessTokenExpires as number)) {
        return token
      }

      // ── Token expired: refresh access token and re-resolve role ──
      const refreshed = await refreshAccessToken(token)
      if (refreshed.error) return refreshed  // propagate error, keep stale role

      // Re-check role from DB on every token refresh (~1hr cadence)
      const email = (token.email as string || '').toLowerCase()
      const { role, assignedProjects } = await resolveUserRole(email)

      return { ...refreshed, role, assignedProjects }
    },

    async session({ session, token }) {
      if (session.user) {
        const u = session.user as Record<string, unknown>
        u.role = token.role
        u.assignedProjects = token.assignedProjects
        u.id = token.sub
        u.error = token.error
      }
      return session
    },
  },
  pages: {
    signIn: '/login',
    error: '/login',
  },
  secret: process.env.NEXTAUTH_SECRET,
}
