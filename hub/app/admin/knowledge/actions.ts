'use server'

import { db } from '@/lib/db'
import { documentChunks } from '@/lib/schema'
import { eq } from 'drizzle-orm'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { revalidatePath } from 'next/cache'

export async function deleteChunk(id: string) {
  const session = await getServerSession(authOptions)
  const role = (session?.user as any)?.role

  if (role !== 'superadmin' && role !== 'admin') {
    throw new Error('Unauthorized')
  }

  await db.delete(documentChunks).where(eq(documentChunks.id, id))
  revalidatePath('/admin/knowledge')
  return { success: true }
}
