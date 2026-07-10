import { describe, it, expect } from 'vitest'
import { buildChunkDeleteLikePattern } from '@/app/api/webhooks/google/route'

/* ════════════════════════════════════════════════════════════════════════════
   deleteChunksForFile over-deletion guard (P2).

   The Drive webhook cleanup used `LIKE '%<fileId>%'`, which over-deletes:
   Drive fileIds can contain `_` (a single-char LIKE wildcard) and an unanchored
   substring can collide with unrelated URLs. The fix anchors on the
   `/d/<fileId>/` path segment and escapes LIKE metacharacters. These tests lock
   in the pattern shape so a regression to a bare substring match is caught.
   ════════════════════════════════════════════════════════════════════════════ */

describe('buildChunkDeleteLikePattern', () => {
  it('anchors on the /d/<fileId>/ path segment', () => {
    expect(buildChunkDeleteLikePattern('abc123')).toBe('%/d/abc123/%')
  })

  it('escapes an underscore so it is matched literally, not as a wildcard', () => {
    // `_` is a single-char LIKE wildcard; it must be escaped to `\_`.
    expect(buildChunkDeleteLikePattern('file_id')).toBe('%/d/file\\_id/%')
  })

  it('escapes percent and backslash metacharacters', () => {
    expect(buildChunkDeleteLikePattern('a%b\\c')).toBe('%/d/a\\%b\\\\c/%')
  })

  it('does not match a sibling id that shares a prefix (boundary via trailing slash)', () => {
    // The trailing `/` after the id prevents `/d/abc/` from matching `/d/abcdef/`.
    const pattern = buildChunkDeleteLikePattern('abc')
    // Emulate SQL LIKE semantics for a smoke check: convert the pattern to a
    // regex where unescaped % → .* and the literal segments stay literal.
    const toRegex = (p: string) => {
      let out = '^'
      for (let i = 0; i < p.length; i++) {
        const ch = p[i]
        if (ch === '\\') { out += p[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); continue }
        if (ch === '%') { out += '.*'; continue }
        out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      }
      return new RegExp(out + '$')
    }
    const re = toRegex(pattern)
    expect(re.test('https://docs.google.com/document/d/abc/edit')).toBe(true)
    expect(re.test('https://docs.google.com/document/d/abcdef/edit')).toBe(false)
  })

  it('matches an underscore id only against the exact id (no wildcard collision)', () => {
    const pattern = buildChunkDeleteLikePattern('a_c')
    const toRegex = (p: string) => {
      let out = '^'
      for (let i = 0; i < p.length; i++) {
        const ch = p[i]
        if (ch === '\\') { out += p[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); continue }
        if (ch === '%') { out += '.*'; continue }
        out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      }
      return new RegExp(out + '$')
    }
    const re = toRegex(pattern)
    expect(re.test('https://docs.google.com/document/d/a_c/edit')).toBe(true)
    // Would over-match if `_` were treated as a wildcard:
    expect(re.test('https://docs.google.com/document/d/aXc/edit')).toBe(false)
  })
})
