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

function specFor(
  intent: ActionSpec['intent'],
  details: Record<string, string>,
  gateToken?: string
): ActionSpec {
  return {
    intent,
    details,
    targetSystems: [],
    summary: `${intent} — test`,
    requiredPermission: 'staff',
    ...(gateToken ? { gateToken } : {}),
  }
}

/** Signed-token stand-in — the routes verify it server-side, the client just carries it. */
const GATE_TOKEN = 'body.signature'

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
  /**
   * Drafts-first (§6.1): a send is TWO calls — create the draft, then send it.
   * The second call is what delivers; the first exists so a failed delivery
   * leaves the composed email recoverable in Gmail instead of losing it.
   */
  const draftOk = () => jsonResponse({ sent: false, draftId: 'd1', to: 'maria@rxfitatx.com' })

  it('creates a draft, then sends it, and reports success', async () => {
    fetchMock
      .mockResolvedValueOnce(draftOk())
      .mockResolvedValueOnce(jsonResponse({ sent: true, messageId: 'm1' }))

    const result = await executeAction(
      specFor('send_gmail', {
        to: 'maria@rxfitatx.com',
        subject: 'Invoice',
        body: 'The invoice is paid',
      }, GATE_TOKEN),
      deps
    )

    expect(fetchMock).toHaveBeenCalledTimes(2)

    const [draftUrl, draftInit] = fetchMock.mock.calls[0]
    expect(draftUrl).toBe('/api/google/gmail')
    expect(JSON.parse(draftInit.body)).toEqual({
      to: 'maria@rxfitatx.com',
      subject: 'Invoice',
      message: 'The invoice is paid',
      mode: 'draft',
    })

    // The delivering call references the draft — it does not re-send the body,
    // which would risk sending something other than what was drafted.
    const [sendUrl, sendInit] = fetchMock.mock.calls[1]
    expect(sendUrl).toBe('/api/google/gmail')
    expect(JSON.parse(sendInit.body)).toEqual({ draftId: 'd1' })

    expect(result).toContain('Email sent')
    expect(result).toContain('maria@rxfitatx.com')
    expect(result).toContain('Invoice')
  })

  it('attaches X-Gate-Token and X-AI-Intent headers to BOTH calls (P0-2)', async () => {
    fetchMock
      .mockResolvedValueOnce(draftOk())
      .mockResolvedValueOnce(jsonResponse({ sent: true }))

    await executeAction(
      specFor('send_gmail', { to: 'maria@rxfitatx.com', subject: 'x', body: 'y' }, GATE_TOKEN),
      deps
    )

    const expected = {
      'Content-Type': 'application/json',
      'X-Gate-Token': GATE_TOKEN,
      'X-AI-Intent': 'send_gmail',
    }
    // The send half is the side-effecting one; an ungated second call would
    // reopen exactly the hole the gate closes.
    expect(fetchMock.mock.calls[0][1].headers).toEqual(expected)
    expect(fetchMock.mock.calls[1][1].headers).toEqual(expected)
  })

  it('throws without fetching when the quality-gate token is missing (fail fast)', async () => {
    await expect(
      executeAction(
        specFor('send_gmail', { to: 'maria@rxfitatx.com', subject: 'x', body: 'y' }),
        deps
      )
    ).rejects.toThrow('Missing quality-gate token')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('defaults the subject and falls back to details for the body', async () => {
    fetchMock
      .mockResolvedValueOnce(draftOk())
      .mockResolvedValueOnce(jsonResponse({ sent: true }))

    await executeAction(
      specFor('send_gmail', {
        to: 'maria@rxfitatx.com',
        details: 'Free-text collected answer',
      }, GATE_TOKEN),
      deps
    )

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      to: 'maria@rxfitatx.com',
      subject: '(no subject)',
      message: 'Free-text collected answer',
      mode: 'draft',
    })
  })

  it('folds a real additionalContext (lightweight flow) into the email body', async () => {
    fetchMock
      .mockResolvedValueOnce(draftOk())
      .mockResolvedValueOnce(jsonResponse({ sent: true }))

    await executeAction(
      specFor('send_gmail', {
        to: 'maria@rxfitatx.com',
        subject: 'Invoice',
        body: 'The invoice is paid',
        additionalContext: 'CC the CFO and keep it formal',
      }, GATE_TOKEN),
      deps
    )

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).message)
      .toBe('The invoice is paid\n\nCC the CFO and keep it formal')
  })

  it('uses additionalContext as the body when no body/details were extracted', async () => {
    fetchMock
      .mockResolvedValueOnce(draftOk())
      .mockResolvedValueOnce(jsonResponse({ sent: true }))

    await executeAction(
      specFor('send_gmail', {
        to: 'maria@rxfitatx.com',
        additionalContext: 'Let the team know the demo moved to 3pm',
      }, GATE_TOKEN),
      deps
    )

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).message)
      .toBe('Let the team know the demo moved to 3pm')
  })

  it('throws with the status when the DRAFT step fails, without attempting a send', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'nope' }, false, 500))

    await expect(
      executeAction(
        specFor('send_gmail', { to: 'maria@rxfitatx.com', subject: 'x', body: 'y' }, GATE_TOKEN),
        deps
      )
    ).rejects.toThrow('Email draft failed: 500')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("surfaces the server's message when the SEND step fails, so the user is told the draft survived", async () => {
    fetchMock
      .mockResolvedValueOnce(draftOk())
      .mockResolvedValueOnce(
        jsonResponse(
          { error: 'Could not send the email. It is saved in your Gmail drafts — nothing was lost. (Gmail API 503)' },
          false,
          502,
        ),
      )

    await expect(
      executeAction(
        specFor('send_gmail', { to: 'maria@rxfitatx.com', subject: 'x', body: 'y' }, GATE_TOKEN),
        deps
      )
    ).rejects.toThrow(/saved in your Gmail drafts/)
  })

  it('throws when the draft call returns no id rather than sending nothing', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ sent: false }))

    await expect(
      executeAction(
        specFor('send_gmail', { to: 'maria@rxfitatx.com', subject: 'x', body: 'y' }, GATE_TOKEN),
        deps
      )
    ).rejects.toThrow('Gmail did not return a draft id')
    expect(fetchMock).toHaveBeenCalledTimes(1)
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
      specFor('post_chat_message', { space: 'rxfit ops', message: 'Demo moved to 3pm' }, GATE_TOKEN),
      deps
    )

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/google/chat/spaces')
    // The spaces GET is a read — it must NOT carry gate headers.
    expect(fetchMock.mock.calls[0][1]).toBeUndefined()

    const [url, init] = fetchMock.mock.calls[1]
    expect(url).toBe('/api/google/chat/messages')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      'X-Gate-Token': GATE_TOKEN,
      'X-AI-Intent': 'post_chat_message',
    })
    expect(JSON.parse(init.body)).toEqual({
      spaceId: 'spaces/AAA',
      // AI-originated posts carry the Hub tag (lib/chat-post-tag.ts) so other
      // agents in the space can tell them from the operator typing.
      text: 'Demo moved to 3pm\n\n— via HUB',
    })
    expect(result).toContain('Posted to RxFit Ops')
  })

  it('throws without fetching when the quality-gate token is missing (fail fast)', async () => {
    await expect(
      executeAction(
        specFor('post_chat_message', { space: 'RxFit Ops', message: 'hi' }),
        deps
      )
    ).rejects.toThrow('Missing quality-gate token')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('throws when no space matches', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ spaces: [{ name: 'spaces/BBB', displayName: 'Random Team' }] })
    )

    await expect(
      executeAction(
        specFor('post_chat_message', { space: 'RxFit Ops', message: 'hi' }, GATE_TOKEN),
        deps
      )
    ).rejects.toThrow('Chat space matching "RxFit Ops" not found')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('throws listing candidates when multiple spaces match with no exact match — never picks silently', async () => {
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
        specFor('post_chat_message', { space: 'RxFit', message: 'hi' }, GATE_TOKEN),
        deps
      )
    ).rejects.toThrow(/RxFit Ops.*RxFit Ops Archive/)
    expect(fetchMock).toHaveBeenCalledTimes(1) // no message POST attempted
  })

  it('prefers the exact-name match when one space name contains another', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          spaces: [
            { name: 'spaces/AAA', displayName: 'RxFit Ops' },
            { name: 'spaces/CCC', displayName: 'RxFit Ops Archive' },
          ],
        })
      )
      .mockResolvedValueOnce(jsonResponse({ message: { name: 'spaces/AAA/messages/2' } }))

    const result = await executeAction(
      specFor('post_chat_message', { space: 'rxfit ops', message: 'hi' }, GATE_TOKEN),
      deps
    )

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [url, init] = fetchMock.mock.calls[1]
    expect(url).toBe('/api/google/chat/messages')
    expect(JSON.parse(init.body)).toEqual({ spaceId: 'spaces/AAA', text: 'hi\n\n— via HUB' })
    expect(result).toContain('Posted to RxFit Ops')
  })

  it('throws with the status when the spaces fetch fails', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'nope' }, false, 403))

    await expect(
      executeAction(
        specFor('post_chat_message', { space: 'RxFit Ops', message: 'hi' }, GATE_TOKEN),
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
        specFor('post_chat_message', { space: 'RxFit Ops', message: 'hi' }, GATE_TOKEN),
        deps
      )
    ).rejects.toThrow('Chat message failed: 500')
  })
})

/* ── Google Docs/Sheets (lightweight flow: extracted title/content + additionalContext) ── */

describe('executeAction: create_google_doc', () => {
  it('POSTs title + body, folding a real additionalContext into the doc body', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ doc: { title: 'Q3 Memo', documentUrl: 'http://doc' } }))

    await executeAction(
      specFor('create_google_doc', {
        title: 'Q3 Memo',
        content: 'Recommendation: proceed.',
        additionalContext: 'Add a risks section.',
      }),
      deps
    )

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/google/doc')
    expect(JSON.parse(init.body)).toEqual({
      title: 'Q3 Memo',
      body: 'Recommendation: proceed.\n\nAdd a risks section.',
    })
  })

  it('creates a doc from a title alone (content empty, no context added)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ doc: { title: 'Notes', documentUrl: 'http://doc' } }))

    // Skip phrases like "go ahead" are stripped in buildConfirmationSpec, so by
    // the time executeAction runs there is no additionalContext to fold.
    await executeAction(specFor('create_google_doc', { title: 'Notes' }), deps)

    const [, init] = fetchMock.mock.calls[0]
    expect(JSON.parse(init.body)).toEqual({ title: 'Notes', body: '' })
  })
})
