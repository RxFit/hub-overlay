import type { NextAuthOptions } from 'next-auth'
import type { JWT } from 'next-auth/jwt'
import GoogleProvider from 'next-auth/providers/google'
import { getAllRoleEntries, getUserRole } from '@/lib/userRoles'
import {
  classifyRefreshFailure,
  isAccessTokenFresh,
  REFRESH_FATAL_ERROR,
  REFRESH_RETRY_DELAYS_MS,
  REFRESH_TRANSIENT_ERROR,
  TRANSIENT_RETRY_BACKOFF_MS,
} from '@/lib/auth-refresh'
import {
  clearGoogleRefreshToken,
  getGoogleRefreshToken,
  storeGoogleRefreshToken,
} from '@/lib/google-token-store'

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

/**
 * Per-user display-name overrides: "email:Name,email2:Name2". The hub shows
 * `session.user.name` (the Google profile name) everywhere; this lets the
 * operator correct how a user is addressed (e.g. "Carol-Jean", not "Carol")
 * without touching their Google account. Applied in the session callback.
 */
const USER_DISPLAY_NAME_OVERRIDES: Record<string, string> = (() => {
  const map: Record<string, string> = {}
  for (const pair of (process.env.USER_DISPLAY_NAME_OVERRIDES || '').split(',')) {
    const sep = pair.indexOf(':')
    if (sep <= 0) continue
    const email = pair.slice(0, sep).trim().toLowerCase()
    const name = pair.slice(sep + 1).trim()
    if (email && name) map[email] = name
  }
  return map
})()

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
  // Docs / Sheets authoring — turn ephemeral skill artifacts (Decision Memo,
  // Storyline) and KPI snapshots into durable Google Docs/Sheets. `documents`
  // and `spreadsheets` are SENSITIVE (not restricted); `drive.file` is
  // NON-sensitive and grants per-file access only to files the app creates,
  // which is how new Docs/Sheets land in the user's Drive without full-drive.
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
  // People API — resolve a contact name to an email so "email Maria …" works
  // instead of failing for want of an address. Read-only + SENSITIVE.
  'https://www.googleapis.com/auth/contacts.readonly',
  // Slides authoring — turn the deck skills (Deck Pipeline, Gamma Deck) into a
  // real Google Slides deck. SENSITIVE (not restricted); pairs with drive.file
  // so the deck lands in the user's Drive.
  'https://www.googleapis.com/auth/presentations',
  // Admin SDK Directory (read-only) — resolve a colleague's name to their work
  // email across the org directory when they aren't in personal contacts.
  // SENSITIVE. NOTE: enabling this needs a Workspace admin to turn on the Admin
  // SDK API; non-admins can still read via viewType=domain_public.
  'https://www.googleapis.com/auth/admin.directory.user.readonly',
].join(' ')


/* ── Token refresh helper ── */

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

interface TokenRefreshResult {
  ok: boolean
  status?: number
  body?: Record<string, unknown>
}

/**
 * In-flight and very-recently-completed refreshes, keyed by refresh token.
 *
 * A single page load fans out to many API routes at once, and each one calls
 * `getServerSession()` → the `jwt` callback. Without this, one expiring token
 * would fire a dozen simultaneous `refresh_token` grants at Google — pure
 * waste, and a good way to meet a rate limit at the worst possible moment. The
 * short success window also covers the gap before `/api/auth/session` persists
 * the rotated cookie, during which further requests still arrive holding the
 * old token.
 *
 * In-process only: a per-instance optimization, never a correctness dependency.
 * It holds nothing the session cookie doesn't already carry.
 */
const refreshInFlight = new Map<string, Promise<TokenRefreshResult>>()
const REFRESH_SHARE_WINDOW_MS = 10_000

/** One round-trip to Google's token endpoint. Never throws. */
async function requestTokenRefreshUncached(refreshToken: string): Promise<TokenRefreshResult> {
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID || '',
        client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    })
    const body = await res.json().catch(() => ({}))
    return { ok: res.ok, status: res.status, body }
  } catch {
    // Thrown fetch = DNS/TLS/socket/abort — no HTTP status at all.
    return { ok: false, status: undefined }
  }
}

/** Refresh, sharing one Google round-trip across concurrent callers. */
async function requestTokenRefresh(refreshToken: string): Promise<TokenRefreshResult> {
  const existing = refreshInFlight.get(refreshToken)
  if (existing) return existing

  const pending = requestTokenRefreshUncached(refreshToken)
  refreshInFlight.set(refreshToken, pending)

  const result = await pending
  // Keep a successful result briefly so a burst of parallel routes reuses it;
  // drop a failure at once so the retry loop can genuinely retry.
  if (result.ok) setTimeout(() => refreshInFlight.delete(refreshToken), REFRESH_SHARE_WINDOW_MS).unref?.()
  else refreshInFlight.delete(refreshToken)

  return result
}

