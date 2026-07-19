import type { NextAuthOptions } from 'next-auth'
import type { JWT } from 'next-auth/jwt'
import GoogleProvider from 'next-auth/providers/google'
import { getAllRoleEntries, getUserRole } from '@/lib/userRoles'

/* ── Admin email lists (comma-separated env vars) ── */
const SUPERADMIN_EMAILS = (process.env.SUPERADMIN_EMAILS || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean)

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean)

/* ── Sign-in domain allowlist (P1) ──
 * Extract the domain portion of an email, lowercased. Returns '' if malformed. */
function emailDomain(email: string): string {
  const at = email.lastIndexOf('@')
  return at >= 0 ? email.slice(at + 1).trim().toLowerCase() : ''
}

/**
 * Domains permitted to sign in even without a pre-assigned role.
 *
 * From `ALLOWED_EMAIL_DOMAINS` (comma-separated, a leading '@' is tolerated).
 * When UNSET we DERIVE the default from the domains of the configured
 * superadmin/admin emails — so the real operators' company domain keeps working
 * out of the box without hardcoding any company domain here. If nothing is
 * configured at all, this is empty and only explicitly-listed/DB-assigned users
 * may sign in (fail closed).
 */
const CONFIGURED_ADMIN_DOMAINS = Array.from(
  new Set([...SUPERADMIN_EMAILS, ...ADMIN_EMAILS].map(emailDomain).filter(Boolean)),
)

const ALLOWED_EMAIL_DOMAINS: string[] = (() => {
  const explicit = (process.env.ALLOWED_EMAIL_DOMAINS || '')
    .split(',')
    .map(d => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean)
  return explicit.length > 0 ? explicit : CONFIGURED_ADMIN_DOMAINS
})()

/**
 * Individually-invited external accounts (comma-separated env var). For guests
 * on consumer domains (e.g. a family member's gmail.com) where allowlisting
 * the whole domain would open the gate to every Google account. These users
 * sign in without needing a pre-assigned DB role; role resolution still runs
 * normally afterwards.
 */
const ALLOWED_EMAIL_ADDRESSES = (process.env.ALLOWED_EMAIL_ADDRESSES || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean)

