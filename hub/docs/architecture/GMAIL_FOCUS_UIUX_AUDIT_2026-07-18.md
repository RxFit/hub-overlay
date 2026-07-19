# UI/UX Audit — Gmail View + AI Focus Strip

**Date:** 2026-07-18 · **Scope:** Gmail tab of the hub overlay (inbox list, Focus strip, thread view, compose/reply) as of PR #112 (`b1c3d48`) · **Method:** code-level heuristic audit of the final build, evaluated against the adversarially-verified deep-research baselines (Apple HIG, Material 3, PatternFly/SAP Fiori master-detail guidance, Close.com email-rendering pattern) plus WCAG touch/typography floors. No live-device screenshot pass was possible in this environment (the app requires an authenticated Google session); findings are from the rendered CSS/DOM structure.

---

## 1. Defects found and fixed during the audit (shipped in commit `b1c3d48`)

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 1 | Medium | **Sub-12px interface text.** Focus action chip rendered at 10.9px (0.68rem); list/thread dates at 11.5px (0.72rem). The verified research baseline sets ~12px as the interface-text floor. | All raised to 0.75rem (12px). |
| 2 | Medium | **Primary list text under platform convention.** Sender names rendered at 14.7px (0.92rem); the iOS/Material baseline for primary list text is ~16–17px. | Raised to 1rem (16px); focus-card sender to 0.9rem. |
| 3 | Medium (a11y) | **ARIA misuse on the Focus rail.** `role="listitem"` was set directly on the card `<button>`s — a listitem role *overrides* the implicit button role, so assistive tech would announce the cards as plain list items, not actionable buttons. | Roles removed; the rail is a set of real buttons inside an `aria-label`led `<section>`, which is the correct semantics. |

## 2. What passes (verified against the research baselines)

- **Single-pane master-detail on mobile** — the list owns the full viewport width; opening a thread swaps to a full-screen detail view with a persistent header and a 44px back target; desktop (>640px) gets the fixed-list + flexing-detail split. Matches the unanimous PatternFly/Microsoft/Fiori/Material guidance.
- **Typography hierarchy by weight and color, not size** — unread rows use weight 700 + primary color against 400 + muted; consistent with the iOS convention of differentiating list text by weight/color at constant size.
- **Touch targets** — list rows (~70px), focus cards (min 44px + padding), back button (44×44px), compose button (~40px full-width) all meet or exceed the 44pt floor.
- **No iOS focus-zoom** — all compose/reply inputs are 16px, at the Safari zoom threshold.
- **Email body rendering** — sanitized HTML wrapped in a document with viewport meta, system-font base typography, `img/table max-width:100%`, `<base target="_blank">`; iframe auto-resizes so the pane scrolls, not the iframe (the Close.com production pattern).
- **Dark mode** — chrome is dark; email bodies render as authored on white. This is Gmail-web behavior and the verified safe default (auto-inversion breaks transparent PNGs/brand colors).
- **Focus strip trust boundary** — sender names and subjects on the cards come from the live Gmail thread list, never from model output, so the model cannot hallucinate a sender or subject into the UI; only the ≤120-char, control-stripped *reason* string is model-authored. Thread ids are validated against the inbox set (the model cannot point a card at a foreign thread).
- **Graceful degradation** — a ranking failure hides the strip entirely (fail-open, `degraded: true`); the inbox never blocks on AI. Cache-by-inbox-signature keeps the poll from becoming a model call per poll.
- **Horizontal rail affordance** — cards are `min(78vw, 260px)` wide, so on a phone the next card visibly peeks in from the right edge (the standard cue that the rail scrolls); scroll-snap keeps cards aligned; scrollbars are hidden on the rail only.

## 3. Open recommendations (not shipped — ranked)

1. **Move the split-pane breakpoint from 640px to 768px.** The verified research places two-pane layouts at ≥768px (PatternFly ~2× mobile width) or ≥840dp (Material). Between 641–767px (large phones landscape, small tablets) we currently show a cramped split. This should change together with `GoogleChatPanel`, which shares the 640px system — a one-line change in two media queries, but a cross-cutting visual change worth its own small PR.
2. **Surface `gmail_focus_rank` properly in the Activity feed.** `aiActionToFeedItem` has no case for the new action type, so ranking rows render as the generic "AI performed an action." Add a case ("AI prioritized your inbox") or filter them from the feed.
3. **Add a dismiss affordance to Focus cards.** There's no "not important" action, so a mis-ranked card persists until the cache expires. A per-thread dismiss (client-side is enough initially) is the smallest feedback loop; longer term, dismissals could feed the prompt.
4. **Skeleton row for the Focus strip.** The strip appears only when data arrives, shifting the list down. A one-row shimmer (matching the existing list skeleton style) would reserve the space during the first load.
5. **Consider the stricter Close-style iframe sandbox.** We run `allow-scripts` (for the resize reporter) without `allow-same-origin`; Close runs `allow-same-origin` without `allow-scripts` and measures height from the parent, so *zero* script executes in the email document. Both are safe combinations; theirs is the more conservative posture and also enables native parent-side height reads.
6. **Focus items beyond the visible list.** The ranker sees the same 20 threads the list shows, so cards always join successfully today — but if the pool sizes ever diverge, cards for threads outside the list are silently dropped. Fine as a safeguard; worth a comment-level invariant (added) and a metadata fetch if the pool grows.
7. **Unread indicator on Focus cards.** Cards don't show read/unread state; a small accent dot beside the sender would let users skip already-handled items.

## 4. Verification record

- 870 unit tests pass (11 new for the focus logic: signature stability, prompt-injection walling, foreign-id rejection, dedupe/cap, hostile-field normalization, cache semantics).
- `tsc --noEmit` clean; `next build` passes with route-export validation.
- Not verified in this environment: live rendering on a physical device (auth-gated app). Recommend a quick on-device pass of the Focus rail scroll feel and the 16px list text before promoting the PR from draft.
