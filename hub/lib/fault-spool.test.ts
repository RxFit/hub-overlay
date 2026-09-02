import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  appendFaultToSpool,
  drainSpool,
  commitSpool,
  restoreSpool,
  clearSpool,
  spoolPath,
  MAX_SPOOL_BYTES,
  MAX_RECORD_BYTES,
  MAX_DRAIN_RECORDS,
} from './fault-spool'

/* ════════════════════════════════════════════════════════════════════════════
   The worker's crash spool (§3 Layer 10). The properties that matter: it is
   written from a dying process (so it must be total and bounded) and drained
   from a live one (so the claim must survive a concurrent append).
   ════════════════════════════════════════════════════════════════════════════ */

let dir: string
let env: NodeJS.ProcessEnv

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spool-test-'))
  env = { ...process.env, FAULT_SPOOL_PATH: path.join(dir, 'faults.ndjson') }
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const rec = (id: string) => ({ fault: { faultId: id }, origin: 'uncaughtException' })

describe('appending on the crash path', () => {
  it('writes NDJSON that drains back in order', () => {
    expect(appendFaultToSpool(rec('A'), env)).toBe(true)
    expect(appendFaultToSpool(rec('B'), env)).toBe(true)
    const { records, claimed } = drainSpool(env)
    expect(claimed).toBe(true)
    expect(records.map((r: any) => r.fault.faultId)).toEqual(['A', 'B'])
  })

  it('refuses an oversized record rather than writing a partial line', () => {
    const huge = { fault: { faultId: 'X', message: 'x'.repeat(MAX_RECORD_BYTES + 10) } }
    expect(appendFaultToSpool(huge, env)).toBe(false)
    expect(fs.existsSync(spoolPath(env))).toBe(false)
  })

  it('stops at the size cap — a crash loop must not fill the operator disk', () => {
    const filler = { fault: { faultId: 'F', message: 'y'.repeat(4_000) } }
    let written = 0
    for (let i = 0; i < 500; i++) if (appendFaultToSpool(filler, env)) written++
    expect(written).toBeGreaterThan(0)
    expect(fs.statSync(spoolPath(env)).size).toBeLessThanOrEqual(MAX_SPOOL_BYTES + MAX_RECORD_BYTES)
    // and it stopped early rather than writing all 500
    expect(written).toBeLessThan(500)
  })

  it('never throws on an unserializable record or an unwritable path', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => appendFaultToSpool(circular, env)).not.toThrow()
    expect(appendFaultToSpool(circular, env)).toBe(false)

    const bad = { ...process.env, FAULT_SPOOL_PATH: '/proc/definitely/not/writable/x.ndjson' }
    expect(() => appendFaultToSpool(rec('A'), bad)).not.toThrow()
    expect(appendFaultToSpool(rec('A'), bad)).toBe(false)
  })

  it('skips a torn final line from a crash mid-append', () => {
    appendFaultToSpool(rec('A'), env)
    fs.appendFileSync(spoolPath(env), '{"fault":{"faultId":"TOR')
    const { records } = drainSpool(env)
    expect(records.map((r: any) => r.fault.faultId)).toEqual(['A'])
  })

  it('caps how many records one drain will claim', () => {
    for (let i = 0; i < MAX_DRAIN_RECORDS + 10; i++) appendFaultToSpool(rec(`R${i}`), env)
    expect(drainSpool(env).records).toHaveLength(MAX_DRAIN_RECORDS)
  })
})

describe('claim / commit / restore', () => {
  it('drain claims by renaming, so a concurrent crash writes to a fresh spool', () => {
    appendFaultToSpool(rec('OLD'), env)
    const { records } = drainSpool(env)
    expect(records).toHaveLength(1)
    // The original path is now free; a crash landing mid-upload lands here.
    expect(fs.existsSync(spoolPath(env))).toBe(false)
    appendFaultToSpool(rec('DURING'), env)
    expect(fs.existsSync(spoolPath(env))).toBe(true)

    // Commit discards ONLY the claimed batch — the concurrent record survives.
    commitSpool(env)
    expect(drainSpool(env).records.map((r: any) => r.fault.faultId)).toEqual(['DURING'])
  })

  it('restore puts a failed batch back AHEAD of records written since', () => {
    appendFaultToSpool(rec('OLD'), env)
    drainSpool(env)
    appendFaultToSpool(rec('DURING'), env)
    restoreSpool(env)
    expect(drainSpool(env).records.map((r: any) => r.fault.faultId)).toEqual(['OLD', 'DURING'])
  })

  it('a leftover in-flight file from a boot that died mid-upload is retried, not lost', () => {
    appendFaultToSpool(rec('OWED'), env)
    drainSpool(env) // claimed, then "the process died" — no commit, no restore
    const again = drainSpool(env)
    expect(again.claimed).toBe(true)
    expect(again.records.map((r: any) => r.fault.faultId)).toEqual(['OWED'])
  })

  it('commit PRESERVES records beyond the batch cap — the cap is a batch limit, not a delete', () => {
    const total = MAX_DRAIN_RECORDS + 12
    for (let i = 0; i < total; i++) appendFaultToSpool(rec(`R${i}`), env)

    const first = drainSpool(env)
    expect(first.records).toHaveLength(MAX_DRAIN_RECORDS)
    expect(first.leftover).not.toBe('')

    // Committing the claimed batch must NOT discard the remainder: the claim
    // renamed the WHOLE file aside, so a plain delete would destroy them.
    commitSpool(env, first.leftover)

    const second = drainSpool(env)
    expect(second.records).toHaveLength(12)
    expect((second.records[0] as any).fault.faultId).toBe(`R${MAX_DRAIN_RECORDS}`)
    commitSpool(env, second.leftover)
    expect(drainSpool(env).claimed).toBe(false)
  })

  it('reports nothing to do when no spool exists', () => {
    expect(drainSpool(env)).toEqual({ records: [], claimed: false, leftover: '' })
  })

  it('clearSpool removes both files', () => {
    appendFaultToSpool(rec('A'), env)
    drainSpool(env)
    appendFaultToSpool(rec('B'), env)
    clearSpool(env)
    expect(drainSpool(env).claimed).toBe(false)
  })
})
