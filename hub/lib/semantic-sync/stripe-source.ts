/**
 * Stripe → Semantic Brain documents.
 *
 * Reads the account's EVENT stream for the window rather than listing each
 * object type by `created`: list endpoints only filter on creation, so a
 * subscription cancelled today (created last year) would never be seen. Every
 * event carries a snapshot of its object; events are replayed oldest first and
 * the newest snapshot per object wins, so each customer / charge / invoice /
 * subscription / checkout session / refund is ONE document whose id is stable
 * (`stripe-<object id>`) and whose content is its latest known state. Stripe
 * keeps events for 30 days, which bounds how far a catch-up can reach.
 *
 * Deliberately NOT indexed: card/payment-method details, and hosted invoice or
 * receipt URLs (bearer links — anyone holding one can view or pay).
 */

import type { SyncDoc, StructValue } from './documents'
import { toDocumentId } from './documents'
import { SemanticSyncError, failFromResponse, fetchWithRetry, type FetchLike } from './http'
import { LIST_CAP, type CollectResult, type SyncSource, type SyncWindow } from './source'

const API = 'https://api.stripe.com/v1'
const PAGE_LIMIT = 100
/** Customer lookups per run, to put names on subscriptions (whose events carry only an id). */
const MAX_CUSTOMER_LOOKUPS = 100

export const STRIPE_OBJECT_TYPES = ['customer', 'charge', 'invoice', 'subscription', 'checkout.session', 'refund'] as const

type Obj = Record<string, unknown>

export interface StripeEvent {
  id: string
  type: string
  created: number
  data: { object: Obj }
}

interface CustomerRef {
  name?: string
  email?: string
}

const str = (o: Obj | undefined, k: string): string | undefined => {
  const v = o?.[k]
  return typeof v === 'string' && v ? v : undefined
}
const num = (o: Obj | undefined, k: string): number | undefined => {
  const v = o?.[k]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
const obj = (o: Obj | undefined, k: string): Obj | undefined => {
  const v = o?.[k]
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined
}
/** `customer` is an id string, or an expanded object on some payloads. */
const customerId = (o: Obj): string | undefined => str(o, 'customer') ?? str(obj(o, 'customer'), 'id')

const ZERO_DECIMAL = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf',
])

/** 12000 + 'usd' → "$120.00". Stripe amounts are in the currency's minor unit. */
export function formatAmount(amount: number | undefined, currency: string | undefined): string {
  if (amount === undefined) return ''
  const cur = (currency ?? 'usd').toLowerCase()
  const major = ZERO_DECIMAL.has(cur) ? amount : amount / 100
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur.toUpperCase() }).format(major)
  } catch {
    return `${major.toFixed(2)} ${cur.toUpperCase()}`
  }
}

const isoDate = (sec: number | undefined): string => (sec ? new Date(sec * 1000).toISOString() : '')

function metadataLine(o: Obj): string {
  const md = obj(o, 'metadata')
  if (!md) return ''
  return Object.entries(md)
    .filter(([, v]) => typeof v === 'string' && v)
    .slice(0, 20)
    .map(([k, v]) => `${k}=${String(v).slice(0, 200)}`)
    .join('; ')
}

function who(name?: string, email?: string): string {
  if (name && email) return `${name} <${email}>`
  return name ?? email ?? ''
}

/**
 * Render one object snapshot as a document. Exported for tests; `customers`
 * supplies names for objects whose payload carries only a customer id.
 */
