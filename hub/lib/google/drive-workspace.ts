/**
 * HUB Overlay Drive workspace — the folder the Hub owns in each user's Drive.
 *
 * Everything the Hub creates lands here, organized by type, instead of being
 * dumped at Drive root (the old behavior). Design: architecture doc §3.
 *
 *   HUB Overlay/
 *   ├── Documents/       Docs from chat & skills
 *   ├── Presentations/   Slides decks
 *   ├── Spreadsheets/    Sheets (incl. analytics exports)
 *   ├── Reports/         scheduled digests, month-bucketed
 *   ├── Forms/           (Phase 4)
 *   ├── Assets/          images used inside decks/docs
 *   └── Templates/       branded template files (files.copy sources)
 *
 * ── Scope note ──
 * Every folder and file here is app-created, so the non-sensitive `drive.file`
 * scope covers creating, organizing, editing and re-reading them. We never need
 * the restricted full `drive` scope.
 *
 * ── Why the DB row is a cache, not the truth ──
 * Drive is the source of truth; the `drive_workspaces` row is a fast path. A
 * user can rename, move, trash or delete the folder at any time, and the Hub
 * must not break or fight them:
 *
 *  - **Renamed or moved** → we follow the ID. Nothing breaks; we never rely on
 *    the folder's name or location to find it again.
 *  - **Trashed** → treated as intent. We do NOT untrash it; we create a fresh
 *    folder on the next write. Silently resurrecting a folder the user just
 *    threw away is the kind of thing that makes an app feel possessed.
 *  - **Deleted / id gone stale** → rediscovery by `appProperties` (private
 *    app-only metadata that survives renames), then create as a last resort.
 *  - **Replaced by a shortcut** → resolved via `shortcutDetails.targetId`; a
 *    shortcut is never treated as the folder itself, or `parents` writes would
 *    fail with a confusing Drive 400.
 *
 * The DB access lives in the `-db.ts` sibling (repo convention) so this module
 * stays unit-testable against a stubbed store with no database.
 */

import { googleFetch } from './client'

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files'

export const FOLDER_MIME = 'application/vnd.google-apps.folder'
export const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut'

/** Default root folder name. Per-tenant override via TenantConfig; "HUB Overlay"
 *  is the app's placeholder name until an official product name exists. */
export const DEFAULT_ROOT_FOLDER_NAME = 'HUB Overlay'

/**
 * Private, app-only Drive metadata. `appProperties` (unlike `properties`) is
 * visible only to this OAuth client, survives rename/move, and is queryable —
 * which is exactly what rediscovery needs. Budget: ≤124 bytes per key+value
 * pair, 30 keys per app.
 */
export const APP_PROP_MARKER = 'hubOverlay'
export const APP_PROP_TENANT = 'hubTenant'
export const APP_PROP_KIND = 'hubKind'

export type WorkspaceFolderKey =
  | 'documents'
  | 'presentations'
  | 'spreadsheets'
  | 'reports'
  | 'forms'
  | 'assets'
  | 'templates'

/** Display names for each subfolder, in creation order. */
export const SUBFOLDER_NAMES: Record<WorkspaceFolderKey, string> = {
  documents: 'Documents',
  presentations: 'Presentations',
  spreadsheets: 'Spreadsheets',
  reports: 'Reports',
  forms: 'Forms',
  assets: 'Assets',
  templates: 'Templates',
}

export interface StoredWorkspace {
  rootFolderId: string
  /** Subfolder ids discovered/created so far — populated lazily, never assumed
   *  complete (a user can delete one subfolder and keep the rest). */
  folders: Partial<Record<WorkspaceFolderKey, string>>
}

/** Persistence seam. The DB implementation lives in drive-workspace-db.ts. */
export interface WorkspaceStore {
  load(tenantId: string, email: string): Promise<StoredWorkspace | null>
  save(tenantId: string, email: string, workspace: StoredWorkspace): Promise<void>
}

/** A store that remembers nothing — every call re-discovers via Drive. Used as
 *  the safe fallback when the DB is unavailable, so artifact creation degrades
 *  to "one extra Drive query" instead of failing outright. */
export const NULL_WORKSPACE_STORE: WorkspaceStore = {
  async load() {
    return null
  },
  async save() {
    /* no-op */
  },
}

interface DriveFile {
  id: string
  name?: string
  mimeType?: string
  trashed?: boolean
  shortcutDetails?: { targetId?: string; targetMimeType?: string }
}

/**
 * Escape a value for embedding in a Drive `q` search string. Drive uses
 * single-quoted literals with backslash escaping; an unescaped apostrophe in a
 * name turns into a syntax error (Drive 400), and a crafted name could
 * otherwise alter the query's meaning.
 */
export function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

