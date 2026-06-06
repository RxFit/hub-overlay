import { db } from '@/lib/db'
import { documentChunks } from '@/lib/schema'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { desc, eq } from 'drizzle-orm'
import { getTenantConfig } from '@/lib/tenant'
import KnowledgeTable from './KnowledgeTable'
import Link from 'next/link'

export default async function KnowledgePage() {
  const session = await getServerSession(authOptions)
  const role = (session?.user as any)?.role

  if (role !== 'superadmin' && role !== 'admin') {
    redirect('/')
  }

  const tenant = getTenantConfig()

  const chunks = await db.select({
    id: documentChunks.id,
    sourceUrl: documentChunks.sourceUrl,
    content: documentChunks.content,
    createdAt: documentChunks.createdAt,
  })
  .from(documentChunks)
  .where(eq(documentChunks.tenantId, tenant.id))
  .orderBy(desc(documentChunks.createdAt))
  .limit(100)

  const ROLE_LABELS: Record<string, string> = {
    superadmin: 'Super Admin',
    admin: 'Admin',
    staff: 'Staff',
    onboarding: 'Onboarding',
  }

  const ROLE_COLORS: Record<string, string> = {
    superadmin: '#d4b572',
    admin: '#C5A059',
    staff: '#4A6FA5',
    onboarding: '#6b7280',
  }

  return (
    <div className="admin-shell">
      <header className="admin-header">
        <div className="admin-header__left">
          <Link href="/admin" className="admin-back-btn" aria-label="Back to Admin" style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
            ← Admin
          </Link>
          <div className="admin-header__title">
            <span className="admin-header__accent">{tenant.logoText}</span>
            {' '}Knowledge Base
          </div>
        </div>
        <div className="admin-header__right">
          <span className="admin-role-badge" style={{ color: ROLE_COLORS[role] }}>
            {ROLE_LABELS[role] ?? role}
          </span>
          <span className="admin-header__email">{session?.user?.email}</span>
        </div>
      </header>

      <main className="admin-main">
        <section className="admin-section">
          <div className="admin-section__header">
            <h2 className="admin-section__title">
              <span className="admin-section__dot admin-section__dot--active" />
              Ingested Semantic Chunks
              <span className="admin-section__count">{chunks.length}</span>
            </h2>
            <p className="admin-section__sub" style={{ marginTop: '4px' }}>Manage and audit chunks embedded into the pgvector database for RAG context.</p>
          </div>
          <KnowledgeTable initialChunks={chunks} />
        </section>
      </main>
    </div>
  )
}