export function stripeObjectToDoc(event: StripeEvent, customers: Map<string, CustomerRef> = new Map()): SyncDoc | null {
  const o = event.data.object
  const kind = str(o, 'object')
  const id = str(o, 'id')
  if (!kind || !id) return null

  const cid = kind === 'customer' ? id : customerId(o)
  const known = cid ? customers.get(cid) : undefined
  const currency = str(o, 'currency')
  const facts: Array<[string, string]> = []
  const struct: Record<string, StructValue> = {
    source: 'stripe',
    object_type: kind,
    stripe_id: id,
    last_event: event.type,
  }
  if (cid) struct.customer_id = cid
  let title: string

  switch (kind) {
    case 'customer': {
      const name = str(o, 'name')
      const email = str(o, 'email')
      const deleted = o.deleted === true || event.type === 'customer.deleted'
      title = `Stripe customer: ${who(name, email) || id}${deleted ? ' (deleted)' : ''}`
      facts.push(
        ['Name', name ?? ''],
        ['Email', email ?? ''],
        ['Phone', str(o, 'phone') ?? ''],
        ['Description', str(o, 'description') ?? ''],
        ['Customer since', isoDate(num(o, 'created'))],
        ['Status', deleted ? 'deleted in Stripe' : o.delinquent === true ? 'delinquent' : 'active'],
      )
      if (name) struct.customer_name = name
      if (email) struct.customer_email = email
      struct.status = deleted ? 'deleted' : 'active'
      break
    }
    case 'charge': {
      const billing = obj(o, 'billing_details')
      const name = str(billing, 'name') ?? known?.name
      const email = str(o, 'receipt_email') ?? str(billing, 'email') ?? known?.email
      const status = o.refunded === true ? 'refunded' : (str(o, 'status') ?? 'unknown')
      title = `Stripe charge ${formatAmount(num(o, 'amount'), currency)} ${status}${who(name, email) ? ` — ${who(name, email)}` : ''}`
      facts.push(
        ['Amount', formatAmount(num(o, 'amount'), currency)],
        ['Status', status],
        ['Amount refunded', num(o, 'amount_refunded') ? formatAmount(num(o, 'amount_refunded'), currency) : ''],
        ['Customer', who(name, email)],
        ['Description', str(o, 'description') ?? ''],
        ['Statement descriptor', str(o, 'calculated_statement_descriptor') ?? ''],
        ['Failure', str(o, 'failure_message') ?? ''],
        ['Created', isoDate(num(o, 'created'))],
      )
      struct.status = status
      struct.amount = (num(o, 'amount') ?? 0) / (ZERO_DECIMAL.has(currency ?? '') ? 1 : 100)
      if (email) struct.customer_email = email
      if (name) struct.customer_name = name
      break
    }
    case 'invoice': {
      const name = str(o, 'customer_name') ?? known?.name
      const email = str(o, 'customer_email') ?? known?.email
      const status = str(o, 'status') ?? 'unknown'
      const number = str(o, 'number') ?? id
      const lines = ((obj(o, 'lines')?.data as Obj[] | undefined) ?? [])
        .slice(0, 10)
        .map((l) => `${str(l, 'description') ?? 'line item'} (${formatAmount(num(l, 'amount'), str(l, 'currency') ?? currency)})`)
      title = `Stripe invoice ${number} — ${formatAmount(num(o, 'total'), currency)} ${status}${who(name, email) ? ` — ${who(name, email)}` : ''}`
      facts.push(
        ['Invoice number', number],
        ['Status', status],
        ['Total', formatAmount(num(o, 'total'), currency)],
        ['Amount paid', formatAmount(num(o, 'amount_paid'), currency)],
        ['Amount due', formatAmount(num(o, 'amount_due'), currency)],
        ['Customer', who(name, email)],
        ['Due date', isoDate(num(o, 'due_date'))],
        ['Period', num(o, 'period_start') ? `${isoDate(num(o, 'period_start'))} → ${isoDate(num(o, 'period_end'))}` : ''],
        ['Line items', lines.join('; ')],
        ['Created', isoDate(num(o, 'created'))],
      )
      struct.status = status
      struct.amount = (num(o, 'total') ?? 0) / (ZERO_DECIMAL.has(currency ?? '') ? 1 : 100)
      if (email) struct.customer_email = email
      if (name) struct.customer_name = name
      break
    }
    case 'subscription': {
      const status = str(o, 'status') ?? 'unknown'
      const items = ((obj(o, 'items')?.data as Obj[] | undefined) ?? []).slice(0, 10).map((it) => {
        const price = obj(it, 'price')
        const recurring = obj(price, 'recurring')
        const label = str(price, 'nickname') ?? str(price, 'lookup_key') ?? str(price, 'product') ?? str(price, 'id') ?? 'price'
        const every = str(recurring, 'interval') ? `/${str(recurring, 'interval')}` : ''
        const qty = num(it, 'quantity')
        return `${label} ${formatAmount(num(price, 'unit_amount'), str(price, 'currency') ?? currency)}${every}${qty && qty > 1 ? ` ×${qty}` : ''}`
      })
      title = `Stripe subscription ${status}${who(known?.name, known?.email) ? ` — ${who(known?.name, known?.email)}` : cid ? ` — customer ${cid}` : ''}`
      facts.push(
        ['Status', status],
        ['Customer', who(known?.name, known?.email) || (cid ?? '')],
        ['Items', items.join('; ')],
        ['Started', isoDate(num(o, 'start_date'))],
        ['Current period ends', isoDate(num(o, 'current_period_end'))],
        ['Cancels at period end', o.cancel_at_period_end === true ? 'yes' : ''],
        ['Canceled at', isoDate(num(o, 'canceled_at'))],
        ['Trial ends', isoDate(num(o, 'trial_end'))],
      )
      struct.status = status
      if (known?.email) struct.customer_email = known.email
      if (known?.name) struct.customer_name = known.name
      break
    }
    case 'checkout.session': {
      const details = obj(o, 'customer_details')
      const name = str(details, 'name') ?? known?.name
      const email = str(details, 'email') ?? known?.email
      const status = str(o, 'payment_status') ?? str(o, 'status') ?? 'unknown'
      title = `Stripe checkout ${formatAmount(num(o, 'amount_total'), currency)} ${status}${who(name, email) ? ` — ${who(name, email)}` : ''}`
      facts.push(
        ['Amount', formatAmount(num(o, 'amount_total'), currency)],
        ['Payment status', status],
        ['Mode', str(o, 'mode') ?? ''],
        ['Customer', who(name, email)],
        ['Created', isoDate(num(o, 'created'))],
      )
      struct.status = status
      if (email) struct.customer_email = email
      if (name) struct.customer_name = name
      break
    }
    case 'refund': {
      const status = str(o, 'status') ?? 'unknown'
      title = `Stripe refund ${formatAmount(num(o, 'amount'), currency)} ${status}`
      facts.push(
        ['Amount', formatAmount(num(o, 'amount'), currency)],
        ['Status', status],
        ['Reason', str(o, 'reason') ?? ''],
        ['Charge', str(o, 'charge') ?? ''],
        ['Created', isoDate(num(o, 'created'))],
      )
      struct.status = status
      break
    }
    default:
      return null
  }

  facts.push(['Metadata', metadataLine(o)], ['Last event', `${event.type} at ${isoDate(event.created)}`], ['Stripe id', id])
  return {
    id: toDocumentId('stripe', id),
    title,
    updatedAt: new Date(event.created * 1000),
    facts,
    structData: struct,
  }
}

