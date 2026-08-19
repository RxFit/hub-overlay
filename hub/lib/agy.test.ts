import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'

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

const { spawnMock, execFileMock, existsSyncMock, readFileSyncMock, statSyncMock, mkdirMock, writeFileMock, chmodMock, rmMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  execFileMock: vi.fn(),
  existsSyncMock: vi.fn(),
  readFileSyncMock: vi.fn(),
  statSyncMock: vi.fn(),
  mkdirMock: vi.fn(),
  writeFileMock: vi.fn(),
  chmodMock: vi.fn(),
  rmMock: vi.fn(),
}))

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  execFile: execFileMock,
}))
vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  statSync: statSyncMock,
}))
vi.mock('node:fs/promises', () => ({
  mkdir: mkdirMock,
  writeFile: writeFileMock,
  chmod: chmodMock,
  rm: rmMock,
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
  __resetAgyInstallForTest,
  credentialFingerprint,
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
  vi.unstubAllGlobals()
  __resetAgyInstallForTest()
  spawnMock.mockReset()
  execFileMock.mockReset()
  existsSyncMock.mockReset()
  readFileSyncMock.mockReset().mockReturnValue('{"refresh_token":"on-disk"}')
  statSyncMock.mockReset().mockReturnValue({ mtime: new Date('2026-08-15T00:00:00Z') })
  mkdirMock.mockReset().mockResolvedValue(undefined)
  writeFileMock.mockReset().mockResolvedValue(undefined)
  chmodMock.mockReset().mockResolvedValue(undefined)
  rmMock.mockReset().mockResolvedValue(undefined)
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

})

describe('agyGenerateText — runtime binary install (no binary on disk)', () => {
  const payload = Buffer.from('fake-agy-binary')
  const goodManifest = {
    version: '9.9.9',
    url: 'https://releases.example/agy',
    sha512: createHash('sha512').update(payload).digest('hex'),
  }

  function jsonResponse(body: unknown): Response {
    return { ok: true, json: async () => body } as unknown as Response
  }
  function binResponse(buf: Buffer): Response {
    return { ok: true, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) } as unknown as Response
  }

  beforeEach(() => {
    // Token file exists; NO binary anywhere → forces the install path.
    existsSyncMock.mockImplementation((p: string) => p === agyTokenPath())
  })

  it('downloads, sha512-verifies, installs 0755, and runs from the installed path', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(goodManifest))
      .mockResolvedValueOnce(binResponse(payload))
    vi.stubGlobal('fetch', fetchMock)
    nextRunEmits(ENVELOPE)

    const result = await agyGenerateText('probe')
    expect(result.text).toBe('hello from agy')
    expect(fetchMock.mock.calls[0][0]).toContain('/manifests/linux_')
    const installedPath = writeFileMock.mock.calls[0][0] as string
    expect(installedPath).toContain('agy-cli')
    expect(chmodMock).toHaveBeenCalledWith(installedPath, 0o755)
    expect(spawnMock.mock.calls[0][1][1]).toContain(installedPath)
  })

  it('classifies a manifest fetch failure as install', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    await expect(agyGenerateText('probe')).rejects.toSatisfy((err: unknown) => agyErrorType(err) === 'install')
  })

  it('refuses a payload whose sha512 does not match the manifest', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ...goodManifest, sha512: 'f'.repeat(128) }))
      .mockResolvedValueOnce(binResponse(payload))
    vi.stubGlobal('fetch', fetchMock)
    await expect(agyGenerateText('probe')).rejects.toSatisfy((err: unknown) => agyErrorType(err) === 'install')
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it('a failed install is retried on the next call (memo cleared)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('flake')))
    await expect(agyGenerateText('probe')).rejects.toSatisfy((err: unknown) => agyErrorType(err) === 'install')
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(goodManifest))
      .mockResolvedValueOnce(binResponse(payload))
    vi.stubGlobal('fetch', fetchMock)
    nextRunEmits(ENVELOPE)
    await expect(agyGenerateText('probe')).resolves.toMatchObject({ text: 'hello from agy' })
  })
})

/**
 * The real release server hands back a .tar.gz (verified against
 * antigravity-cli-auto-updater: one member, literally `antigravity`), so this
 * is the branch that actually runs in production — the tests above exercise
 * the bare-binary branch. The staging archive is ~55MB and /tmp is tmpfs on
 * Cloud Run, so "was it deleted" is a memory-budget assertion, not tidiness.
 */
