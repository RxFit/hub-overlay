/**
 * Markdown-aware chunker for Obsidian notes (AntigravityHQ vault, Lane 1).
 *
 * lib/chunker.ts is a generic recursive character splitter and is deliberately
 * left untouched: it knows nothing about frontmatter, headings, fences or
 * wikilinks, and a vault note chunked by it loses exactly the structure a
 * harness needs to cite a hit ("which section of which note"). This module
 * exists so every chunk carries:
 *
 *   - `headingPath`  the ATX heading hierarchy in effect where the chunk
 *                    starts ("Hub Overlay > Architecture > Data layer")
 *   - `charStart`/`charEnd`  EXACT offsets into the raw note text, so that
 *                    `raw.slice(charStart, charEnd) === content`. A consumer
 *                    can re-locate an excerpt in the note without trusting
 *                    anything but the offsets.
 *
 * Structural guarantees (all covered by lib/markdown-chunker.test.ts):
 *   - YAML frontmatter is parsed (title / aliases / tags at minimum, plus every
 *     scalar or one-level list/map it can read) and NEVER embedded as chunk
 *     text — it goes on the note row instead.
 *   - Fenced code blocks (``` or ~~~) are atomic: a chunk boundary never falls
 *     inside one, and a `#` line inside a fence is never read as a heading.
 *     The single exception is a fence LONGER THAN THE HARD CAP (the embedding
 *     model's input limit): it is split at line boundaries because it cannot
 *     be embedded whole — and it is flagged (`splitInsideFence`).
 *   - Markdown tables (consecutive `|` lines) are atomic in the same way.
 *   - Wikilinks `[[Note#Heading|alias]]` and block ids `^abc123` are carried
 *     through untouched: the chunker never rewrites text, and boundaries fall
 *     only between paragraphs (or, under the cap, between lines).
 *   - Chunks are ~`targetChars` (default 2500) with ~`overlapChars` (default
 *     500) carried from the tail of the previous chunk on SIZE-driven splits.
 *     A heading of level 1–2 that arrives once a chunk is at least half full
 *     also starts a new chunk (with no overlap: the heading path is the
 *     context there). Small sections merge so a note of short headings does
 *     not explode into one-line chunks.
 *   - No chunk exceeds `maxChars` (default 8000, matching the conservative
 *     input cap in lib/vector-store).
 *
 * The parser is intentionally small (no YAML dependency): Obsidian frontmatter
 * is overwhelmingly flat scalars, inline lists and one-level block lists.
 * Anything it cannot read is kept as the raw string rather than dropped.
 */

export interface MarkdownChunk {
  /** "H1 > H2 > H3" in effect at the chunk start; '' before any heading. */
  headingPath: string
  /** Inclusive start offset into the raw note text. */
  charStart: number
  /** Exclusive end offset into the raw note text. */
  charEnd: number
  /** Exactly `raw.slice(charStart, charEnd)`. */
  content: string
  /** True only when an over-cap fence forced a boundary inside it. */
  splitInsideFence: boolean
}

export interface ParsedFrontmatter {
  /** Every key the parser could read; unreadable values stay raw strings. */
  data: Record<string, unknown>
  title: string | null
  aliases: string[]
  tags: string[]
  /** Offset where the note body starts (0 when there is no frontmatter). */
  bodyStart: number
  /** Whether a well-formed frontmatter block was found. */
  present: boolean
}

export interface ChunkedNote {
  title: string
  frontmatter: ParsedFrontmatter
  bodyStart: number
  chunks: MarkdownChunk[]
}

export interface MarkdownChunkerOptions {
  /** Soft target per chunk (chars). Default 2500. */
  targetChars?: number
  /** Overlap carried into the next chunk on size-driven splits. Default 500. */
  overlapChars?: number
  /** Hard cap per chunk — the embedding model's input limit. Default 8000. */
  maxChars?: number
  /** Vault-relative path; used for the title fallback (basename). */
  path?: string
}