/* ── Google Workspace OAuth scopes ── */
const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/tasks',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive.readonly',
  // Gmail — read inbox, send, mark read
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  // Google Chat — read spaces + messages, send messages
  'https://www.googleapis.com/auth/chat.spaces.readonly',
  'https://www.googleapis.com/auth/chat.messages',
  'https://www.googleapis.com/auth/chat.messages.create',
  // Google Chat — member listing + read state (for unread badges).
  // readstate is the FULL scope (read + write): opening a chat in the hub
  // marks it read so the unread badge clears here and in Google Chat.
  'https://www.googleapis.com/auth/chat.memberships.readonly',
  'https://www.googleapis.com/auth/chat.users.readstate',
  // KPI sources — GA4 Data API + Google Search Console
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/webmasters.readonly',
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
      error: undefined, // clear any prior RefreshAccessTokenError on success
    }
  } catch (error) {
    console.error('Error refreshing access token:', error)
    // P1-2: drop the dead access token (and expiry) so downstream Google routes'
    // `if (!accessToken)` guard fires and returns 401 → the client re-auths,
    // instead of firing Google calls with a stale token that 401s into an
    // opaque 500 the UI can't recover from.
    return { ...token, accessToken: undefined, accessTokenExpires: 0, error: 'RefreshAccessTokenError' }
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
    // ── Sign-in allowlist (P1: fail closed for unknown external accounts) ──
    // Google is an OPEN identity provider — without this gate ANY Google account
    // could complete OAuth, be auto-provisioned as `onboarding`, and reach every
    // session-gated route. We admit a sign-in ONLY when the email is:
    //   (a) an env-configured superadmin/admin, OR
    //   (b) an already-provisioned user with a non-onboarding role in the DB
    //       (covers off-domain staff/contractors an admin explicitly added), OR
    //   (c) on an allowed domain (ALLOWED_EMAIL_DOMAINS, defaulting to the
    //       superadmin/admin domains) — covers real employees / new hires.
    // Everything else is DENIED. This preserves access for every email that
    // resolveUserRole would grant a non-onboarding role, plus the company domain,
    // so no currently-legitimate user is locked out; only anonymous external
    // Google accounts are turned away. The DB lookup is READ-ONLY (never
    // auto-creates a row for an account we are about to reject), and a DB outage
    // still lets env-admin + allowed-domain users in via (a)/(c).
    async signIn({ user }) {
      const email = (user?.email || '').toLowerCase().trim()
      if (!email) return false // no verified email → deny

      // (a) env-configured superadmin/admin always allowed.
      if (SUPERADMIN_EMAILS.includes(email) || ADMIN_EMAILS.includes(email)) return true

      // (a2) individually-invited external account (ALLOWED_EMAIL_ADDRESSES) —
      // guests on consumer domains where a domain allowlist would be too broad.
      if (ALLOWED_EMAIL_ADDRESSES.includes(email)) return true

      // (c) allowed sign-in domain (default: the configured admins' domains).
      const domain = emailDomain(email)
      if (domain && ALLOWED_EMAIL_DOMAINS.includes(domain)) return true

      // (b) explicitly-provisioned, non-onboarding user (read-only lookup — no
      // side-effecting auto-create for a rejected account). getUserRole never
      // throws (returns 'onboarding' on any DB error), so a DB outage falls
      // through to deny here while (a)/(c) above keep the core population in.
      try {
        const { role } = await getUserRole(email)
        if (role && role !== 'onboarding') return true
      } catch {
        // defensive — getUserRole is already catch-wrapped; fail closed.
      }

      console.warn('[auth] sign-in denied for non-allowlisted account:', email)
      return false
    },

    // ── Redirect confinement ──
    // Pin every post-auth redirect to THIS app's own origin (baseUrl === NEXTAUTH_URL).
    // Defense-in-depth against a contaminated/stale callbackUrl bouncing the user to
    // another tenant's domain (e.g. a sibling app like fridgesnap). This governs the
    // app-level redirect, not the Google OAuth redirect_uri (that derives from NEXTAUTH_URL).
    async redirect({ url, baseUrl }) {
      try {
        if (url.startsWith('/')) return `${baseUrl}${url}`
        if (new URL(url).origin === baseUrl) return url
      } catch {
        // malformed url — fall through to safe default
      }
      return baseUrl
    },

    async jwt({ token, user, account }) {
      // ── Initial sign-in: capture OAuth tokens and resolve role ──
      if (account && user) {
        const email = (user.email || '').toLowerCase()
        const accessToken = account.access_token as string

        const { role, assignedProjects } = await resolveUserRole(email)

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

/* ── Startup OAuth diagnostic ──
 * Logs which Google OAuth client and callback URL THIS deployment actually uses.
 * Client IDs are NOT secret (they appear in the browser's OAuth request URL), so
 * logging the id is safe — the client SECRET is never logged. This is the fastest
 * way to catch a contaminated client_id (e.g. a sibling app's OAuth client) that
 * causes a redirect_uri_mismatch or a foreign consent screen. Check Cloud Run logs
 * for "[auth] OAuth config" after deploy and confirm the client_id + host are the Hub's. */
if (process.env.NODE_ENV !== 'test') {
  const nextAuthUrl = process.env.NEXTAUTH_URL || '(NEXTAUTH_URL unset)'
  console.info('[auth] OAuth config →', JSON.stringify({
    nextAuthUrl,
    computedCallback: `${nextAuthUrl}/api/auth/callback/google`,
    googleClientId: process.env.GOOGLE_CLIENT_ID || '(GOOGLE_CLIENT_ID unset)',
  }))
}
