/**
 * Stripe API — fetches revenue and subscription metrics.
 * Uses STRIPE_SECRET_KEY env var (read-only key recommended).
 *
 * Metrics: MRR, Revenue MTD, Active Subscriptions, New Customers (30d).
 */

import { emptyOn } from '@/lib/swallow'

export interface StripeKPI {
  id: string
  label: string
  value: string
  unit?: string
  trend: string
  trendDirection: 'up' | 'down' | 'neutral'
  rawValue: number
}

function centsToDollars(cents: number): string {
  const dollars = cents / 100
  if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(2)}M`
  if (dollars >= 1_000) return `$${(dollars / 1_000).toFixed(1)}k`
  return `$${dollars.toFixed(0)}`
}

function computeTrend(current: number, previous: number): { trend: string; direction: 'up' | 'down' | 'neutral' } {
  if (!previous || previous === 0) return { trend: 'new', direction: 'neutral' }
  const pct = ((current - previous) / previous) * 100
  const sign = pct >= 0 ? '+' : ''
  return {
    trend: `${sign}${pct.toFixed(1)}%`,
    direction: pct > 0.5 ? 'up' : pct < -0.5 ? 'down' : 'neutral',
  }
}

async function stripeGet(path: string, key: string): Promise<Record<string, unknown>> {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    headers: { Authorization: `Bearer ${key}` },
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Stripe API ${res.status}: ${err.slice(0, 200)}`)
  }
  return res.json()
}

interface StripeListItem {
  id: string
  amount?: number
  status?: string
}

interface StripeListPage {
  data?: StripeListItem[]
  has_more?: boolean
}

const PAGE_LIMIT = 100
/** Hard bound on pages followed per metric (100 records/page). Stripe removed
 *  `total_count` from list responses, so counts/sums MUST be built by walking
 *  every page via `has_more` + `starting_after` — never by reading a single
 *  page's length as the whole answer, which silently undercounts past 100
 *  records. This cap exists so an account with more history than we're
 *  willing to page through fails LOUDLY instead of reporting that undercount
 *  as if it were correct. */
const MAX_PAGES = 20

/** Thrown when a metric's pagination hits `MAX_PAGES` while Stripe still
 *  reports `has_more`. Deliberately NOT caught by the per-metric degrade-to-0
 *  fallback below — an unknown-but-large count is not the same failure as an
 *  upstream 500, and reporting either as a plain 0 would be a silent lie. */
export class StripePageCapExceededError extends Error {}

/**
 * Walk every page of a Stripe list endpoint via `starting_after`, never
 * reading `total_count` (removed/unsupported on these list endpoints).
 */
async function paginateStripe(
  path: string,
  params: string,
  key: string,
): Promise<StripeListItem[]> {
  const results: StripeListItem[] = []
  let startingAfter: string | undefined

  for (let page = 0; page < MAX_PAGES; page++) {
    const qp = startingAfter
      ? `${params}&starting_after=${encodeURIComponent(startingAfter)}`
      : params
    const d = (await stripeGet(`${path}?${qp}`, key)) as StripeListPage
    const data = d.data ?? []
    results.push(...data)

    if (!d.has_more || data.length === 0) return results
    startingAfter = data[data.length - 1].id
  }

  throw new StripePageCapExceededError(
    `Stripe ${path}: exceeded ${MAX_PAGES} pages (${MAX_PAGES * PAGE_LIMIT} records) while ` +
    'more remained — refusing to report an undercounted total',
  )
}

/**
 * Ordinary upstream failures (network blip, 5xx, bad key) degrade this ONE
 * metric to `fallback` so one dead endpoint doesn't fail the whole sync — the
 * existing behavior. A page-cap failure is different in kind: the true count
 * is unknown, not zero, so it is rethrown and fails the whole Stripe source
 * instead of reporting a plausible-looking but wrong number.
 */
function degradeUnlessCapExceeded<T>(p: Promise<T>, op: string, fallback: T): Promise<T> {
  return p.catch((err: unknown) => {
    if (err instanceof StripePageCapExceededError) throw err
    return emptyOn(err, { module: 'kpi-sources/stripe', op }, fallback)
  })
}

function sumSucceeded(rows: StripeListItem[]): number {
  return rows.filter((r) => r.status === 'succeeded').reduce((s, r) => s + (r.amount ?? 0), 0)
}