export const DEFAULT_TARGET_CHARS = 2_500
export const DEFAULT_OVERLAP_CHARS = 500
/** Mirrors MAX_EMBEDDING_INPUT_CHARS in lib/vector-store (not exported there). */
export const DEFAULT_MAX_CHARS = 8_000

/* ── Frontmatter ─────────────────────────────────────────────────────────── */

const FM_OPEN = /^﻿?---[ \t]*\r?\n/
const FM_CLOSE = /^(?:---|\.\.\.)[ \t]*$/

/**
 * Parse a leading YAML frontmatter block. Returns `present: false` (and
 * bodyStart 0) when the note has none or the block never closes.
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const none: ParsedFrontmatter = { data: {}, title: null, aliases: [], tags: [], bodyStart: 0, present: false }
  const open = FM_OPEN.exec(raw)
  if (!open) return none

  const lines = raw.split('\n')
  // Line 0 is the opening fence; find the closing one.
  let closeIdx = -1
  for (let i = 1; i < lines.length; i++) {
    if (FM_CLOSE.test(lines[i].replace(/\r$/, ''))) {
      closeIdx = i
      break
    }
  }
  if (closeIdx === -1) return none

  const yamlLines = lines.slice(1, closeIdx).map((l) => l.replace(/\r$/, ''))
  // Body starts after the closing fence line (and its newline, when present).
  let bodyStart = 0
  for (let i = 0; i <= closeIdx; i++) bodyStart += lines[i].length + 1
  if (bodyStart > raw.length) bodyStart = raw.length

  const data = parseYamlBlock(yamlLines)
  return {
    data,
    title: typeof data.title === 'string' && data.title.trim() ? data.title.trim() : null,
    aliases: normalizeList(data.aliases),
    tags: normalizeTags(data.tags),
    bodyStart,
    present: true,
  }
}

const KEY_LINE = /^([A-Za-z0-9_][A-Za-z0-9_\-./ ]*?)\s*:(?:\s+(.*)|\s*)$/
const LIST_LINE = /^\s*-\s*(.*)$/
const NESTED_KEY_LINE = /^\s+([A-Za-z0-9_][A-Za-z0-9_\-./ ]*?)\s*:(?:\s+(.*)|\s*)$/

function parseYamlBlock(lines: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim() || line.trim().startsWith('#')) {
      i++
      continue
    }
    const m = KEY_LINE.exec(line)
    if (!m || /^\s/.test(line)) {
      // Not a top-level key (continuation garbage) — skip rather than fail.
      i++
      continue
    }
    const key = m[1].trim()
    const rawValue = (m[2] ?? '').trim()
    i++

    if (rawValue === '' || rawValue === '|' || rawValue === '>' || rawValue === '|-' || rawValue === '>-') {
      // Block scalar, block list or nested map on the following lines.
      if (rawValue !== '') {
        const block: string[] = []
        while (i < lines.length && (lines[i].trim() === '' || /^\s+/.test(lines[i]))) {
          block.push(lines[i].replace(/^\s{1,2}/, ''))
          i++
        }
        const joined = rawValue.startsWith('|') ? block.join('\n') : block.join(' ')
        out[key] = joined.trim()
        continue
      }
      const items: unknown[] = []
      const nested: Record<string, unknown> = {}
      let sawList = false
      let sawMap = false
      while (i < lines.length) {
        const next = lines[i]
        if (!next.trim()) {
          i++
          continue
        }
        const lm = LIST_LINE.exec(next)
        if (lm && (!sawMap)) {
          items.push(parseScalar(lm[1]))
          sawList = true
          i++
          continue
        }
        const nm = NESTED_KEY_LINE.exec(next)
        if (nm && !sawList) {
          nested[nm[1].trim()] = parseScalar((nm[2] ?? '').trim())
          sawMap = true
          i++
          continue
        }
        break
      }
      out[key] = sawList ? items : sawMap ? nested : null
      continue
    }

    out[key] = parseInlineValue(rawValue)
  }
  return out
}

function parseInlineValue(value: string): unknown {
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim()
    if (!inner) return []
    return splitInlineList(inner).map(parseScalar)
  }
  return parseScalar(value)
}

/** Split `a, "b, c", d` on top-level commas, respecting quotes. */
function splitInlineList(inner: string): string[] {
  const parts: string[] = []
  let cur = ''
  let quote: string | null = null
  for (const ch of inner) {
    if (quote) {
      cur += ch
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
    } else if (ch === ',') {
      parts.push(cur.trim())
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur.trim()) parts.push(cur.trim())
  return parts
}

function parseScalar(value: string): unknown {
  let v = value.trim()
  if (v === '') return ''
  if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2)) {
    return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n')
  }
  if ((v.startsWith("'") && v.endsWith("'") && v.length >= 2)) {
    return v.slice(1, -1).replace(/''/g, "'")
  }
  // YAML comment: ` #` preceded by whitespace (a bare `#tag` value is NOT a comment).
  const hash = v.search(/\s#/)
  if (hash > 0) v = v.slice(0, hash).trim()
  if (v === 'true') return true
  if (v === 'false') return false
  if (v === 'null' || v === '~') return null
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v)
  return v
}

