import { describe, it, expect, vi } from 'vitest'
import { createStripeSource, formatAmount, stripeObjectToDoc, type StripeEvent } from './stripe-source'

function event(id: string, created: number, object: Record<string, unknown>, type = 'x.updated'): StripeEvent {
  return { id, type, created, data: { object } }
}

describe('formatAmount', () => {
  it('handles minor units, zero-decimal currencies and absent amounts', () => {
    expect(formatAmount(12000, 'usd')).toBe('$120.00')
    expect(formatAmount(500, 'jpy')).toBe('¥500')
    expect(formatAmount(undefined, 'usd')).toBe('')
  })
})

describe('stripeObjectToDoc', () => {
  it('renders an invoice with its customer, totals and line items — and no bearer URLs', () => {
    const doc = stripeObjectToDoc(
      event('evt_1', 1_758_800_000, {
        object: 'invoice',
        id: 'in_1',
        number: 'RX-0042',
        status: 'paid',
        currency: 'usd',
        total: 18000,
        amount_paid: 18000,
        amount_due: 18000,
        customer: 'cus_1',
        customer_name: 'Jane Doe',
        customer_email: 'jane@example.com',
        hosted_invoice_url: 'https://invoice.stripe.com/i/secret-link',
        lines: { data: [{ description: '8 PT sessions', amount: 18000, currency: 'usd' }] },
      }, 'invoice.paid'),
    )!
    expect(doc.id).toBe('stripe-in_1')
    expect(doc.title).toBe('Stripe invoice RX-0042 — $180.00 paid — Jane Doe <jane@example.com>')
    expect(doc.structData).toMatchObject({
      source: 'stripe',
      object_type: 'invoice',
      customer_id: 'cus_1',
      customer_email: 'jane@example.com',
      amount: 180,
      status: 'paid',
      last_event: 'invoice.paid',
    })
    expect(JSON.stringify(doc)).not.toContain('secret-link')
    expect(doc.facts).toContainEqual(['Line items', '8 PT sessions ($180.00)'])
  })

  it('names a subscription from the customer map (its payload only carries an id)', () => {
    const doc = stripeObjectToDoc(
      event('evt_2', 1_758_800_000, {
        object: 'subscription',
        id: 'sub_1',
        status: 'canceled',
        customer: 'cus_9',
        items: { data: [{ quantity: 1, price: { nickname: 'Unlimited', unit_amount: 29900, currency: 'usd', recurring: { interval: 'month' } } }] },
      }),
      new Map([['cus_9', { name: 'Sam Lee', email: 'sam@example.com' }]]),
    )!
    expect(doc.title).toBe('Stripe subscription canceled — Sam Lee <sam@example.com>')
    expect(doc.facts).toContainEqual(['Items', 'Unlimited $299.00/month'])
  })

  it('marks a deleted customer instead of dropping it', () => {
    const doc = stripeObjectToDoc(event('evt_3', 1, { object: 'customer', id: 'cus_2', name: 'Old Client' }, 'customer.deleted'))!
    expect(doc.title).toContain('(deleted)')
    expect(doc.structData.status).toBe('deleted')
  })

  it('ignores object types it does not index', () => {
    expect(stripeObjectToDoc(event('evt_4', 1, { object: 'payout', id: 'po_1' }))).toBeNull()
  })
})

describe('createStripeSource.collect', () => {
  const since = new Date('2026-09-25T00:00:00Z')
  const until = new Date('2026-09-26T00:00:00Z')
  const t = (min: number) => Math.floor(since.getTime() / 1000) + min * 60

  function fakeStripe(pages: StripeEvent[][], customers: Record<string, { name: string; email: string }> = {}) {
    const urls: string[] = []
    let page = 0
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url)
      if (url.includes('/customers/')) {
        const id = decodeURIComponent(url.split('/customers/')[1])
        return customers[id] ? Response.json({ id, ...customers[id] }) : new Response('{}', { status: 404 })
      }
      const data = pages[page] ?? []
      page++
      return Response.json({ data, has_more: page < pages.length })
    })
    return { fetchImpl, urls }
  }

  it('pages the event stream, keeps the newest snapshot per object, and enriches subscriptions', async () => {
    // Stripe returns newest first.
    const { fetchImpl, urls } = fakeStripe(
      [
        [
          event('evt_c', t(3), { object: 'subscription', id: 'sub_1', status: 'active', customer: 'cus_9' }),
          event('evt_b', t(2), { object: 'charge', id: 'ch_1', amount: 5000, currency: 'usd', status: 'succeeded', refunded: true }),
        ],
        [
          event('evt_a', t(1), { object: 'charge', id: 'ch_1', amount: 5000, currency: 'usd', status: 'succeeded' }),
          event('evt_z', t(0), { object: 'payout', id: 'po_1' }),
        ],
      ],
      { cus_9: { name: 'Sam Lee', email: 'sam@example.com' } },
    )
    const source = createStripeSource({ apiKey: 'rk_test', fetchImpl })
    const out = await source.collect({ since, until }, { maxItems: 100 })

    expect(urls[0]).toContain(`created[gte]=${Math.floor(since.getTime() / 1000)}`)
    expect(urls[1]).toContain('starting_after=evt_b')
    expect(out.scanned).toBe(4)
    expect(out.truncated).toBe(false)
    expect(out.cursor).toEqual(until)
    expect(out.docs.map((d) => d.id)).toEqual(['stripe-ch_1', 'stripe-sub_1'])
    expect(out.docs[0].structData.status).toBe('refunded') // newest snapshot won
    expect(out.docs[1].title).toContain('Sam Lee')
  })

  it('truncates from the old end and resumes at the last processed event', async () => {
    const { fetchImpl } = fakeStripe([
      [
        event('evt_3', t(3), { object: 'customer', id: 'cus_3' }),
        event('evt_2', t(2), { object: 'customer', id: 'cus_2' }),
        event('evt_1', t(1), { object: 'customer', id: 'cus_1' }),
      ],
    ])
    const out = await createStripeSource({ apiKey: 'rk', fetchImpl }).collect({ since, until }, { maxItems: 2 })
    expect(out.docs.map((d) => d.id)).toEqual(['stripe-cus_1', 'stripe-cus_2'])
    expect(out.truncated).toBe(true)
    expect(out.cursor).toEqual(new Date(t(2) * 1000))
  })

  it('a failed customer lookup degrades to the id, never fails the run', async () => {
    const { fetchImpl } = fakeStripe([[event('evt_1', t(1), { object: 'subscription', id: 'sub_1', status: 'active', customer: 'cus_gone' })]])
    const out = await createStripeSource({ apiKey: 'rk', fetchImpl }).collect({ since, until }, { maxItems: 10 })
    expect(out.docs[0].title).toBe('Stripe subscription active — customer cus_gone')
  })

  it('surfaces an auth failure on the event list', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ error: { message: 'Invalid API Key provided' } }, { status: 401 }))
    await expect(createStripeSource({ apiKey: 'bad', fetchImpl }).collect({ since, until }, { maxItems: 10 })).rejects.toMatchObject({
      stage: 'collect',
      httpStatus: 401,
      message: expect.stringContaining('Invalid API Key'),
    })
  })
})