/**
 * Exchange the refresh token for a fresh access token.
 *
 * TRANSIENT FAILURES NO LONGER END THE SESSION. The previous version treated
 * every failure identically: it deleted the access token and stamped
 * `RefreshAccessTokenError`, which every Google route turns into a 401 and the
 * client turns into `signIn('google')`. A single Google 503 therefore logged
 * the user out of the entire Hub — the main driver of the "constant forced
 * relogins" complaint.
 *
 * Now the failure is classified (see lib/auth-refresh.ts):
 *
 *  - transient (429/5xx/network) → retry a couple of times inside the request,
 *    and if it still fails, KEEP the refresh token and mark the session with
 *    `RefreshTransientError`. Routes map that to a retryable 503 rather than a
 *    401, and the next request retries after a short backoff. The user notices
 *    a brief "reconnecting", not a logout.
 *
 *  - fatal (invalid_grant & friends) → the grant really is dead. Drop the
 *    access token, mark `RefreshAccessTokenError`, and delete the stored
 *    server-side copy so it is not replayed. Only this path re-prompts.
 */
async function refreshAccessToken(token: JWT): Promise<JWT> {
  const refreshToken = token.refreshToken as string | undefined
  const email = ((token.email as string) || '').toLowerCase()

  if (!refreshToken) {
    // No credential to refresh with — genuinely needs a fresh grant.
    return { ...token, accessToken: undefined, accessTokenExpires: 0, error: REFRESH_FATAL_ERROR }
  }

  let lastStatus: number | undefined
  let lastBody: Record<string, unknown> | undefined

  // attempt 0 plus one retry per backoff delay.
  for (let attempt = 0; attempt <= REFRESH_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(REFRESH_RETRY_DELAYS_MS[attempt - 1])

    const result = await requestTokenRefresh(refreshToken)

    if (result.ok && result.body?.access_token) {
      const rotated = result.body.refresh_token as string | undefined
      // Persist the working token on EVERY successful refresh — not only when
      // Google rotates it.
      //
      // This is what BACKFILLS the durable store for sessions that predate it.
      // On an OAuth sign-in next-auth hands the jwt callback a fresh token
      // containing only name/email/picture/sub (see next-auth/core/routes/
      // callback.js), so the previous session's refresh token is NOT available
      // to fall back on — the DB copy is the only recovery path. Writing it
      // here means every existing session seeds the store at its next hourly
      // refresh, before a silent re-auth could ever come up empty.
      // The upsert is idempotent and unconditionally cheap at this cadence.
      void storeGoogleRefreshToken(
        email,
        rotated ?? refreshToken,
        result.body.scope as string | undefined,
      )
      const expiresIn = Number(result.body.expires_in)
      return {
        ...token,
        accessToken: result.body.access_token as string,
        accessTokenExpires: Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000,
        refreshToken: rotated ?? refreshToken,
        error: undefined, // clear any prior refresh error on success
      }
    }

    lastStatus = result.status
    lastBody = result.body
    if (classifyRefreshFailure(result.status, result.body) === 'fatal') break
  }

  const kind = classifyRefreshFailure(lastStatus, lastBody)
  // Log the classification and the OAuth error CODE only — never the token.
  console.error(
    `[auth] token refresh ${kind} (status=${lastStatus ?? 'none'}, error=${String(lastBody?.error ?? 'none')})`,
  )

  if (kind === 'transient') {
    // Session preserved. Keep the refresh token, schedule a near-term retry,
    // and let routes answer 503-retryable instead of 401-reauth.
    return {
      ...token,
      accessToken: undefined,
      accessTokenExpires: Date.now() + TRANSIENT_RETRY_BACKOFF_MS,
      error: REFRESH_TRANSIENT_ERROR,
    }
  }

  // Fatal: the grant is dead. Drop the durable copy so the next sign-in gets a
  // genuinely new one instead of retrying a revoked token forever.
  void clearGoogleRefreshToken(email)
  return {
    ...token,
    accessToken: undefined,
    accessTokenExpires: 0,
    refreshToken: undefined,
    error: REFRESH_FATAL_ERROR,
  }
}

/**
 * Resolve the effective role for an email address.
 *
 * Priority:
 * 1. SUPERADMIN_EMAILS env var → 'superadmin' (bypass DB lookup)
 * 2. ADMIN_EMAILS env var → 'admin' (bypass DB lookup)
 * 3. Database lookup → assigned role, or 'onboarding' for a brand-new user
 *
 * Returns `null` when the DB could not be consulted at all. That is NOT the
 * same as "this user is an onboarding user", and conflating the two was a real
 * bug: this function runs on every hourly token refresh, so a momentary DB
 * outage silently DEMOTED an admin to `onboarding` for the next hour — KPIs
 * blanked, /admin redirected away — and the natural user response to a Hub that
 * has forgotten who they are is to sign out and back in. Callers must treat
 * `null` as "keep whatever role the session already had".
 */