function normalizeList(value: unknown): string[] {
  if (value === null || value === undefined) return []
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean)
  if (typeof value === 'string') return value.split(',').map((s) => s.trim()).filter(Boolean)
  return [String(value)]
}

function normalizeTags(value: unknown): string[] {
  const list = Array.isArray(value) ? value.map((v) => String(v)) : typeof value === 'string' ? [value] : []
  const out: string[] = []
  for (const entry of list) {
    for (const piece of entry.split(/[,\s]+/)) {
      const tag = piece.trim().replace(/^#/, '')
      if (tag && !out.includes(tag)) out.push(tag)
    }
  }
  return out
}

/* ── Body structure ──────────────────────────────────────────────────────── */

type UnitKind = 'heading' | 'fence' | 'table' | 'para'

interface Unit {
  kind: UnitKind
  start: number
  end: number
  /** Heading path in effect AT this unit (including the heading itself). */
  headingPath: string
  /** For headings: level 1–6. */
  level?: number
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/
const TABLE_LINE = /^ {0,3}\|/

interface Line {
  text: string
  start: number
  end: number // exclusive, excludes the '\n'
}

function splitLines(raw: string, from: number): Line[] {
  const out: Line[] = []
  let pos = from
  while (pos <= raw.length) {
    const nl = raw.indexOf('\n', pos)
    const end = nl === -1 ? raw.length : nl
    out.push({ text: raw.slice(pos, end).replace(/\r$/, ''), start: pos, end })
    if (nl === -1) break
    pos = nl + 1
  }
  return out
}

function headingPathOf(stack: Array<{ level: number; text: string }>): string {
  return stack.map((h) => h.text).join(' > ')
}

/**
 * Tokenize the body into atomic units with the heading path in effect.
 * Exported for tests; the chunker builds on it.
 */
export function tokenizeMarkdown(raw: string, bodyStart = 0): Unit[] {
  const lines = splitLines(raw, bodyStart)
  const units: Unit[] = []
  const stack: Array<{ level: number; text: string }> = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.text.trim()) {
      i++
      continue
    }

    const fence = FENCE_OPEN.exec(line.text)
    if (fence) {
      const marker = fence[1]
      const ch = marker[0]
      const closeRe = new RegExp(`^ {0,3}${ch === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`)
      let j = i + 1
      while (j < lines.length && !closeRe.test(lines[j].text)) j++
      const last = j < lines.length ? j : lines.length - 1
      units.push({ kind: 'fence', start: line.start, end: lines[last].end, headingPath: headingPathOf(stack) })
      i = last + 1
      continue
    }

    const heading = HEADING.exec(line.text)
    if (heading) {
      const level = heading[1].length
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop()
      stack.push({ level, text: heading[2].trim() })
      units.push({ kind: 'heading', start: line.start, end: line.end, headingPath: headingPathOf(stack), level })
      i++
      continue
    }

    if (TABLE_LINE.test(line.text)) {
      let j = i
      while (j + 1 < lines.length && TABLE_LINE.test(lines[j + 1].text)) j++
      units.push({ kind: 'table', start: line.start, end: lines[j].end, headingPath: headingPathOf(stack) })
      i = j + 1
      continue
    }

    // Paragraph: consecutive non-blank lines that are not a fence/heading/table
    // start. A trailing `^block-id` line stays attached to its block.
    let j = i
    while (
      j + 1 < lines.length &&
      lines[j + 1].text.trim() &&
      !FENCE_OPEN.test(lines[j + 1].text) &&
      !HEADING.test(lines[j + 1].text) &&
      !TABLE_LINE.test(lines[j + 1].text)
    ) {
      j++
    }
    units.push({ kind: 'para', start: line.start, end: lines[j].end, headingPath: headingPathOf(stack) })
    i = j + 1
  }
  return units
}

