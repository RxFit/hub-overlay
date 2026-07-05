import { describe, it, expect } from 'vitest'
import { chatErrorBody } from './chat-error'

describe('chatErrorBody', () => {
  it('omits details entirely in production', () => {
    const body = chatErrorBody(new Error('ECONNREFUSED upstream provider'), true)
    expect(body).toEqual({ error: 'Chat request failed' })
    expect('details' in body).toBe(false)
  })

  it('passes the error message through as details outside production', () => {
    expect(chatErrorBody(new Error('boom'), false)).toEqual({
      error: 'Chat request failed',
      details: 'boom',
    })
  })

  it('handles non-Error inputs outside production', () => {
    expect(chatErrorBody('string throw', false)).toEqual({
      error: 'Chat request failed',
      details: 'Unknown error',
    })
    expect(chatErrorBody(undefined, false)).toEqual({
      error: 'Chat request failed',
      details: 'Unknown error',
    })
  })

  it('never leaks non-Error inputs in production either', () => {
    expect(chatErrorBody('secret internal string', true)).toEqual({
      error: 'Chat request failed',
    })
  })
})
