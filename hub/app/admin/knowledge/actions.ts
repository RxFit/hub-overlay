'use server'

import { db } from '@/lib/db'
import { documentChunks } from '@/lib/schema'
import { eq, and } from 'drizzle-orm'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { revalidatePath } from 'next/cache'
import { getTenantConfig } from '@/lib/tenant'

export async function deleteChunk(id: string) {
  const session = await getServerSession(authOptions)
  const role = (session?.user as any)?.role

  if (role !== 'superadmin' && role !== 'admin') {
    throw new Error('Unauthorized')
  }

  const tenant = getTenantConfig()

  await db.delete(documentChunks).where(
    and(
      eq(documentChunks.id, id),
      eq(documentChunks.tenantId, tenant.id)
    )
  )
  revalidatePath('/admin/knowledge')
  return { success: true }
}
