/**
 * Drive sharing — reading and changing WHO can see a file.
 *
 * The Hub could already author Docs/Sheets/Slides into the user's Drive, but a
 * document nobody else can open is half a deliverable: every "make me a doc"
 * ended with the user leaving the Hub, finding the file in Drive, and clicking
 * Share. This module is the other half.
 *
 * ── The scope asymmetry that shapes every function here ──
 * The Hub deliberately does NOT hold the restricted full `drive` scope (see
 * docs/runbooks/google-oauth-scopes.md — it would trigger a ~6-week review plus
 * annual CASA). What it holds is:
 *
 *   `drive.file`     → per-file access to files the app CREATED. Drive accepts
 *                      this for `permissions.create` / `permissions.delete`.
 *   `drive.readonly` → read-only visibility of everything. Drive accepts this
 *                      for `permissions.list`.
 *
 * So the capability split is not a product decision, it is what the scopes
 * allow: the Hub can REPORT access on any file the user can see, and can CHANGE
 * access only on files it created itself. `findShareableFiles` exists to make
 * that boundary legible BEFORE a share is attempted — matching a user's file
 * and then failing with a raw Drive 403 is a much worse answer than saying
 * up front which files are actually managed.
 */

import { googleFetch, googleFetchVoid } from './client'
import { APP_PROP_MARKER, APP_PROP_TENANT, escapeDriveQueryValue } from './drive-workspace'
import { shareRoleLabel, type ShareRole } from './share-roles'

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files'

// The pure role/recipient vocabulary lives in `share-roles.ts` so the browser
// executor can use it without pulling the Drive REST layer into the client
// bundle. Re-exported here so server callers have one import.
export {
  normalizeShareRole,
  shareRoleLabel,
  parseRecipientRefs,
  type ShareRole,
} from './share-roles'

/** A file the Hub created, and can therefore change sharing on. */
export interface ShareableFile {
  id: string
  name: string
  mimeType?: string
  webViewLink?: string
  modifiedTime?: string
}

interface DriveFileListResponse {
  files?: Array<{
    id: string
    name?: string
    mimeType?: string
    webViewLink?: string
    modifiedTime?: string
  }>
}

const FILE_FIELDS = 'files(id,name,mimeType,webViewLink,modifiedTime)'

function toShareableFiles(data: DriveFileListResponse): ShareableFile[] {
  return (data.files ?? [])
    .filter((f): f is { id: string } & typeof f => Boolean(f.id))
    .map(f => ({
      id: f.id,
      name: f.name ?? '(untitled)',
      mimeType: f.mimeType,
      webViewLink: f.webViewLink,
      modifiedTime: f.modifiedTime,
    }))
}

export interface FileMatches {
  /** Hub-created files — sharing on these can be changed. */
  managed: ShareableFile[]
  /**
   * Files that match the name but were NOT created by the Hub. Populated only
   * when `managed` is empty, and used purely to explain the scope boundary.
   */
  unmanaged: ShareableFile[]
}

/**
 * Find candidate files for a share request.
 *
 * Two searches, in order of usefulness:
 *
 *  1. Hub artifacts (`appProperties has {key='hubOverlay' ...}`) — the set the
 *     Hub is actually able to re-share. Scoped to the caller's tenant so a
 *     multi-tenant Drive cannot cross-match.
 *  2. Only if that finds nothing: a plain name search across everything the
 *     user can see. These are returned separately and are never shared — they
 *     exist so the caller can say "I found it, but it isn't a Hub file" instead
 *     of "not found", which would be wrong, or a Drive 403, which is opaque.
 */
export async function findShareableFiles(
  accessToken: string,
  query: string,
  opts: { tenantId?: string; maxResults?: number } = {},
): Promise<FileMatches> {
  const term = escapeDriveQueryValue(query.trim())
  if (!term) return { managed: [], unmanaged: [] }

  const pageSize = String(opts.maxResults ?? 10)
  const tenantClause = opts.tenantId
    ? ` and appProperties has { key='${APP_PROP_TENANT}' and value='${escapeDriveQueryValue(opts.tenantId)}' }`
    : ''

  const managedParams = new URLSearchParams({
    q:
      `appProperties has { key='${APP_PROP_MARKER}' and value='artifact' }${tenantClause}` +
      ` and name contains '${term}' and trashed = false`,
    orderBy: 'modifiedTime desc',
    pageSize,
    fields: FILE_FIELDS,
  })

  const managed = toShareableFiles(
    await googleFetch<DriveFileListResponse>(`${DRIVE_FILES}?${managedParams}`, accessToken),
  )
  if (managed.length > 0) return { managed, unmanaged: [] }

  const anyParams = new URLSearchParams({
    q: `name contains '${term}' and trashed = false`,
    orderBy: 'modifiedTime desc',
    pageSize,
    fields: FILE_FIELDS,
  })
  const unmanaged = toShareableFiles(
    await googleFetch<DriveFileListResponse>(`${DRIVE_FILES}?${anyParams}`, accessToken),
  )
  return { managed: [], unmanaged }
}