async function resolveUserRole(
  email: string
): Promise<{ role: string; assignedProjects: string[] } | null> {
  const normalized = email.toLowerCase()

  // Env var overrides always win — these are infra-level assignments
  if (SUPERADMIN_EMAILS.includes(normalized)) {
    return { role: 'superadmin', assignedProjects: ['*'] }
  }
  if (ADMIN_EMAILS.includes(normalized)) {
    return { role: 'admin', assignedProjects: ['*'] }
  }

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
  } catch (err) {
    console.error('[auth] role lookup failed — preserving the existing role:', err)
    return null
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
          // NO static `prompt` here — deliberately.
          //
          // `prompt: 'consent'` forced the full Google consent screen on EVERY
          // authorization, including the automatic ones the app fires to
          // self-heal an expired token. That turned a recoverable blip into a
          // visible "log in again, re-approve 20 scopes" interruption.
          //
          // Omitting it lets Google complete an existing grant silently. The
          // deliberate sign-in button (app/login/page.tsx) still passes
          // `prompt: 'consent'` per-call, which is what guarantees a fresh
          // refresh_token; between that and the durable server-side copy
          // (lib/google-token-store.ts), silent re-auth keeps offline access.
          //
          // Incremental authorization: when new scopes are added, roll the
          // user's previously-granted scopes into the new grant instead of
          // replacing them, so a re-consent never silently drops old access.
          include_granted_scopes: 'true',
        },
      },
    }),
  ],
  session: {
    strategy: 'jwt',
    // 90 days, rolling. The cookie is re-issued at most once a day (updateAge),
    // so any user who opens the Hub within a 90-day window never hits a
    // session-expiry login. Offline access does not depend on this window —
    // the refresh token is stored server-side — so a longer session costs
    // nothing beyond the (already role-revalidated hourly) JWT.
    maxAge: 90 * 24 * 60 * 60,
    updateAge: 24 * 60 * 60,
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

        // Google returns a refresh_token on the FIRST authorization and on any
        // authorization that explicitly re-prompts for consent — but NOT on a
        // silent re-authorization of an existing grant. Persist it whenever it
        // shows up, and fall back to the durable copy when it doesn't, so a
        // silent sign-in on a new browser/device still has offline access
        // instead of dying an hour later and demanding a full re-consent.
        const freshRefreshToken = account.refresh_token as string | undefined
        if (freshRefreshToken) {
          void storeGoogleRefreshToken(email, freshRefreshToken, account.scope as string | undefined)
        }
        const refreshToken = freshRefreshToken ?? (await getGoogleRefreshToken(email)) ?? undefined

        const resolved = await resolveUserRole(email)
        const expiresAt = Number(account.expires_at)

        return {
          ...token,
          accessToken,
          refreshToken,
          // A missing/NaN expires_at must not become NaN in the JWT (every
          // freshness comparison against NaN is false, which would refresh on
          // literally every request). Default to Google's standard 1h life.
          accessTokenExpires: Number.isFinite(expiresAt) ? expiresAt * 1000 : Date.now() + 3600_000,
          // No previous role exists on a first sign-in, so an unreachable DB
          // still has to fall back to the least-privileged role.
          role: resolved?.role ?? 'onboarding',
          assignedProjects: resolved?.assignedProjects ?? [],
          error: undefined,
        }
      }

      // ── Token still fresh: return as-is ──
      // Refreshes a few minutes EARLY (see isAccessTokenFresh) so an in-flight
      // Google call can't land past expiry and 401 the user into a re-login.
      if (isAccessTokenFresh(token.accessTokenExpires)) {
        return token
      }

      // ── Token expired: refresh access token and re-resolve role ──
      const refreshed = await refreshAccessToken(token)
      if (refreshed.error) return refreshed  // propagate error, keep stale role

      // Re-check role from DB on every token refresh (~1hr cadence). A null
      // result means the DB was unreachable — keep the role already in the
      // session rather than demoting the user mid-session.
      const email = (token.email as string || '').toLowerCase()
      const resolved = await resolveUserRole(email)
      if (!resolved) return refreshed

      return { ...refreshed, role: resolved.role, assignedProjects: resolved.assignedProjects }
    },

    async session({ session, token }) {
      if (session.user) {
        const u = session.user as Record<string, unknown>
        u.role = token.role
        u.assignedProjects = token.assignedProjects
        u.id = token.sub
        u.error = token.error
        // Operator display-name override (see USER_DISPLAY_NAME_OVERRIDES).
        const email = (session.user.email || '').toLowerCase()
        const nameOverride = USER_DISPLAY_NAME_OVERRIDES[email]
        if (nameOverride) u.name = nameOverride
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
