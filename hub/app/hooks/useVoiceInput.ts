'use client'

import { useState, useRef, useEffect, useCallback } from 'react'

/**
 * useVoiceInput — voice-to-text for the chat input via the browser's built-in
 * Web Speech API (SpeechRecognition).
 *
 * Why the Web Speech API and not an LLM call: Anthropic models (including
 * Haiku) accept text/images/PDFs only — the Claude API has no audio input, so
 * there is no server-side "transcribe with Haiku" path. The browser engine is
 * free, requires no API key, transcribes locally/streamed with near-zero
 * latency, and the resulting text flows into the existing chat send path
 * unchanged. Supported in Chrome, Edge, and Safari; Firefox lacks it, so the
 * mic button hides itself there (`isSupported`).
 *
 * Dictation model: when the user taps the mic we snapshot the current input
 * text as the "base", then on every recognition event we rebuild
 * `base + finalized + interim` and push it into the input. Interim words
 * appear live and are replaced as the engine finalizes them.
 */

/** Minimal typings for the Web Speech API (not in lib.dom for all TS configs). */
interface SpeechRecognitionAlternativeLike { transcript: string }
interface SpeechRecognitionResultLike {
  isFinal: boolean
  0: SpeechRecognitionAlternativeLike
  length: number
}
interface SpeechRecognitionResultListLike {
  length: number
  [index: number]: SpeechRecognitionResultLike
}
export interface SpeechRecognitionEventLike {
  results: SpeechRecognitionResultListLike
}
interface SpeechRecognitionErrorEventLike { error: string }
interface SpeechRecognitionLike {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((e: SpeechRecognitionEventLike) => void) | null
  onerror: ((e: SpeechRecognitionErrorEventLike) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}

/**
 * Rebuild the full transcript from a recognition result list: all finalized
 * segments first, then the current interim tail. Pure — unit-tested directly.
 */
export function buildTranscript(results: SpeechRecognitionResultListLike): string {
  let finalText = ''
  let interimText = ''
  for (let i = 0; i < results.length; i++) {
    const segment = results[i][0]?.transcript ?? ''
    if (results[i].isFinal) finalText += segment
    else interimText += segment
  }
  return (finalText + interimText).trim()
}

/**
 * Merge dictated text onto the text that was already in the input when the
 * mic was activated. Pure — unit-tested directly.
 */
export function mergeTranscript(base: string, transcript: string): string {
  if (!transcript) return base
  if (!base) return transcript
  // Single space between the pre-existing text and the dictation.
  return base.replace(/\s+$/, '') + ' ' + transcript
}

/**
 * Map a SpeechRecognition error code onto user-facing copy, or null for
 * benign codes that should not surface (silence, user-initiated abort).
 * Pure — unit-tested directly.
 */
export function resolveVoiceError(code: string): string | null {
  switch (code) {
    case 'no-speech':
    case 'aborted':
      return null
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone access was blocked. Allow microphone access in your browser settings to use voice input.'
    case 'audio-capture':
      return 'No microphone was found. Check that a microphone is connected and try again.'
    case 'network':
      return 'Voice recognition needs a network connection. Check your connection and try again.'
    default:
      return 'Voice input hit a snag. Try again in a moment.'
  }
}

export interface UseVoiceInputOptions {
  /** Read the current input value (snapshotted as the dictation base on start). */
  getInput: () => string
  /** Push the merged base+transcript into the chat input. */
  setInput: (value: string) => void
}

export function useVoiceInput({ getInput, setInput }: UseVoiceInputOptions) {
  const [isListening, setIsListening] = useState(false)
  const [isSupported, setIsSupported] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const baseTextRef = useRef('')
  // Keep the option callbacks fresh without re-creating the recognition session.
  const getInputRef = useRef(getInput)
  const setInputRef = useRef(setInput)
  useEffect(() => { getInputRef.current = getInput }, [getInput])
  useEffect(() => { setInputRef.current = setInput }, [setInput])
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Frame-coalesced transcript flush (freeze fix) ──
  // The browser speech engine fires `onresult` many times per second during
  // continuous dictation (interim results), and some engines (notably iOS
  // Safari) fire in tight bursts. Applying each event synchronously did a full
  // page re-render AND forced a textarea reflow (scrollHeight) PER EVENT, which
  // saturated the main thread and froze the UI mid-dictation. Instead we stash
  // the newest transcript and flush it into the input at most once per animation
  // frame, so a burst of N events collapses to a single re-render + reflow.
  const pendingTranscriptRef = useRef<string | null>(null)
  const rafRef = useRef<number | null>(null)

  const flushTranscript = useCallback(() => {
    // Cancel any queued frame so synchronous callers (stop / onend) don't leave
    // a stale frame pending; harmless when invoked as the rAF callback itself.
    if (rafRef.current !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(rafRef.current)
    }
    rafRef.current = null
    if (pendingTranscriptRef.current !== null) {
      setInputRef.current(mergeTranscript(baseTextRef.current, pendingTranscriptRef.current))
      pendingTranscriptRef.current = null
    }
  }, [])

  // Feature-detect once on mount (guarded — SSR has no window).
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>
    setIsSupported(Boolean(w.SpeechRecognition || w.webkitSpeechRecognition))
  }, [])

  // Cleanup: kill any live session, pending error timer, and queued frame on unmount.
  useEffect(() => {
    return () => {
      recognitionRef.current?.abort()
      recognitionRef.current = null
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current)
      if (rafRef.current !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [])

  const showError = useCallback((message: string) => {
    setError(message)
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current)
    // Auto-dismiss — the banner is transient guidance, not persistent state.
    errorTimerRef.current = setTimeout(() => setError(null), 6000)
  }, [])

  const stop = useCallback(() => {
    // Apply any frame-pending transcript now so the final words land the moment
    // the user stops, not a frame later (and never after the input is cleared).
    flushTranscript()
    recognitionRef.current?.stop()
    // onend fires asynchronously; flip the UI immediately so the button
    // doesn't feel stuck.
    setIsListening(false)
  }, [flushTranscript])

  const start = useCallback(() => {
    const w = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike
      webkitSpeechRecognition?: new () => SpeechRecognitionLike
    }
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition
    if (!Ctor) return

    // Tear down any prior session before starting fresh.
    recognitionRef.current?.abort()
    // Drop any stale pending transcript / queued frame from a prior session.
    if (rafRef.current !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(rafRef.current)
    }
    rafRef.current = null
    pendingTranscriptRef.current = null

    const recognition = new Ctor()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = navigator.language || 'en-US'

    baseTextRef.current = getInputRef.current()

    recognition.onresult = (event) => {
      // Cheap: build the transcript and stash it; the expensive setInput +
      // reflow is deferred to a single per-frame flush so a rapid burst of
      // events can't lock up the main thread (see flushTranscript).
      pendingTranscriptRef.current = buildTranscript(event.results)
      if (typeof requestAnimationFrame !== 'function') {
        flushTranscript() // non-browser env (tests/SSR): apply immediately
      } else if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(flushTranscript)
      }
    }
    recognition.onerror = (event) => {
      const message = resolveVoiceError(event.error)
      if (message) showError(message)
      setIsListening(false)
    }
    recognition.onend = () => {
      // Flush any frame-pending transcript so the last words aren't lost when
      // the engine ends the session on its own.
      flushTranscript()
      setIsListening(false)
      recognitionRef.current = null
    }

    recognitionRef.current = recognition
    setError(null)
    try {
      recognition.start()
      setIsListening(true)
    } catch {
      // start() throws if a session is somehow already active — reset state.
      setIsListening(false)
    }
  }, [showError, flushTranscript])

  const toggle = useCallback(() => {
    if (isListening) stop()
    else start()
  }, [isListening, start, stop])

  return { isListening, isSupported, error, start, stop, toggle }
}
