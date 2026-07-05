import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { executeAction } from '@/lib/actions/executeAction'
import type { ActionSpec } from '@/types'

/* ── Helpers ── */

const deps = {
  activeCompany: { id: 'co-1', name: 'RxFit', identifier: 'RXF' },
  mutate: vi.fn(),
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
  }
}

function specFor(intent: ActionSpec['intent'], details: Record<string, string>): ActionSpec {
  return {
    intent,
    details,
    targetSystems: [],
    summary: `${intent} — test`,
    requiredPermission: 'staff',
  }
}

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/* ── send_gmail ── */

describe('executeAction: send_gmail', () => {
  it('POSTs to /api/google/gmail with to/subject/message and reports success', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ sent: true, messageId: 'm1' }))

    const result = await executeAction(
      specFor('send_gmail', {
        to: 'maria@rxfitatx.com',
        subject: 'Invoice',
        body: 'The invoice is paid',
      }),
      deps
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/google/gmail')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({
      to: 'maria@rxfitatx.com',
      subject: 'Invoice',
      message: 'The invoice is paid',
    })
    expect(result).toContain('Email sent')
    expect(result).toContain('maria@rxfitatx.com')
    expect(result).toContain('Invoice')
  })

  it('defaults the subject and falls back to details for the body', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ sent: true }))

    await executeAction(
      specFor('send_gmail', {
        to: 'maria@rxfitatx.com',
        details: 'Free-text collected answer',
      }),
      deps
    )

    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init.body)).toEqual({
      to: 'maria@rxfitatx.com',
      subject: '(no subject)',
      message: 'Free-text collected answer',
    })
  })

  it('throws with the status when the send fails', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'nope' }, false, 500))

    await expect(
      executeAction(
        specFor('send_gmail', { to: 'maria@rxfitatx.com', subject: 'x', body: 'y' }),
        deps
      )
    ).rejects.toThrow('Email send failed: 500')
  })
})

/* ── post_chat_message ── */

describe('executeAction: post_chat_message', () => {
  it('resolves the space by display name and POSTs the message', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          spaces: [
            { name: 'spaces/AAA', displayName: 'RxFit Ops' },
            { name: 'spaces/BBB', displayName: 'Random Team' },
          ],
        })
      )
      .mockResolvedValueOnce(jsonResponse({ message: { name: 'spaces/AAA/messages/1' } }))

    const result = await executeAction(
      specFor('post_chat_message', { space: 'rxfit ops', message: 'Demo moved to 3pm' }),
      deps
    )

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/google/chat/spaces')

    const [url, init] = fetchMock.mock.calls[1]
    expect(url).toBe('/api/google/chat/messages')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({
      spaceId: 'spaces/AAA',
      text: 'Demo moved to 3pm',
    })
    expect(result).toContain('Posted to RxFit Ops')
  })

  it('throws when no space matches', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ spaces: [{ name: 'spaces/BBB', displayName: 'Random Team' }] })
    )

    await expect(
      executeAction(
        specFor('post_chat_message', { space: 'RxFit Ops', message: 'hi' }),
        deps
      )
    ).rejects.toThrow('Chat space matching "RxFit Ops" not found')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('throws listing candidates when multiple spaces match — never picks silently', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        spaces: [
          { name: 'spaces/AAA', displayName: 'RxFit Ops' },
          { name: 'spaces/CCC', displayName: 'RxFit Ops Archive' },
        ],
      })
    )

    await expect(
      executeAction(
        specFor('post_chat_message', { space: 'rxfit ops', message: 'hi' }),
        deps
      )
    ).rejects.toThrow(/RxFit Ops.*RxFit Ops Archive/)
    expect(fetchMock).toHaveBeenCalledTimes(1) // no message POST attempted
  })

  it('throws with the status when the spaces fetch fails', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'nope' }, false, 403))

    await expect(
      executeAction(
        specFor('post_chat_message', { space: 'RxFit Ops', message: 'hi' }),
        deps
      )
    ).rejects.toThrow('Failed to fetch Chat spaces: 403')
  })

  it('throws with the status when the message POST fails', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ spaces: [{ name: 'spaces/AAA', displayName: 'RxFit Ops' }] })
      )
      .mockResolvedValueOnce(jsonResponse({ error: 'nope' }, false, 500))

    await expect(
      executeAction(
        specFor('post_chat_message', { space: 'RxFit Ops', message: 'hi' }),
        deps
      )
    ).rejects.toThrow('Chat message failed: 500')
  })
})