/* ── Chunk packing ───────────────────────────────────────────────────────── */

interface Piece {
  start: number
  end: number
  headingPath: string
  kind: UnitKind
  level?: number
  splitInsideFence: boolean
}

/** Split an over-cap unit at line boundaries into pieces ≤ maxChars. */
function splitOversized(raw: string, unit: Unit, maxChars: number): Piece[] {
  const pieces: Piece[] = []
  let cursor = unit.start
  while (cursor < unit.end) {
    let end = Math.min(unit.end, cursor + maxChars)
    if (end < unit.end) {
      const nl = raw.lastIndexOf('\n', end)
      if (nl > cursor) end = nl
    }
    pieces.push({
      start: cursor,
      end,
      headingPath: unit.headingPath,
      kind: unit.kind,
      level: unit.level,
      splitInsideFence: unit.kind === 'fence',
    })
    cursor = end
    // Skip the newline we split on so the next piece starts on a line.
    while (cursor < unit.end && raw[cursor] === '\n') cursor++
  }
  return pieces
}

/**
 * Chunk a full note (frontmatter + body) into provenance-carrying chunks.
 */
export function chunkMarkdownNote(raw: string, options: MarkdownChunkerOptions = {}): ChunkedNote {
  const targetChars = options.targetChars ?? DEFAULT_TARGET_CHARS
  const overlapChars = options.overlapChars ?? DEFAULT_OVERLAP_CHARS
  const maxChars = Math.max(options.maxChars ?? DEFAULT_MAX_CHARS, targetChars)

  const frontmatter = parseFrontmatter(raw)
  const units = tokenizeMarkdown(raw, frontmatter.bodyStart)

  // Flatten units into pieces no larger than the hard cap.
  const pieces: Piece[] = []
  for (const unit of units) {
    if (unit.end - unit.start > maxChars) pieces.push(...splitOversized(raw, unit, maxChars))
    else pieces.push({ start: unit.start, end: unit.end, headingPath: unit.headingPath, kind: unit.kind, level: unit.level, splitInsideFence: false })
  }

  const chunks: MarkdownChunk[] = []
  let current: Piece[] = []

  const sizeOf = (list: Piece[]): number => (list.length ? list[list.length - 1].end - list[0].start : 0)

  const flush = () => {
    if (!current.length) return
    const start = current[0].start
    const end = current[current.length - 1].end
    chunks.push({
      headingPath: current[0].headingPath,
      charStart: start,
      charEnd: end,
      content: raw.slice(start, end),
      splitInsideFence: current.some((p) => p.splitInsideFence),
    })
  }

  /**
   * Trailing pieces (or paragraph tail lines) worth ≤ overlapChars — the
   * overlap carried into the next chunk. Never the WHOLE current chunk (that
   * would nest one chunk inside the next), and never the tail of a fence or
   * table (those stay atomic).
   */
  const overlapTail = (): Piece[] => {
    const lastEnd = current[current.length - 1].end
    const tail: Piece[] = []
    for (let i = current.length - 1; i >= 0; i--) {
      if (lastEnd - current[i].start > overlapChars) break
      tail.unshift(current[i])
    }
    if (tail.length === current.length) return []
    if (tail.length > 0) return tail
    // No whole piece fits: take the last lines of a trailing PARAGRAPH only.
    const last = current[current.length - 1]
    if (last.kind === 'para' && last.end - last.start > overlapChars) {
      const nl = raw.lastIndexOf('\n', last.end - overlapChars)
      if (nl <= last.start) return []
      return [{ ...last, start: nl + 1, splitInsideFence: false }]
    }
    return []
  }

  for (const piece of pieces) {
    if (current.length === 0) {
      current.push(piece)
      continue
    }
    const prospective = piece.end - current[0].start
    const halfFull = sizeOf(current) >= targetChars / 2
    const majorHeading = piece.kind === 'heading' && (piece.level ?? 6) <= 2

    if (majorHeading && halfFull) {
      // Section break: start fresh at the heading, no overlap.
      flush()
      current = [piece]
      continue
    }

    if (prospective <= targetChars) {
      current.push(piece)
      continue
    }

    // Over target. A chunk that is still small keeps growing (up to the hard
    // cap) rather than being emitted as a fragment ahead of a big paragraph.
    if (!halfFull && prospective <= maxChars) {
      current.push(piece)
      continue
    }

    // Size-driven split: carry overlap from the tail, unless the new piece is
    // itself a heading (its path is the context there).
    flush()
    const tail = piece.kind === 'heading' ? [] : overlapTail()
    current = [...tail, piece]
    // A carried tail plus a cap-sized piece can exceed the cap: drop the tail.
    if (piece.end - current[0].start > maxChars) current = [piece]
  }
  flush()

  // A chunk that is ONLY a heading line (e.g. a trailing empty section) carries
  // no retrievable text; merge it away unless it is the sole chunk.
  const filtered = chunks.filter((c, idx) => !(chunks.length > 1 && isBareHeading(c.content) && idx === chunks.length - 1))

  return {
    title: resolveTitle(frontmatter, raw, units, options.path),
    frontmatter,
    bodyStart: frontmatter.bodyStart,
    chunks: filtered,
  }
}

