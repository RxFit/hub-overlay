#!/usr/bin/env node
/**
 * Build-time installer for the Antigravity CLI (agy) — Dockerfile layer.
 *
 * Replicates the official install.sh (manifest → download → sha512 verify)
 * without needing curl in node:22-slim: Node's global fetch does the network
 * work and node:crypto verifies the checksum. Refuses to install anything
 * whose hash does not match the manifest.
 *
 * Usage: node scripts/install-agy.mjs [/usr/local/bin/agy]
 *
 * The download server pins "latest" only — there is no version pinning
 * upstream, so image builds track the current release. The runtime sets
 * AGY_CLI_DISABLE_AUTO_UPDATE=true (Dockerfile) so the binary at least never
 * changes underneath a running container.
 */
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DOWNLOAD_BASE_URL = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app'
const target = process.argv[2] ?? '/usr/local/bin/agy'

const archMap = { x64: 'amd64', arm64: 'arm64' }
const arch = archMap[process.arch]
if (!arch || process.platform !== 'linux') {
  console.error(`[install-agy] unsupported platform: ${process.platform}/${process.arch}`)
  process.exit(1)
}
const platform = `linux_${arch}` // node:22-slim is glibc (bookworm), never musl

const manifestRes = await fetch(`${DOWNLOAD_BASE_URL}/manifests/${platform}.json`)
if (!manifestRes.ok) {
  console.error(`[install-agy] manifest fetch failed: HTTP ${manifestRes.status}`)
  process.exit(1)
}
const { version, url, sha512 } = await manifestRes.json()
if (!url || !sha512) {
  console.error('[install-agy] manifest missing url/sha512')
  process.exit(1)
}
console.log(`[install-agy] installing agy ${version} (${platform})`)

const payloadRes = await fetch(url)
if (!payloadRes.ok) {
  console.error(`[install-agy] download failed: HTTP ${payloadRes.status}`)
  process.exit(1)
}
const payload = Buffer.from(await payloadRes.arrayBuffer())

const actual = createHash('sha512').update(payload).digest('hex')
if (actual !== sha512) {
  console.error('[install-agy] SECURITY HALT: sha512 mismatch — refusing to install')
  process.exit(1)
}

mkdirSync(dirname(target), { recursive: true })
if (/\.tar\.gz(\?|$)/.test(url)) {
  const staging = join(tmpdir(), 'agy.tar.gz')
  writeFileSync(staging, payload)
  execFileSync('tar', ['-xzf', staging, '-C', tmpdir(), 'antigravity'])
  execFileSync('cp', [join(tmpdir(), 'antigravity'), target])
} else {
  writeFileSync(target, payload)
}
chmodSync(target, 0o755)

const installed = execFileSync(target, ['--version'], { encoding: 'utf8' }).trim()
console.log(`[install-agy] installed ${installed} at ${target}`)
