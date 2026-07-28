/**
 * Workspace-folder resolution for artifact routes (SERVER-ONLY).
 *
 * One helper so every artifact route files its output into the Hub folder the
 * same way, with the same failure posture.
 *
 * ── Why this never throws ──
 * Filing a document in a tidy folder is a nicety; CREATING the document is the
 * thing the user asked for. If folder provisioning fails — Drive hiccup, DB
 * down, a grant that predates `drive.file` — the artifact must still be
 * created, just at Drive root. Returning `{}` instead of throwing keeps a
 * cosmetic failure from turning into "your document didn't get made".
 */

import { ensureWorkspace, type WorkspaceFolderKey } from './drive-workspace'
import { dbWorkspaceStore } from './drive-workspace-db'
import { getTenantId } from '../tenant-context'
import { getTenantConfigById } from '../tenant'

export interface ArtifactFolder {
  /** Undefined when provisioning failed — callers simply omit `parents`. */
  folderId?: string
  tenantId: string
  /** Link to the workspace root, for the artifact card breadcrumb. */
  rootUrl?: string
}

/**
 * Ensure the Hub workspace exists and return the id of the subfolder this
 * artifact belongs in.
 */
export async function resolveArtifactFolder(
  accessToken: string,
  email: string,
  folder: WorkspaceFolderKey,
): Promise<ArtifactFolder> {
  const tenantId = getTenantId()

  try {
    const workspace = await ensureWorkspace(accessToken, {
      tenantId,
      email,
      rootName: getTenantConfigById(tenantId)?.driveFolderName,
      ensure: [folder],
      store: dbWorkspaceStore,
    })
    return { folderId: workspace.folders[folder], tenantId, rootUrl: workspace.rootUrl }
  } catch (err) {
    console.warn(
      `[artifact-folder] workspace provisioning failed for ${folder}; creating at Drive root instead:`,
      err,
    )
    return { tenantId }
  }
}
