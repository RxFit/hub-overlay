import type { NextAuthOptions } from 'next-auth'
import type { JWT } from 'next-auth/jwt'
import GoogleProvider from 'next-auth/providers/google'
import { getUserRole } from '@/lib/hubRoles'

/* ── Admin email lists (comma-separated env vars) ── */
const SUPERADMIN_EMAILS = (process.env.SUPERADMIN_EMAILS || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean)

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean)

/* ── Google Workspace OAuth scopes ── */
const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/spreadsheets',  // read-write for Hub Roles sheet
  // Google Chat — read spaces + messages, send messages
  'https://www.googleapis.com/auth/chat.spaces.readonly',
  'https://www.googleapis.com/auth/chat.messages',
  'https://www.googleapis.com/auth/chat.messages.create',
  // Google Chat — member listing (for @mentions) + read state (for unread badges)
  'https://www.googleapis.com/auth/chat.memberships.readonly',
  'https://www.googleapis.com/auth/chat.users.readstate.readonly',
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
 * 1. SUPERADMIN_EMAILS env var → 'superadmin' (bypass sheet lookup)
 * 2. ADMIN_EMAILS env var → 'admin' (bypass sheet lookup)
 * 3. Hub Roles Sheet lookup → assigned role or 'onboarding' fallback
 */
async function resolveUserRole(
  email: string,
  accessToken: string
): Promise<{ role: string; assignedProjects: string[] }> {
  const normalized = email.toLowerCase()

  // TEMP DIAGNOSTIC LOG — remove after confirming superadmin
  console.log(`[auth] resolveUserRole called: email="${email}" normalized="${normalized}" SUPERADMIN_EMAILS=${JSON.stringify(SUPERADMIN_EMAILS)} match=${SUPERADMIN_EMAILS.includes(normalized)}`)

  // Env var overrides always win — these are infra-level assignments
  if (SUPERADMIN_EMAILS.includes(normalized)) {
    return { role: 'superadmin', assignedProjects: ['*'] }
  }
  if (ADMIN_EMAILS.includes(normalized)) {
    return { role: 'admin', assignedProjects: ['*'] }
  }

  // Sheet lookup — falls back to { role: 'onboarding', assignedProjects: [] }
  try {
    return await getUserRole(email, accessToken, process.env.HUB_ROLES_SHEET_ID)
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

        const { role, assignedProjects } = await resolveUserRole(email, accessToken)

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

      // Re-check role from sheet on every token refresh (~1hr cadence)
      const email = (token.email as string || '').toLowerCase()
      const { role, assignedProjects } = await resolveUserRole(
        email,
        refreshed.accessToken as string
      )

      return { ...refreshed, role, assignedProjects }
    },

    async session({ session, token }) {
      // TEMP DIAGNOSTIC — remove after superadmin confirmed
      console.log(`[auth] session callback: token.role="${String(token.role)}" token.email="${String(token.email)}"`)
      if (session.user) {
        const u = session.user as Record<string, unknown>
        u.role = token.role
        u.assignedProjects = token.assignedProjects
        u.id = token.sub
        u.error = token.error
        console.log(`[auth] session.user.role set to "${String(u.role)}"`)
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