/** One existing grant on a file. */
export interface AccessEntry {
  permissionId: string
  /** 'user' | 'group' | 'domain' | 'anyone' */
  type: string
  role: string
  emailAddress?: string
  displayName?: string
  domain?: string
  /** True for the file's owner — the Hub refuses to revoke this. */
  isOwner: boolean
  /** True when the grant is inherited from a parent folder (not revocable here). */
  inherited: boolean
}

interface DrivePermission {
  id?: string
  type?: string
  role?: string
  emailAddress?: string
  displayName?: string
  domain?: string
  permissionDetails?: Array<{ inherited?: boolean }>
}

/**
 * List who currently has access to a file.
 *
 * Works on ANY file the user can see — `permissions.list` accepts
 * `drive.readonly`, unlike the mutating calls below. That asymmetry is the
 * whole reason "who can see this?" is answerable for a colleague's shared doc
 * while "give Sam access to it" is not.
 */
export async function listFileAccess(
  accessToken: string,
  fileId: string,
): Promise<AccessEntry[]> {
  const params = new URLSearchParams({
    fields: 'permissions(id,type,role,emailAddress,displayName,domain,permissionDetails(inherited))',
    pageSize: '100',
  })
  const data = await googleFetch<{ permissions?: DrivePermission[] }>(
    `${DRIVE_FILES}/${encodeURIComponent(fileId)}/permissions?${params}`,
    accessToken,
  )

  return (data.permissions ?? []).map(p => ({
    permissionId: p.id ?? '',
    type: p.type ?? 'user',
    role: p.role ?? 'reader',
    emailAddress: p.emailAddress,
    displayName: p.displayName,
    domain: p.domain,
    isOwner: p.role === 'owner',
    inherited: Boolean(p.permissionDetails?.some(d => d.inherited)),
  }))
}

export interface GrantResult {
  permissionId: string
  /** The address granted, or 'anyone with the link' for a link grant. */
  grantee: string
  role: ShareRole
}

/**
 * Grant a named person access to a file.
 *
 * `sendNotificationEmail` defaults to true, which is both the Drive default and
 * the behaviour a user expects from "share it with Maria" — she gets the mail
 * with the link. It also sidesteps Drive's rule that a notification-free grant
 * to a non-Google address is rejected outright.
 */
export async function grantFileAccess(
  accessToken: string,
  fileId: string,
  input: { email: string; role: ShareRole; notify?: boolean; message?: string },
): Promise<GrantResult> {
  const params = new URLSearchParams({
    sendNotificationEmail: String(input.notify ?? true),
    fields: 'id,role,emailAddress',
  })
  // Drive rejects emailMessage when no notification is being sent.
  if ((input.notify ?? true) && input.message?.trim()) {
    params.set('emailMessage', input.message.trim())
  }

  const created = await googleFetch<{ id?: string; role?: string; emailAddress?: string }>(
    `${DRIVE_FILES}/${encodeURIComponent(fileId)}/permissions?${params}`,
    accessToken,
    {
      method: 'POST',
      body: JSON.stringify({ type: 'user', role: input.role, emailAddress: input.email }),
    },
  )

  return {
    permissionId: created.id ?? '',
    grantee: created.emailAddress ?? input.email,
    role: input.role,
  }
}

/**
 * Turn on link sharing — anyone holding the URL gets `role`.
 *
 * Only ever reached when the user asked for it in so many words and then
 * approved a confirm card that names it; it is never inferred from a plain
 * "share this with the team". Notification is forced off because Drive has
 * nobody to notify for an `anyone` grant and errors if asked to.
 */
export async function grantLinkAccess(
  accessToken: string,
  fileId: string,
  role: ShareRole,
): Promise<GrantResult> {
  const params = new URLSearchParams({
    sendNotificationEmail: 'false',
    fields: 'id,role',
  })

  const created = await googleFetch<{ id?: string; role?: string }>(
    `${DRIVE_FILES}/${encodeURIComponent(fileId)}/permissions?${params}`,
    accessToken,
    {
      method: 'POST',
      body: JSON.stringify({ type: 'anyone', role }),
    },
  )

  return {
    permissionId: created.id ?? '',
    grantee: 'anyone with the link',
    role,
  }
}

/**
 * Revoke one grant.
 *
 * The owner permission is refused here rather than at the route: removing it is
 * not something Drive will do anyway, and a clear message beats a 403 the
 * caller would have to interpret.
 */
export async function revokeFileAccess(
  accessToken: string,
  fileId: string,
  permissionId: string,
): Promise<void> {
  await googleFetchVoid(
    `${DRIVE_FILES}/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(permissionId)}`,
    accessToken,
    { method: 'DELETE' },
  )
}

/** One-line description of an access entry, for chat output. */
export function describeAccessEntry(entry: AccessEntry): string {
  const who =
    entry.type === 'anyone'
      ? 'Anyone with the link'
      : entry.type === 'domain'
        ? `Everyone at ${entry.domain ?? 'the domain'}`
        : entry.displayName
          ? `${entry.displayName}${entry.emailAddress ? ` (${entry.emailAddress})` : ''}`
          : (entry.emailAddress ?? 'Unknown')

  const role = entry.isOwner ? 'owner' : shareRoleLabel(entry.role as ShareRole)
  return `${who} — ${role}${entry.inherited ? ' (inherited from folder)' : ''}`
}