export async function fetchStripeKPIs(): Promise<StripeKPI[]> {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) {
    console.warn('[kpi-sync/stripe] STRIPE_SECRET_KEY not set — skipping')
    return []
  }

  const now = Math.floor(Date.now() / 1000)
  const startOfMonth = Math.floor(new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime() / 1000)
  const startOfLastMonth = Math.floor(new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1).getTime() / 1000)
  const thirtyDaysAgo = now - 30 * 86400
  const sixtyDaysAgo = now - 60 * 86400

  // Run all Stripe queries in parallel. Each walks every page via
  // has_more/starting_after (never total_count) and degrades to 0 on an
  // ordinary upstream failure — but NOT on a page-cap failure, which
  // propagates and fails the whole sync (see degradeUnlessCapExceeded). Each
  // ordinary fallback passes through emptyOn so the request carries master's
  // x-hub-partial signal instead of presenting a plausible-looking zero as
  // complete data.
  const [
    activeSubs,
    revenueThisMonth,
    revenueLastMonth,
    newCustomersThisMonth,
    newCustomersLastMonth,
  ] = await Promise.all([
    // Active subscriptions count
    degradeUnlessCapExceeded(
      paginateStripe('subscriptions', `status=active&limit=${PAGE_LIMIT}`, key).then((rows) => rows.length),
      'countActiveSubscriptions',
      0,
    ),

    // Charges succeeded this month
    degradeUnlessCapExceeded(
      paginateStripe('charges', `created[gte]=${startOfMonth}&limit=${PAGE_LIMIT}`, key).then(sumSucceeded),
      'sumChargesThisMonth',
      0,
    ),

    // Charges succeeded last month
    degradeUnlessCapExceeded(
      paginateStripe(
        'charges',
        `created[gte]=${startOfLastMonth}&created[lt]=${startOfMonth}&limit=${PAGE_LIMIT}`,
        key,
      ).then(sumSucceeded),
      'sumChargesLastMonth',
      0,
    ),

    // New customers last 30 days
    degradeUnlessCapExceeded(
      paginateStripe('customers', `created[gte]=${thirtyDaysAgo}&limit=${PAGE_LIMIT}`, key).then((rows) => rows.length),
      'countNewCustomers30d',
      0,
    ),

    // New customers 31–60 days ago
    degradeUnlessCapExceeded(
      paginateStripe(
        'customers',
        `created[gte]=${sixtyDaysAgo}&created[lt]=${thirtyDaysAgo}&limit=${PAGE_LIMIT}`,
        key,
      ).then((rows) => rows.length),
      'countNewCustomers31to60d',
      0,
    ),
  ])

  // MRR estimate = active subs × avg monthly charge
  // For a real MRR, use Stripe Billing's /v1/billing/meters or Stripe Revenue Recognition
  // This is a reasonable approximation from active subscription totals
  const mrrEstimate = activeSubs > 0 && revenueThisMonth > 0
    ? Math.round(revenueThisMonth / activeSubs) * activeSubs
    : 0

  const revTrend = computeTrend(revenueThisMonth, revenueLastMonth)
  const custTrend = computeTrend(newCustomersThisMonth, newCustomersLastMonth)

  return [
    {
      id: 'stripe_revenue_mtd',
      label: 'Revenue (MTD)',
      value: centsToDollars(revenueThisMonth),
      unit: '$',
      trend: revTrend.trend,
      trendDirection: revTrend.direction,
      rawValue: revenueThisMonth,
    },
    {
      id: 'stripe_mrr',
      label: 'MRR',
      value: centsToDollars(mrrEstimate),
      unit: '$',
      trend: revTrend.trend,          // same direction as revenue
      trendDirection: revTrend.direction,
      rawValue: mrrEstimate,
    },
    {
      id: 'stripe_active_subs',
      label: 'Active Members',
      value: String(activeSubs),
      unit: 'members',
      trend: '—',
      trendDirection: 'neutral',
      rawValue: activeSubs,
    },
    {
      id: 'stripe_new_customers',
      label: 'New Customers (30d)',
      value: String(newCustomersThisMonth),
      unit: 'customers',
      trend: custTrend.trend,
      trendDirection: custTrend.direction,
      rawValue: newCustomersThisMonth,
    },
  ]
}