function isBareHeading(text: string): boolean {
  return HEADING.test(text.trim()) && !text.trim().includes('\n')
}

function resolveTitle(fm: ParsedFrontmatter, raw: string, units: Unit[], path?: string): string {
  if (fm.title) return fm.title
  const h1 = units.find((u) => u.kind === 'heading' && u.level === 1)
  if (h1) {
    const m = HEADING.exec(raw.slice(h1.start, h1.end))
    if (m?.[2]?.trim()) return m[2].trim()
  }
  if (path) {
    const base = path.split('/').pop() ?? path
    const stem = base.replace(/\.md$/i, '').trim()
    if (stem) return stem
  }
  return 'Untitled'
}

/**
 * The text actually sent to the embedding model for a chunk: title and heading
 * path as a short context prefix, then the raw chunk. Bounded to `maxChars` so
 * the prefix can never push a cap-sized chunk over the model's input limit.
 */
export function buildEmbeddingInput(noteTitle: string, chunk: Pick<MarkdownChunk, 'headingPath' | 'content'>, maxChars = DEFAULT_MAX_CHARS): string {
  const prefixParts = [noteTitle.trim(), chunk.headingPath.trim()].filter(Boolean)
  const prefix = prefixParts.length ? `${prefixParts.join(' > ')}\n\n` : ''
  const budget = Math.max(0, maxChars - prefix.length)
  const body = chunk.content.length > budget ? chunk.content.slice(0, budget) : chunk.content
  return `${prefix}${body}`
}
