/**
 * Google Chat text markup tokenizer (PURE, client-safe).
 *
 * Chat's `text` field carries the user's formatting literally — and Chat's
 * grammar is NOT markdown: `*bold*` is single-asterisk bold (markdown would
 * read it as italic), `_italic_`, `~strike~`, backtick code spans, triple-
 * backtick blocks, plus two link shapes (`<https://url|label>` app markup and
 * bare `https://…` autolinking). Rendering raw text showed all of it as line
 * noise; piping it through the AI chat's markdown parser would MIS-render it.
 *
 * So: a dedicated tokenizer. It returns typed tokens — never HTML strings —
 * and the renderer maps tokens to React elements, so nothing here can smuggle
 * markup into the DOM. Nesting is not supported (Chat's own formatting model
 * is flat), and unmatched markers pass through as plain text.
 */

export type ChatMarkupToken =
  | { type: 'text'; text: string }
  | { type: 'bold'; text: string }
  | { type: 'italic'; text: string }
  | { type: 'strike'; text: string }
  | { type: 'code'; text: string }
  | { type: 'codeblock'; text: string }
  | { type: 'link'; href: string; text: string }

/** Trailing punctuation a bare URL should not swallow ("see https://x.com."). */
const TRAILING_PUNCT = /[.,;:!?)\]]+$/

/**
 * Inline alternation, ordered by precedence. Marker pairs require a non-word
 * (or start) boundary before the opener so snake_case and 3*4*5 arithmetic
 * stay literal — the same word-boundary rule Chat's own composer applies.
 */
const INLINE = new RegExp(
  [
    /`([^`\n]+)`/.source,                                   // 1: code span
    /(?<=^|[^\w`])\*([^*\n]+)\*(?=$|[^\w])/.source,         // 2: bold
    /(?<=^|[^\w`])_([^_\n]+)_(?=$|[^\w])/.source,           // 3: italic
    /(?<=^|[^\w`])~([^~\n]+)~(?=$|[^\w])/.source,           // 4: strike
    /<(https?:\/\/[^|>\s]+)\|([^>]+)>/.source,              // 5,6: labeled link
    /<(https?:\/\/[^>\s]+)>/.source,                        // 7: bracketed link
    /(https?:\/\/[^\s<>]+)/.source,                         // 8: bare URL
  ].join('|'),
  'g',
)

function pushText(out: ChatMarkupToken[], text: string): void {
  if (!text) return
  const last = out[out.length - 1]
  if (last?.type === 'text') last.text += text
  else out.push({ type: 'text', text })
}

function tokenizeInline(segment: string, out: ChatMarkupToken[]): void {
  let cursor = 0
  INLINE.lastIndex = 0
  for (let m = INLINE.exec(segment); m !== null; m = INLINE.exec(segment)) {
    pushText(out, segment.slice(cursor, m.index))
    cursor = m.index + m[0].length

    if (m[1] !== undefined) out.push({ type: 'code', text: m[1] })
    else if (m[2] !== undefined) out.push({ type: 'bold', text: m[2] })
    else if (m[3] !== undefined) out.push({ type: 'italic', text: m[3] })
    else if (m[4] !== undefined) out.push({ type: 'strike', text: m[4] })
    else if (m[5] !== undefined) out.push({ type: 'link', href: m[5], text: m[6] ?? m[5] })
    else if (m[7] !== undefined) out.push({ type: 'link', href: m[7], text: m[7] })
    else if (m[8] !== undefined) {
      // Give back punctuation the greedy URL match swallowed.
      const trimmed = m[8].replace(TRAILING_PUNCT, '')
      out.push({ type: 'link', href: trimmed, text: trimmed })
      cursor -= m[8].length - trimmed.length
    }
  }
  pushText(out, segment.slice(cursor))
}

export function tokenizeChatMarkup(text: string): ChatMarkupToken[] {
  const out: ChatMarkupToken[] = []
  // Code blocks first — their contents are opaque to every inline rule.
  const parts = text.split(/```/)
  for (let i = 0; i < parts.length; i++) {
    // Odd-indexed parts sit after an opening fence; they are a real block only
    // when a closing fence follows (i.e. this is not the final part).
    const inBlock = i % 2 === 1 && i < parts.length - 1
    if (inBlock) {
      // Chat drops a leading newline after the opening fence; mirror that.
      out.push({ type: 'codeblock', text: parts[i].replace(/^\n/, '').replace(/\n$/, '') })
    } else if (i % 2 === 1) {
      // Unclosed fence — literal backticks back in front of the remainder.
      tokenizeInline('```' + parts[i], out)
    } else {
      tokenizeInline(parts[i], out)
    }
  }
  return out
}