export function createStripeSource(opts: {
  apiKey: string
  fetchImpl?: FetchLike
}): SyncSource {
  const fetchImpl = opts.fetchImpl ?? fetch
  const headers = { Authorization: `Bearer ${opts.apiKey}` }

  async function listEvents(window: SyncWindow, signal?: AbortSignal): Promise<StripeEvent[]> {
    const events: StripeEvent[] = []
    const base =
      `limit=${PAGE_LIMIT}` +
      `&created[gte]=${Math.floor(window.since.getTime() / 1000)}` +
      `&created[lte]=${Math.floor(window.until.getTime() / 1000)}`
    let startingAfter: string | undefined
    for (;;) {
      const qs = startingAfter ? `${base}&starting_after=${encodeURIComponent(startingAfter)}` : base
      const res = await fetchWithRetry(fetchImpl, `${API}/events?${qs}`, { headers, signal })
      if (!res.ok) await failFromResponse('collect', 'Stripe list events', res)
      const page = (await res.json()) as { data?: StripeEvent[]; has_more?: boolean }
      const data = page.data ?? []
      events.push(...data)
      if (events.length > LIST_CAP) {
        throw new SemanticSyncError(
          'collect',
          `Stripe window holds more than ${LIST_CAP} events — rerun with a smaller lookbackHours`,
        )
      }
      if (!page.has_more || data.length === 0) return events
      startingAfter = data[data.length - 1].id
    }
  }

  async function lookupCustomers(ids: string[], signal?: AbortSignal): Promise<Map<string, CustomerRef>> {
    const out = new Map<string, CustomerRef>()
    for (const cid of ids.slice(0, MAX_CUSTOMER_LOOKUPS)) {
      // Best-effort enrichment: a failed lookup leaves the document with the
      // customer id, which is still correct — never fail the run over a name.
      try {
        const res = await fetchWithRetry(fetchImpl, `${API}/customers/${encodeURIComponent(cid)}`, { headers, signal })
        if (!res.ok) {
          await res.text().catch(() => '')
          continue
        }
        const c = (await res.json()) as Obj
        out.set(cid, { name: str(c, 'name'), email: str(c, 'email') })
      } catch (err) {
        if (signal?.aborted) throw err
      }
    }
    return out
  }

  return {
    id: 'stripe',
    async collect(window, { maxItems, signal }): Promise<CollectResult> {
      const listed = await listEvents(window, signal)
      // Stripe lists newest first; replay oldest first.
      const relevant = listed
        .filter((e) => (STRIPE_OBJECT_TYPES as readonly string[]).includes(str(e.data?.object, 'object') ?? ''))
        .sort((a, b) => a.created - b.created)
      const truncated = relevant.length > maxItems
      const batch = relevant.slice(0, maxItems)

      // Latest snapshot per object wins.
      const latest = new Map<string, StripeEvent>()
      for (const e of batch) latest.set(str(e.data.object, 'id') ?? e.id, e)

      // Subscription payloads carry only a customer id. Customers whose own
      // snapshot is in this batch already have a name; look up the rest.
      // (Charges, invoices and checkout sessions carry their own name/email.)
      const customers = new Map<string, CustomerRef>()
      for (const e of latest.values()) {
        const o = e.data.object
        if (str(o, 'object') === 'customer') customers.set(str(o, 'id')!, { name: str(o, 'name'), email: str(o, 'email') })
      }
      const needLookup = new Set<string>()
      for (const e of latest.values()) {
        const o = e.data.object
        const cid = customerId(o)
        if (str(o, 'object') === 'subscription' && cid && !customers.has(cid)) needLookup.add(cid)
      }
      for (const [cid, ref] of await lookupCustomers([...needLookup], signal)) customers.set(cid, ref)

      const docs = [...latest.values()]
        .sort((a, b) => a.created - b.created)
        .map((e) => stripeObjectToDoc(e, customers))
        .filter((d): d is SyncDoc => d !== null)

      return {
        docs,
        scanned: listed.length,
        truncated,
        cursor: truncated ? new Date(batch[batch.length - 1].created * 1000) : window.until,
      }
    },
  }
}
