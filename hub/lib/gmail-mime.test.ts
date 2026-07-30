import { describe, it, expect } from 'vitest'
import {
  stripHeader,
  extractEmailAddress,
  parseRecipientList,
  buildMimeMessage,
  toGmailRaw,
  encodeMimeMessage,
} from './gmail-mime'

/**
 * This logic was inline in the send route and untested, which is a poor
 * combination for code whose job is partly to stop header injection. These
 * tests exist mostly to pin the security properties.
 */

const decode = (raw: string) =>
  Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()

describe('stripHeader', () => {
  it('removes CR/LF so a value cannot introduce a new header', () => {
    expect(stripHeader('Hello\r\nBcc: attacker@evil.com')).toBe('Hello Bcc: attacker@evil.com')
  })

  it('handles a bare LF and a bare CR', () => {
    expect(stripHeader('a\nb')).toBe('a b')
    expect(stripHeader('a\rb')).toBe('a b')
  })

  it('collapses a run of newlines into ONE space rather than deleting them', () => {
    // Replacing with a space keeps the corruption visible; deleting would
    // silently splice "Subject" onto "Bcc:".
    expect(stripHeader('a\r\n\r\n\r\nb')).toBe('a b')
  })

  it('trims and tolerates null/undefined', () => {
    expect(stripHeader('  x  ')).toBe('x')
    expect(stripHeader(undefined)).toBe('')
    expect(stripHeader(null)).toBe('')
  })
})

describe('extractEmailAddress', () => {
  it('pulls the address out of a display-name form', () => {
    expect(extractEmailAddress('Maria Lopez <maria@rxfitatx.com>')).toBe('maria@rxfitatx.com')
  })

  it('passes a bare address through', () => {
    expect(extractEmailAddress('  maria@rxfitatx.com ')).toBe('maria@rxfitatx.com')
  })
})

describe('parseRecipientList', () => {
  it('accepts a single address', () => {
    expect(parseRecipientList('maria@rxfitatx.com')).toMatchObject({
      ok: true,
      value: 'maria@rxfitatx.com',
    })
  })

  it('accepts a comma-separated list and normalizes display names away', () => {
    const out = parseRecipientList('Maria <maria@x.com>, sam@y.com')
    expect(out.ok).toBe(true)
    expect(out.value).toBe('maria@x.com, sam@y.com')
  })

  it('REJECTS the whole list when any address is malformed', () => {
    // Dropping the bad one silently would send to fewer people than the user
    // approved, with no indication.
    const out = parseRecipientList('good@x.com, not-an-email')
    expect(out.ok).toBe(false)
    expect(out.invalid).toEqual(['not-an-email'])
  })

  it('rejects an empty list', () => {
    expect(parseRecipientList('').ok).toBe(false)
    expect(parseRecipientList('   ').ok).toBe(false)
  })

  it('rejects a CR/LF injection attempt in the recipient', () => {
    // Stripped to a space first, which then fails address validation — the
    // request never reaches Gmail.
    expect(parseRecipientList('a@b.com\r\nBcc: attacker@evil.com').ok).toBe(false)
  })

  it('fails closed on a quoted display name containing a comma', () => {
    // Splitting on the comma breaks it apart; not supported, and the safe
    // direction is to refuse rather than guess.
    expect(parseRecipientList('"Lopez, Maria" <m@x.com>').ok).toBe(false)
  })
})

describe('buildMimeMessage', () => {
  const base = {
    from: 'danny@rxfitatx.com',
    to: 'maria@rxfitatx.com',
    subject: 'Invoice',
    body: 'Line one\nLine two',
  }

  it('emits the standard headers, then a blank line, then the body', () => {
    const mime = buildMimeMessage(base)
    const [headers, body] = mime.split('\r\n\r\n')
    expect(headers).toContain('From: danny@rxfitatx.com')
    expect(headers).toContain('To: maria@rxfitatx.com')
    expect(headers).toContain('Subject: Invoice')
    expect(headers).toContain('Content-Type: text/plain; charset=UTF-8')
    expect(body).toBe('Line one\nLine two')
  })

  it('uses CRLF line endings between headers, as RFC 2822 requires', () => {
    expect(buildMimeMessage(base)).toContain('From: danny@rxfitatx.com\r\nTo:')
  })

  it('PRESERVES newlines in the body — they are content, not headers', () => {
    expect(buildMimeMessage(base)).toContain('Line one\nLine two')
  })

  it('sets both In-Reply-To and References when replying', () => {
    const mime = buildMimeMessage({ ...base, inReplyTo: '<abc@mail.gmail.com>' })
    expect(mime).toContain('In-Reply-To: <abc@mail.gmail.com>')
    expect(mime).toContain('References: <abc@mail.gmail.com>')
  })

  it('omits both threading headers when not replying', () => {
    const mime = buildMimeMessage(base)
    expect(mime).not.toContain('In-Reply-To')
    expect(mime).not.toContain('References')
  })

  it('neutralizes an injected header in the SUBJECT', () => {
    const mime = buildMimeMessage({ ...base, subject: 'Hi\r\nBcc: attacker@evil.com' })
    expect(mime).not.toMatch(/^Bcc:/m)
    expect(mime).toContain('Subject: Hi Bcc: attacker@evil.com')
  })

  it('neutralizes an injected header in the FROM and TO', () => {
    const mime = buildMimeMessage({
      ...base,
      from: 'a@b.com\r\nBcc: x@evil.com',
      to: 'c@d.com\r\nCc: y@evil.com',
    })
    expect(mime).not.toMatch(/^Bcc:/m)
    expect(mime).not.toMatch(/^Cc:/m)
  })

  it('neutralizes an injected header in inReplyTo', () => {
    const mime = buildMimeMessage({ ...base, inReplyTo: '<a@b>\r\nBcc: x@evil.com' })
    expect(mime).not.toMatch(/^Bcc:/m)
  })

  it('a body containing header-like lines cannot add headers — it is past the separator', () => {
    const mime = buildMimeMessage({ ...base, body: 'Bcc: attacker@evil.com\nreal text' })
    const [headers] = mime.split('\r\n\r\n')
    expect(headers).not.toContain('Bcc:')
  })
})

describe('toGmailRaw', () => {
  it('produces base64url with no padding — Gmail 400s on standard base64', () => {
    const raw = toGmailRaw('any string that encodes with padding??')
    expect(raw).not.toContain('+')
    expect(raw).not.toContain('/')
    expect(raw).not.toContain('=')
  })

  it('round-trips back to the original text', () => {
    const mime = 'Subject: Test\r\n\r\nBody'
    expect(decode(toGmailRaw(mime))).toBe(mime)
  })

  it('handles non-ASCII content', () => {
    const mime = 'Subject: Café\r\n\r\nnaïve — résumé'
    expect(decode(toGmailRaw(mime))).toBe(mime)
  })
})

describe('encodeMimeMessage', () => {
  it('builds and encodes in one step, decodable back to the message', () => {
    const raw = encodeMimeMessage({
      from: 'a@b.com',
      to: 'c@d.com',
      subject: 'Hello',
      body: 'World',
    })
    const decoded = decode(raw)
    expect(decoded).toContain('From: a@b.com')
    expect(decoded).toContain('Subject: Hello')
    expect(decoded.endsWith('World')).toBe(true)
  })
})