describe('agyGenerateText — runtime install from a .tar.gz release (the production path)', () => {
  const payload = Buffer.from('fake-agy-tarball')
  const tarManifest = {
    version: '1.1.13',
    url: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.1.13/linux-x64/cli_linux_x64.tar.gz',
    sha512: createHash('sha512').update(payload).digest('hex'),
  }

  /** Resolve execFile by invoking its trailing callback (tar, then mv). */
  function execFileSucceeds() {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1]
      if (typeof cb === 'function') queueMicrotask(() => (cb as (e: Error | null) => void)(null))
    })
  }

  beforeEach(() => {
    existsSyncMock.mockImplementation((p: string) => p === agyTokenPath())
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => tarManifest } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: async () => payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength),
        } as unknown as Response),
    )
  })

  it('extracts, installs 0755, and deletes the staging archive', async () => {
    execFileSucceeds()
    nextRunEmits(ENVELOPE)

    await expect(agyGenerateText('probe')).resolves.toMatchObject({ text: 'hello from agy' })

    const staging = writeFileMock.mock.calls[0][0] as string
    expect(staging).toMatch(/agy\.tar\.gz$/)
    expect(execFileMock.mock.calls[0][0]).toBe('tar')
    expect(execFileMock.mock.calls[0][1]).toEqual(expect.arrayContaining(['-xzf', staging, 'antigravity']))
    expect(execFileMock.mock.calls[1][0]).toBe('mv')
    expect(chmodMock).toHaveBeenCalledWith(expect.stringMatching(/agy$/), 0o755)
    expect(rmMock).toHaveBeenCalledWith(staging, { force: true })
  })

  it('deletes the staging archive even when extraction fails', async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1]
      if (typeof cb === 'function') {
        queueMicrotask(() => (cb as (e: Error | null) => void)(new Error('tar: unexpected EOF')))
      }
    })

    await expect(agyGenerateText('probe')).rejects.toSatisfy((err: unknown) => agyErrorType(err) === 'install')
    expect(rmMock).toHaveBeenCalledWith(expect.stringMatching(/agy\.tar\.gz$/), { force: true })
  })
})

describe('agyGenerateText — Phase 0 survival rules', () => {
  it('empty output is failure even with exit code 0 (the silent non-TTY bug)', async () => {
    nextRunEmits('\x1b[2J   \r\n', 0)
    await expect(agyGenerateText('probe')).rejects.toSatisfy((err: unknown) => agyErrorType(err) === 'empty')
  })

  it("upstream's newer auth text ('authentication failed or timed out') classifies as auth", async () => {
    nextRunEmits('Error: authentication failed or timed out\nPlease sign in to Antigravity', 1)
    await expect(agyGenerateText('probe')).rejects.toSatisfy((err: unknown) => agyErrorType(err) === 'auth')
  })

  it('a SUCCESSFUL answer that merely discusses auth failures is NOT misclassified as auth', async () => {
    nextRunEmits(
      JSON.stringify({
        response: 'Your Gmail sync shows authentication failed because the refresh token expired. Authentication required means the OAuth grant was revoked.',
        model: 'gemini-3-flash',
      }),
    )
    const result = await agyGenerateText('why does my gmail sync say authentication failed?')
    expect(result.text).toContain('authentication failed')
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

  it('a timeout whose output shows the OAuth fallback classifies as auth, keeping the evidence', async () => {
    // stdin is EOF under the pty, so a dead token BLOCKS at agy's interactive
    // prompt until the ceiling — filing that as 'timeout' would call a
    // permanent auth failure transient and discard the proof.
    vi.useFakeTimers()
    const child = makeFakeChild()
    spawnMock.mockImplementationOnce(() => {
      // Emit once the pty runner has actually attached its listeners — the
      // token/binary awaits run before spawn, so emitting earlier is lost.
      queueMicrotask(() => child.stdout.emit('data', Buffer.from('Authentication required. Opening browser…')))
      return child
    })
    const pending = agyGenerateText('probe', { timeoutMs: 30_000 })
    const settled = expect(pending).rejects.toSatisfy((err: unknown) => agyErrorType(err) === 'auth')
    await vi.advanceTimersByTimeAsync(30_000)
    child.emit('close', null)
    await settled
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

  it('an abort signal SIGTERMs the child and classifies as abort (Phase 2.5 cancel)', async () => {
    const controller = new AbortController()
    const child = makeFakeChild()
    spawnMock.mockImplementationOnce(() => child)
    const pending = agyGenerateText('probe', { timeoutMs: 60_000, signal: controller.signal })
    // spawn happens only after the async ensureTokenFile/ensureBinary resolve.
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    controller.abort()
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith('SIGTERM'))
    child.emit('close', null)
    await expect(pending).rejects.toSatisfy((err: unknown) => agyErrorType(err) === 'abort')
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

describe('credential fingerprinting (proving WHICH token an instance holds)', () => {
  it('fingerprints identical bytes identically and different bytes differently', () => {
    const a = credentialFingerprint('{"refresh_token":"abc"}')
    expect(a).toEqual({ sha256: expect.stringMatching(/^[0-9a-f]{12}$/), bytes: 23 })
    expect(credentialFingerprint('{"refresh_token":"abc"}')).toEqual(a)
    expect(credentialFingerprint('{"refresh_token":"xyz"}')!.sha256).not.toBe(a!.sha256)
    expect(credentialFingerprint(null)).toBeNull()
  })

  it('never leaks the credential itself', () => {
    const secret = '{"refresh_token":"SUPER-SECRET-VALUE"}'
    expect(JSON.stringify(credentialFingerprint(secret))).not.toContain('SUPER-SECRET')
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
