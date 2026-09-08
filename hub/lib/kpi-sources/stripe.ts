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

  // Run all Stripe queries in parallel.
  //
  // Every per-query catch is emptyOn, NOT swallow: a failed query resolves to
  // 0, which flows straight into the KPI rows below ($0 Revenue MTD, $0 MRR,
  // 0 Active Members, 0 New Customers) and from there into the kpis table via
  // the withFault-wrapped POST /api/kpis/sync. Nothing upstream can tell "no
  // revenue" from "Stripe was down" — the response is shaped like success with
  // the data missing, which is exactly the silent-data-omission class emptyOn
  // exists for. emptyOn ticks the partial counter and marks the request so the
  // sync response carries x-hub-partial: 1, while keeping the original per-
  // query degrade-to-0 behaviour that lets one bad endpoint not sink the sync.
  const [
    activeSubs,
    revenueThisMonth,
    revenueLastMonth,
    newCustomersThisMonth,
    newCustomersLastMonth,
  ] = await Promise.all([
    // Active subscriptions count
    stripeGet('subscriptions?status=active&limit=1', key)
      .then(d => (d.total_count as number) ?? 0)
      .catch((err: unknown) => emptyOn(err, { module: 'kpi-sources/stripe', op: 'countActiveSubscriptions' }, 0)),

    // Charges succeeded this month
    stripeGet(`charges?created[gte]=${startOfMonth}&limit=100`, key)
      .then(d => {
        const data = (d.data as Array<{ amount: number; status: string }>) ?? []
        return data.filter(c => c.status === 'succeeded').reduce((s, c) => s + c.amount, 0)
      })
      .catch((err: unknown) => emptyOn(err, { module: 'kpi-sources/stripe', op: 'sumChargesThisMonth' }, 0)),

    // Charges succeeded last month
    stripeGet(`charges?created[gte]=${startOfLastMonth}&created[lt]=${startOfMonth}&limit=100`, key)
      .then(d => {
        const data = (d.data as Array<{ amount: number; status: string }>) ?? []
        return data.filter(c => c.status === 'succeeded').reduce((s, c) => s + c.amount, 0)
      })
      .catch((err: unknown) => emptyOn(err, { module: 'kpi-sources/stripe', op: 'sumChargesLastMonth' }, 0)),

    // New customers last 30 days
    stripeGet(`customers?created[gte]=${thirtyDaysAgo}&limit=1`, key)
      .then(d => (d.total_count as number) ?? 0)
      .catch((err: unknown) => emptyOn(err, { module: 'kpi-sources/stripe', op: 'countNewCustomers30d' }, 0)),

    // New customers 31–60 days ago
    stripeGet(`customers?created[gte]=${sixtyDaysAgo}&created[lt]=${thirtyDaysAgo}&limit=1`, key)
      .then(d => (d.total_count as number) ?? 0)
      .catch((err: unknown) => emptyOn(err, { module: 'kpi-sources/stripe', op: 'countNewCustomers31to60d' }, 0)),
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
