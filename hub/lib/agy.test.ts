import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

/**
 * lib/agy.ts — the agy execution gateway.
 *
 * node:child_process and the fs layers are mocked (first subprocess-spawning
 * module in the app — this file sets that precedent). The tests lock the
 * gateway's survival rules, which come straight from Phase 0:
 *  - empty output is FAILURE regardless of exit code (the silent non-TTY bug),
 *  - auth fallback text classifies as 'auth' even when JSON parsing would fail,
 *  - the pty runner gets the SSH_* vars and auto-update kill switch,
 *  - the token file is materialized 0600 from AGY_OAUTH_TOKEN but an existing
 *    file is never overwritten,
 *  - prompts are single-quote-escaped through the sh -c boundary,
 *  - the JSON envelope is found inside TUI chrome and read under field aliases.
 */

const { spawnMock, execFileMock, existsSyncMock, mkdirMock, writeFileMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  execFileMock: vi.fn(),
  existsSyncMock: vi.fn(),
  mkdirMock: vi.fn(),
  writeFileMock: vi.fn(),
}))

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  execFile: execFileMock,
}))
vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
}))
vi.mock('node:fs/promises', () => ({
  mkdir: mkdirMock,
  writeFile: writeFileMock,
}))
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))

import {
  agyGenerateText,
  agyVersion,
  agyErrorType,
  agyTokenPath,
  agyTokenSource,
  isAgyConfigured,
  truncateAgyError,
  shQuote,
  stripTui,
  extractJsonEnvelope,
  interpretEnvelope,
} from './agy'

interface FakeChild extends EventEmitter {
  stdout: EventEmitter
  stderr: EventEmitter
  kill: ReturnType<typeof vi.fn>
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = vi.fn()
  return child
}

/** Queue a child that emits `output` then closes with `code` on next tick. */
function nextRunEmits(output: string, code = 0): FakeChild {
  const child = makeFakeChild()
  spawnMock.mockImplementationOnce(() => {
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(output))
      child.emit('close', code)
    })
    return child
  })
  return child
}

const ENVELOPE = JSON.stringify({
  response: 'hello from agy',
  model: 'gemini-3-flash',
  usage: { input_tokens: 120, output_tokens: 8, cache_read_tokens: 96 },
})

