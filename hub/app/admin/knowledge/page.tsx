import { db } from '@/lib/db'
import { documentChunks } from '@/lib/schema'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { desc, eq, and, or, ilike, count } from 'drizzle-orm'
import { getTenantConfig } from '@/lib/tenant'
import KnowledgeTable from './KnowledgeTable'
import Link from 'next/link'

export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: { q?: string; page?: string }
}) {
  const session = await getServerSession(authOptions)
  const role = (session?.user as any)?.role

  if (role !== 'superadmin' && role !== 'admin') {
    redirect('/')
  }

  const tenant = getTenantConfig()

  const q = searchParams.q?.trim() || ''
  const page = Math.max(1, parseInt(searchParams.page || '1', 10))
  const pageSize = 10
  const offset = (page - 1) * pageSize

  const whereClause = q
    ? and(
        eq(documentChunks.tenantId, tenant.id),
        or(
          ilike(documentChunks.content, `%${q}%`),
          ilike(documentChunks.sourceUrl, `%${q}%`)
        )
      )
    : eq(documentChunks.tenantId, tenant.id)

  // Fetch total count matching search filter
  const [countResult] = await db
    .select({ count: count() })
    .from(documentChunks)
    .where(whereClause)
  
  const totalCount = countResult?.count ?? 0

  // Fetch paginated chunks
  const chunks = await db.select({
    id: documentChunks.id,
    sourceUrl: documentChunks.sourceUrl,
    content: documentChunks.content,
    createdAt: documentChunks.createdAt,
  })
  .from(documentChunks)
  .where(whereClause)
  .orderBy(desc(documentChunks.createdAt))
  .limit(pageSize)
  .offset(offset)


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
              <span className="admin-section__count">{totalCount}</span>
            </h2>
            <p className="admin-section__sub" style={{ marginTop: '4px' }}>Manage and audit chunks embedded into the pgvector database for RAG context.</p>
          </div>
          <KnowledgeTable 
            initialChunks={chunks} 
            totalCount={totalCount}
            currentPage={page}
            pageSize={pageSize}
            searchTerm={q}
          />

        </section>
      </main>
    </div>
  )
}
