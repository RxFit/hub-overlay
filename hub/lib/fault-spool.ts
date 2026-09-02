import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * The dispatch worker's on-disk fault spool (ERROR_REPORTING §3 Layer 10).
 *
 * THE PROBLEM THIS SOLVES: the worker runs in Docker on the operator's
 * desktop, never on Cloud Run, and speaks to the Hub only over HTTPS. A crash
 * record written to its stderr reaches `docker logs` and nothing else, so the
 * Hub could still only observe a lease expiring — never why. Uploading during
 * the crash is not an option: the process is dying, and an async HTTP call
 * loses the race. So the record is spooled SYNCHRONOUSLY on the crash path and
 * uploaded by the NEXT boot, which is the first moment a network call is safe.
 *
 * DESIGN RULES:
 *  - The append is `appendFileSync` and never throws. It runs inside the
 *    uncaughtExceptionMonitor, where a throw would replace the diagnosis with
 *    noise.
 *  - Bounded twice: each record is capped, and the file stops accepting
 *    appends past MAX_SPOOL_BYTES. A crash loop must never fill the operator's
 *    disk — losing the 51st copy of the same crash costs nothing.
 *  - Draining RENAMES first (atomic on one filesystem), so records appended
 *    while an upload is in flight are not lost to a delete-after-read race.
 *    A failed upload renames back, so the records are retried next boot.
 *
 * RESIDUAL, stated plainly: the spool lives in the container's writable layer,
 * so `docker rm` (as opposed to a restart) discards anything not yet uploaded.
 * Surviving that needs a bind mount, which is an operator change, not a code
 * change — noted in the runbook rather than silently assumed.
 */

/** One line of NDJSON per fault. */
export const MAX_RECORD_BYTES = 16 * 1024
export const MAX_SPOOL_BYTES = 256 * 1024
/** Never upload an unbounded batch — the ingest route caps this too. */
export const MAX_DRAIN_RECORDS = 50

export function spoolPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.FAULT_SPOOL_PATH ?? path.join(os.tmpdir(), 'hub-worker-faults.ndjson')
}

function inFlightPath(env: NodeJS.ProcessEnv = process.env): string {
  return `${spoolPath(env)}.uploading`
}

/**
 * Append one record on the crash path. Synchronous and total: every failure
 * mode (full disk, read-only fs, a serialization cycle) returns false rather
 * than throwing. Returns whether the record was written.
 */
export function appendFaultToSpool(record: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const file = spoolPath(env)
    let line: string
    try {
      line = JSON.stringify(record)
    } catch {
      return false // circular or otherwise unserializable — drop, never throw
    }
    if (!line || line.length > MAX_RECORD_BYTES) return false

    // Stop at the cap rather than rotating: under a crash loop the FIRST
    // records are the diagnostic ones, so preserving the head beats keeping a
    // rolling window of the same repeated failure.
    try {
      if (fs.statSync(file).size >= MAX_SPOOL_BYTES) return false
    } catch {
      /* not created yet — the append below creates it */
    }
    fs.appendFileSync(file, `${line}\n`, { encoding: 'utf8', mode: 0o600 })
    return true
  } catch {
    return false
  }
}

export interface DrainedSpool {
  /** Parsed records, oldest first, capped at MAX_DRAIN_RECORDS. */
  records: unknown[]
  /** True when a spool existed and was claimed for upload. */
  claimed: boolean
  /**
   * Raw lines BEYOND the batch cap, which commitSpool must write back.
   * Without this the cap silently destroys records: the claim renames the
   * whole file aside, so deleting it on success would discard everything
   * past the 50th.
   */
  leftover: string
}

/**
 * Claim the spool for upload: rename it aside, then parse. Renaming is what
 * makes this safe against a concurrent append — a crash landing mid-upload
 * writes to a fresh spool file rather than one about to be deleted.
 */
export function drainSpool(env: NodeJS.ProcessEnv = process.env): DrainedSpool {
  const file = spoolPath(env)
  const inflight = inFlightPath(env)
  try {
    // A leftover in-flight file means a previous boot died mid-upload; those
    // records are still owed, so prefer them over starting a new claim.
    if (!fs.existsSync(inflight)) {
      if (!fs.existsSync(file)) return { records: [], claimed: false, leftover: '' }
      fs.renameSync(file, inflight)
    }
    const raw = fs.readFileSync(inflight, 'utf8')
    const records: unknown[] = []
    const leftoverLines: string[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      if (records.length >= MAX_DRAIN_RECORDS) {
        leftoverLines.push(line) // owed to a later batch, never dropped
        continue
      }
      try {
        records.push(JSON.parse(line))
      } catch {
        /* a torn final line from a crash mid-append — skip it */
      }
    }
    const leftover = leftoverLines.length > 0 ? `${leftoverLines.join('\n')}\n` : ''
    return { records, claimed: true, leftover }
  } catch {
    return { records: [], claimed: false, leftover: '' }
  }
}

/** Write `content` back to the spool AHEAD of anything appended since the
 *  claim, so ordering survives a restore or a partial commit. */
function writeBackAhead(env: NodeJS.ProcessEnv, content: string): void {
  const file = spoolPath(env)
  const newer = (() => {
    try {
      return fs.readFileSync(file, 'utf8')
    } catch {
      return ''
    }
  })()
  fs.writeFileSync(file, content + newer, { encoding: 'utf8', mode: 0o600 })
}

/**
 * Upload succeeded — discard the claimed batch, but write back any records
 * the batch cap left behind. Passing the `leftover` from drainSpool is what
 * keeps the cap a BATCH limit rather than a silent delete.
 */
export function commitSpool(env: NodeJS.ProcessEnv = process.env, leftover = ''): void {
  try {
    if (leftover) writeBackAhead(env, leftover)
    fs.rmSync(inFlightPath(env), { force: true })
  } catch {
    /* best effort */
  }
}

/**
 * Upload failed — put the batch back so the next boot retries it. Appends any
 * records written since the claim, so nothing is lost in either direction.
 */
export function restoreSpool(env: NodeJS.ProcessEnv = process.env): void {
  const file = spoolPath(env)
  const inflight = inFlightPath(env)
  try {
    if (!fs.existsSync(inflight)) return
    if (fs.existsSync(file)) {
      // Both exist: put the claimed batch ahead of the newer records, then
      // drop the in-flight copy.
      writeBackAhead(env, fs.readFileSync(inflight, 'utf8'))
      fs.rmSync(inflight, { force: true })
    } else {
      fs.renameSync(inflight, file)
    }
  } catch {
    /* best effort — the records are already lost to a broken filesystem */
  }
}

/** Test/ops helper: remove both spool files. */
export function clearSpool(env: NodeJS.ProcessEnv = process.env): void {
  try {
    fs.rmSync(spoolPath(env), { force: true })
    fs.rmSync(inFlightPath(env), { force: true })
  } catch {
    /* best effort */
  }
}