/** appProperties stamped on the root folder — the rediscovery anchor. */
export function rootAppProperties(tenantId: string): Record<string, string> {
  return { [APP_PROP_MARKER]: 'root', [APP_PROP_TENANT]: tenantId }
}

/** appProperties for a subfolder (`kind` = the WorkspaceFolderKey). */
export function subfolderAppProperties(tenantId: string, kind: WorkspaceFolderKey): Record<string, string> {
  return { [APP_PROP_MARKER]: 'folder', [APP_PROP_TENANT]: tenantId, [APP_PROP_KIND]: kind }
}

/** appProperties for an artifact file created by the Hub. */
export function artifactAppProperties(tenantId: string, kind: string): Record<string, string> {
  return { [APP_PROP_MARKER]: 'artifact', [APP_PROP_TENANT]: tenantId, [APP_PROP_KIND]: kind }
}

/**
 * Fetch a file by id. Returns null when it is gone (404) — a deleted folder is
 * an expected state here, not an error worth propagating.
 */
async function getFile(accessToken: string, fileId: string): Promise<DriveFile | null> {
  try {
    return await googleFetch<DriveFile>(
      `${DRIVE_FILES}/${fileId}?fields=id,name,mimeType,trashed,shortcutDetails`,
      accessToken,
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : ''
    if (/\b404\b/.test(message)) return null
    throw err
  }
}

/**
 * True when a fetched file is usable as a Hub folder: present, a real folder,
 * and not in the trash.
 */
function isUsableFolder(file: DriveFile | null): boolean {
  return !!file && !file.trashed && file.mimeType === FOLDER_MIME
}

/**
 * Resolve a possible shortcut to its target folder. A user tidying their Drive
 * can replace the folder with a shortcut to it; writing `parents: [shortcutId]`
 * would fail, so follow the pointer.
 */
async function resolveShortcut(accessToken: string, file: DriveFile): Promise<DriveFile | null> {
  if (file.mimeType !== SHORTCUT_MIME) return file
  const targetId = file.shortcutDetails?.targetId
  if (!targetId) return null
  return getFile(accessToken, targetId)
}

/** Verify a cached folder id still points at a usable folder. */
async function verifyFolder(accessToken: string, folderId: string): Promise<string | null> {
  const file = await getFile(accessToken, folderId)
  if (!file) return null
  const resolved = await resolveShortcut(accessToken, file)
  return isUsableFolder(resolved) ? resolved!.id : null
}

/** First matching folder for a Drive query, or null. */
async function findFolder(accessToken: string, query: string): Promise<string | null> {
  const params = new URLSearchParams({
    q: query,
    fields: 'files(id,name,mimeType,trashed)',
    pageSize: '10',
    // Restrict to files this app created — matches the drive.file scope and
    // keeps the query cheap.
    spaces: 'drive',
    orderBy: 'createdTime',
  })
  const data = await googleFetch<{ files?: DriveFile[] }>(`${DRIVE_FILES}?${params}`, accessToken)
  const match = (data.files ?? []).find(f => f.mimeType === FOLDER_MIME && !f.trashed)
  return match?.id ?? null
}

/** Create a folder and return its id. */
async function createFolder(
  accessToken: string,
  name: string,
  appProperties: Record<string, string>,
  parentId?: string,
): Promise<string> {
  const created = await googleFetch<DriveFile>(`${DRIVE_FILES}?fields=id`, accessToken, {
    method: 'POST',
    body: JSON.stringify({
      name,
      mimeType: FOLDER_MIME,
      appProperties,
      ...(parentId ? { parents: [parentId] } : {}),
    }),
  })
  return created.id
}

/**
 * Find-or-create the tenant's root folder, in cache → verify → rediscover →
 * create order.
 */
async function ensureRoot(
  accessToken: string,
  tenantId: string,
  rootName: string,
  cached: StoredWorkspace | null,
): Promise<{ rootId: string; changed: boolean }> {
  if (cached?.rootFolderId) {
    const verified = await verifyFolder(accessToken, cached.rootFolderId)
    if (verified) return { rootId: verified, changed: verified !== cached.rootFolderId }
  }

  // Rediscover by app-private marker. Survives rename/move, and deliberately
  // excludes trashed folders so a user's "delete this" sticks.
  const query = [
    `appProperties has { key='${APP_PROP_MARKER}' and value='root' }`,
    `appProperties has { key='${APP_PROP_TENANT}' and value='${escapeDriveQueryValue(tenantId)}' }`,
    `mimeType='${FOLDER_MIME}'`,
    'trashed=false',
  ].join(' and ')

  const found = await findFolder(accessToken, query)
  if (found) return { rootId: found, changed: true }

  const created = await createFolder(accessToken, rootName, rootAppProperties(tenantId))
  return { rootId: created, changed: true }
}

/**
 * Find-or-create one subfolder under the root. Looked up by name within the
 * parent (plus the app marker), so a user reorganizing inside the Hub folder is
 * tolerated.
 */
async function ensureSubfolder(
  accessToken: string,
  tenantId: string,
  rootId: string,
  key: WorkspaceFolderKey,
  cachedId: string | undefined,
): Promise<{ id: string; changed: boolean }> {
  if (cachedId) {
    const verified = await verifyFolder(accessToken, cachedId)
    if (verified) return { id: verified, changed: verified !== cachedId }
  }

  const name = SUBFOLDER_NAMES[key]
  const query = [
    `'${escapeDriveQueryValue(rootId)}' in parents`,
    `name='${escapeDriveQueryValue(name)}'`,
    `mimeType='${FOLDER_MIME}'`,
    'trashed=false',
  ].join(' and ')

  const found = await findFolder(accessToken, query)
  if (found) return { id: found, changed: true }

  const created = await createFolder(accessToken, name, subfolderAppProperties(tenantId, key), rootId)
  return { id: created, changed: true }
}

export interface EnsureWorkspaceOptions {
  tenantId: string
  email: string
  /** Per-tenant root folder name; defaults to "HUB Overlay". */
  rootName?: string
  /** Subfolders to guarantee exist. Defaults to just the one being written to —
   *  callers pass the folder they need, so we never create seven folders for a
   *  user who only ever made one doc. */
  ensure?: WorkspaceFolderKey[]
  store?: WorkspaceStore
}

export interface Workspace {
  rootId: string
  folders: Partial<Record<WorkspaceFolderKey, string>>
  /** Convenience link for the artifact card / settings row. */
  rootUrl: string
}

/**
 * Ensure the workspace (and the requested subfolders) exist, returning their
 * ids. Provisioning is **lazy** — called on first artifact write, never at
 * login, so a user who never creates anything never gets a surprise folder.
 *
 * The store is written back only when something actually changed, keeping the
 * common path to a single verification GET.
 */
export async function ensureWorkspace(
  accessToken: string,
  opts: EnsureWorkspaceOptions,
): Promise<Workspace> {
  const store = opts.store ?? NULL_WORKSPACE_STORE
  const rootName = opts.rootName?.trim() || DEFAULT_ROOT_FOLDER_NAME

  // A DB hiccup must not block artifact creation — fall back to rediscovery.
  let cached: StoredWorkspace | null = null
  try {
    cached = await store.load(opts.tenantId, opts.email)
  } catch (err) {
    console.warn('[drive-workspace] store.load failed, falling back to Drive rediscovery:', err)
  }

  const { rootId, changed: rootChanged } = await ensureRoot(accessToken, opts.tenantId, rootName, cached)

  // A new root invalidates every cached subfolder id (they lived under the old
  // one), so start clean rather than re-verifying ids that cannot be children.
  const folders: Partial<Record<WorkspaceFolderKey, string>> =
    rootChanged && cached?.rootFolderId !== rootId ? {} : { ...(cached?.folders ?? {}) }

  let changed = rootChanged

  for (const key of opts.ensure ?? []) {
    const { id, changed: subChanged } = await ensureSubfolder(
      accessToken,
      opts.tenantId,
      rootId,
      key,
      folders[key],
    )
    folders[key] = id
    changed = changed || subChanged
  }

  if (changed) {
    try {
      await store.save(opts.tenantId, opts.email, { rootFolderId: rootId, folders })
    } catch (err) {
      // The folders exist in Drive; only the cache write failed. Next call
      // re-discovers them, so this is a slow path, not a broken one.
      console.warn('[drive-workspace] store.save failed (workspace still usable):', err)
    }
  }

  return { rootId, folders, rootUrl: `https://drive.google.com/drive/folders/${rootId}` }
}

/**
 * Move an already-created file into a workspace folder.
 *
 * Needed because several creator APIs cannot set a parent at creation time:
 * `presentations.create` and `forms.create` always land the file at Drive root,
 * so the file is relocated immediately afterward. Docs/Sheets avoid this by
 * being created through Drive itself (which does accept `parents`).
 */
export async function moveFileToFolder(
  accessToken: string,
  fileId: string,
  folderId: string,
): Promise<void> {
  const params = new URLSearchParams({
    addParents: folderId,
    removeParents: 'root',
    fields: 'id,parents',
  })
  await googleFetch<unknown>(`${DRIVE_FILES}/${fileId}?${params}`, accessToken, { method: 'PATCH' })
}

/** Build the dated artifact file name used across the workspace: "2026-07-28 — Title". */
export function artifactFileName(title: string, now: Date = new Date()): string {
  const date = now.toISOString().slice(0, 10)
  return `${date} — ${title}`.trim()
}