beforeEach(() => {
  vi.unstubAllEnvs()
  spawnMock.mockReset()
  execFileMock.mockReset()
  existsSyncMock.mockReset()
  mkdirMock.mockReset().mockResolvedValue(undefined)
  writeFileMock.mockReset().mockResolvedValue(undefined)
  // Default world: binary installed at the standard path, token file present.
  existsSyncMock.mockReturnValue(true)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('configuration probes', () => {
  it('isAgyConfigured is true when only the env token is set', () => {
    existsSyncMock.mockReturnValue(false)
    vi.stubEnv('AGY_OAUTH_TOKEN', '{"refresh_token":"r"}')
    expect(isAgyConfigured()).toBe(true)
    expect(agyTokenSource()).toBe('env')
  })

  it('isAgyConfigured is false with no env token and no file', () => {
    existsSyncMock.mockReturnValue(false)
    expect(isAgyConfigured()).toBe(false)
    expect(agyTokenSource()).toBe('none')
  })

  it('prefers the on-disk file as the token source', () => {
    vi.stubEnv('AGY_OAUTH_TOKEN', '{"refresh_token":"r"}')
    expect(agyTokenSource()).toBe('file')
  })
})

describe('agyGenerateText — happy path', () => {
  it('parses the JSON envelope: text, model, aliased usage fields', async () => {
    nextRunEmits(`\x1b[2J\x1b[1;1H⠋ thinking\r\n${ENVELOPE}\r\n`)
    const result = await agyGenerateText('say hello')
    expect(result.text).toBe('hello from agy')
    expect(result.model).toBe('gemini-3-flash')
    expect(result.usage).toEqual({
      inputTokens: 120,
      outputTokens: 8,
      cacheReadTokens: 96,
      totalTokens: undefined,
    })
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('runs under script -qec with SSH vars and auto-update disabled', async () => {
    nextRunEmits(ENVELOPE)
    await agyGenerateText('probe')
    const [cmd, args, opts] = spawnMock.mock.calls[0]
    expect(cmd).toBe('script')
    expect(args[0]).toBe('-qec')
    expect(args[2]).toBe('/dev/null')
    expect(opts.env.SSH_CONNECTION).toBeTruthy()
    expect(opts.env.SSH_CLIENT).toBeTruthy()
    expect(opts.env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe('true')
  })

  it('passes model and effort flags, single-quote-escaped', async () => {
    nextRunEmits(ENVELOPE)
    await agyGenerateText("it's a prompt", { model: 'gemini-3-pro', effort: 'low' })
    const inner: string = spawnMock.mock.calls[0][1][1]
    expect(inner).toContain(`'it'\\''s a prompt'`)
    expect(inner).toContain(`--model 'gemini-3-pro'`)
    expect(inner).toContain(`--effort 'low'`)
    expect(inner).toContain('--output-format json')
  })

  it('honors AGY_CLI_PATH for binary resolution', async () => {
    vi.stubEnv('AGY_CLI_PATH', '/custom/agy')
    existsSyncMock.mockImplementation((p: string) => p === '/custom/agy' || p === agyTokenPath())
    nextRunEmits(ENVELOPE)
    await agyGenerateText('probe')
    expect(spawnMock.mock.calls[0][1][1]).toContain(`'/custom/agy'`)
  })
})

describe('agyGenerateText — token materialization', () => {
  it('writes the token file 0600 from AGY_OAUTH_TOKEN when absent', async () => {
    vi.stubEnv('AGY_OAUTH_TOKEN', '{"refresh_token":"r"}')
    existsSyncMock.mockImplementation((p: string) => p !== agyTokenPath())
    nextRunEmits(ENVELOPE)
    await agyGenerateText('probe')
    expect(writeFileMock).toHaveBeenCalledWith(agyTokenPath(), '{"refresh_token":"r"}', { mode: 0o600 })
  })

  it('never overwrites an existing token file (agy refreshes it in place)', async () => {
    vi.stubEnv('AGY_OAUTH_TOKEN', '{"refresh_token":"stale"}')
    nextRunEmits(ENVELOPE)
    await agyGenerateText('probe')
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it('throws not_configured with no token anywhere', async () => {
    existsSyncMock.mockImplementation((p: string) => p !== agyTokenPath())
    await expect(agyGenerateText('probe')).rejects.toSatisfy((err: unknown) => agyErrorType(err) === 'not_configured')
  })

  it('throws not_installed when no binary candidate exists', async () => {
    existsSyncMock.mockImplementation((p: string) => p === agyTokenPath())
    await expect(agyGenerateText('probe')).rejects.toSatisfy((err: unknown) => agyErrorType(err) === 'not_installed')
  })
})

describe('agyGenerateText — Phase 0 survival rules', () => {
  it('empty output is failure even with exit code 0 (the silent non-TTY bug)', async () => {
    nextRunEmits('\x1b[2J   \r\n', 0)
    await expect(agyGenerateText('probe')).rejects.toSatisfy((err: unknown) => agyErrorType(err) === 'empty')
  })

  it('auth fallback text classifies as auth, not parse', async () => {
    nextRunEmits('Authentication required. Visit https://example.test to sign in', 1)
    await expect(agyGenerateText('probe')).rejects.toSatisfy((err: unknown) => agyErrorType(err) === 'auth')
  })

  it('non-empty output without a JSON envelope is a parse failure', async () => {
    nextRunEmits('some plain text answer with no envelope', 0)
    await expect(agyGenerateText('probe')).rejects.toSatisfy((err: unknown) => agyErrorType(err) === 'parse')
  })

  it('an envelope with no recognizable text field is a parse failure', async () => {
    nextRunEmits(JSON.stringify({ status: 'done', weird: true }), 0)
    await expect(agyGenerateText('probe')).rejects.toSatisfy((err: unknown) => agyErrorType(err) === 'parse')
  })

  it('kills the run at the hard ceiling and classifies as timeout', async () => {
    vi.useFakeTimers()
    const child = makeFakeChild()
    spawnMock.mockImplementationOnce(() => child)
    const pending = agyGenerateText('probe', { timeoutMs: 30_000 })
    const settled = expect(pending).rejects.toSatisfy((err: unknown) => agyErrorType(err) === 'timeout')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    child.emit('close', null)
    await settled
  })

  it('spawn ENOENT (script binary missing) classifies as spawn', async () => {
    const child = makeFakeChild()
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => child.emit('error', new Error('spawn script ENOENT')))
      return child
    })
    await expect(agyGenerateText('probe')).rejects.toSatisfy((err: unknown) => agyErrorType(err) === 'spawn')
  })
})

describe('agyVersion', () => {
  it('resolves the trimmed version string', async () => {
    execFileMock.mockImplementationOnce(
      (_bin: string, _args: string[], _opts: unknown, cb: (e: Error | null, out: string) => void) =>
        cb(null, '1.1.12\n'),
    )
    await expect(agyVersion()).resolves.toBe('1.1.12')
  })

  it('resolves null when the binary is missing or fails', async () => {
    existsSyncMock.mockReturnValue(false)
    await expect(agyVersion()).resolves.toBeNull()
    execFileMock.mockImplementationOnce(
      (_bin: string, _args: string[], _opts: unknown, cb: (e: Error | null, out: string) => void) =>
        cb(new Error('boom'), ''),
    )
    existsSyncMock.mockReturnValue(true)
    await expect(agyVersion()).resolves.toBeNull()
  })
})

describe('pure helpers', () => {
  it('shQuote survives embedded single quotes', () => {
    expect(shQuote(`a'b`)).toBe(`'a'\\''b'`)
  })

  it('stripTui removes ANSI, OSC, CR, and box glyphs', () => {
    expect(stripTui('\x1b[31mred\x1b[0m │⠋\r\n\x1b]0;title\x07done')).toBe('red \ndone')
  })

  it('extractJsonEnvelope finds JSON despite braces in leading chrome', () => {
    const found = extractJsonEnvelope('spinner {not json\n{"response":"x"}') as { response: string }
    expect(found.response).toBe('x')
  })

  it('extractJsonEnvelope returns undefined when nothing parses', () => {
    expect(extractJsonEnvelope('no json here')).toBeUndefined()
    expect(extractJsonEnvelope('{{{{broken')).toBeUndefined()
  })

  it('interpretEnvelope reads camelCase aliases and nested result objects', () => {
    const out = interpretEnvelope({
      result: { text: 'nested', model: 'm2', usage: { inputTokens: 5, cacheReadTokens: 3 } },
    })
    expect(out.text).toBe('nested')
    expect(out.model).toBe('m2')
    expect(out.usage).toEqual({
      inputTokens: 5,
      outputTokens: undefined,
      cacheReadTokens: 3,
      totalTokens: undefined,
    })
  })

  it('interpretEnvelope omits usage entirely when no counters exist', () => {
    expect(interpretEnvelope({ response: 'x' }).usage).toBeUndefined()
  })

  it('truncateAgyError flattens whitespace and bounds length', () => {
    expect(truncateAgyError(new Error('a\n\n  b'))).toBe('a b')
    expect(truncateAgyError(new Error('x'.repeat(400))).length).toBe(301)
  })
})
