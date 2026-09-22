import { describe, it, expect } from 'vitest'
import { GoogleGenerativeAIError, GoogleGenerativeAIFetchError, type ErrorDetails } from '@google/generative-ai'
import { geminiProviderMessage, geminiReasonCode, parseGeminiError, GEMINI_MESSAGE_MAX } from './gemini-error'

/* The SDK's real error class and message format, so what we parse is what
   production throws (see lib/gemini-error.ts for why the framing matters). */

const URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent'
const DETAILS: ErrorDetails[] = [
  { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com', metadata: { service: 'generativelanguage.googleapis.com' } },
]

function sdkError(status: number, statusText: string, message: string, details?: ErrorDetails[]) {
  const suffix = details ? ` ${JSON.stringify(details)}` : ''
  return new GoogleGenerativeAIFetchError(`Error fetching from ${URL}: [${status} ${statusText}] ${message}${suffix}`, status, statusText, details)
}

describe('parseGeminiError', () => {
  it('reads status, ErrorInfo reason and the bare provider sentence off a 400', () => {
    expect(parseGeminiError(sdkError(400, 'Bad Request', 'API key not valid. Please pass a valid API key.', DETAILS))).toEqual({
      status: 400,
      reason: 'API_KEY_INVALID',
      message: 'API key not valid. Please pass a valid API key.',
    })
  })

  it('a response without details has no reason; a transport failure has no status', () => {
    expect(parseGeminiError(sdkError(503, 'Service Unavailable', 'The model is overloaded.'))).toEqual({ status: 503, reason: null, message: 'The model is overloaded.' })
    expect(parseGeminiError(new GoogleGenerativeAIError(`Error fetching from ${URL}: fetch failed`))).toEqual({ status: null, reason: null, message: 'fetch failed' })
  })

  it('bounds the sentence and survives non-Error input', () => {
    expect(parseGeminiError(sdkError(400, 'Bad Request', 'x'.repeat(1_000))).message).toHaveLength(GEMINI_MESSAGE_MAX)
    expect(parseGeminiError('boom')).toEqual({ status: null, reason: null, message: 'boom' })
    expect(parseGeminiError(undefined)).toEqual({ status: null, reason: null, message: 'undefined' })
  })
})

describe('geminiProviderMessage / geminiReasonCode', () => {
  it('strips the SDK framing and the trailing details JSON, keeping only the provider’s sentence', () => {
    const raw = `[GoogleGenerativeAI Error]: Error fetching from ${URL}: [400 Bad Request] API key not valid. Please pass a valid API key. ${JSON.stringify(DETAILS)}`
    expect(geminiProviderMessage(raw)).toBe('API key not valid. Please pass a valid API key.')
    expect(geminiProviderMessage('plain  message\n here')).toBe('plain message here')
    expect(geminiProviderMessage('')).toBe('')
  })

  it('takes the first reason string and ignores malformed details', () => {
    expect(geminiReasonCode(DETAILS)).toBe('API_KEY_INVALID')
    expect(geminiReasonCode([{ '@type': 'x' }, { reason: 'SERVICE_DISABLED' }])).toBe('SERVICE_DISABLED')
    expect(geminiReasonCode([null, 'junk', { reason: 7 }])).toBeNull()
    expect(geminiReasonCode(undefined)).toBeNull()
    expect(geminiReasonCode({ reason: 'not-an-array' })).toBeNull()
  })
})
