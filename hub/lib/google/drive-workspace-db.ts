/**
 * Drive workspace persistence (SERVER-ONLY).
 *
 * Split from drive-workspace.ts — which stays DB-free and unit-testable — so the
 * Postgres driver never follows the folder helpers into a client bundle.
 * Mirrors lib/chat-space-preferences-db.ts.
 *
 * Both directions are FAIL-SOFT, and deliberately so: this table is a cache of
 * something Drive already knows. A read failure means one extra rediscovery
 * query; a write failure means the next call rediscovers again. Neither should
 * be able to fail a user's document creation, so unlike the preferences stores
 * (where a silent non-save is the bug), errors here are logged and swallowed by
 * the caller in `ensureWorkspace`.
 */

import { and, eq } from 'drizzle-orm'
import { db } from '../db'
import { driveWorkspaces, tenants } from '../schema'
import { getTenantId } from '../tenant-context'
import type { StoredWorkspace, WorkspaceStore, WorkspaceFolderKey } from './drive-workspace'

async function ensureTenant(tenantId: string): Promise<void> {
  await db.insert(tenants).values({ id: tenantId, name: tenantId }).onConflictDoNothing()
}

/** Read the cached workspace for a user, or null when there isn't one. */
export async function getDriveWorkspace(
  email: string,
  tenantId = getTenantId(),
): Promise<StoredWorkspace | null> {
  const normalized = email.toLowerCase().trim()
  const [row] = await db
    .select()
    .from(driveWorkspaces)
    .where(and(eq(driveWorkspaces.tenantId, tenantId), eq(driveWorkspaces.email, normalized)))
    .limit(1)

  if (!row?.rootFolderId) return null
  return {
    rootFolderId: row.rootFolderId,
    folders: (row.folders ?? {}) as Partial<Record<WorkspaceFolderKey, string>>,
  }
}

/** Upsert the cached workspace for a user. */
export async function saveDriveWorkspace(
  email: string,
  workspace: StoredWorkspace,
  tenantId = getTenantId(),
): Promise<void> {
  const normalized = email.toLowerCase().trim()
  await ensureTenant(tenantId)
  await db
    .insert(driveWorkspaces)
    .values({
      tenantId,
      email: normalized,
      rootFolderId: workspace.rootFolderId,
      folders: workspace.folders as Record<string, string>,
    })
    .onConflictDoUpdate({
      target: [driveWorkspaces.tenantId, driveWorkspaces.email],
      set: {
        rootFolderId: workspace.rootFolderId,
        folders: workspace.folders as Record<string, string>,
        lastVerifiedAt: new Date(),
      },
    })
}

/** The WorkspaceStore implementation handed to `ensureWorkspace` in routes. */
export const dbWorkspaceStore: WorkspaceStore = {
  load: (tenantId, email) => getDriveWorkspace(email, tenantId),
  save: (tenantId, email, workspace) => saveDriveWorkspace(email, workspace, tenantId),
}
