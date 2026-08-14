# CLAUDE.md — Repo guidance for Claude Code sessions

## Pull requests: create REAL PRs, never drafts

Open every pull request as a **regular (non-draft) PR**. Do not use `draft: true`.

Why: this repo uses automation ("Jules") that auto-merges green PRs. Draft PRs
block that automation and stall the project waiting on a manual review that the
owner (Danny) does not want to be the bottleneck for. CI (typecheck + unit tests
+ Playwright e2e) is the merge gate here — if checks pass, the PR should be
mergeable immediately without human intervention.

- After pushing a branch, open the PR ready-for-review right away.
- Do not wait for the owner's review before considering the task done.
- Keep watching CI after opening the PR and fix failures promptly so
  auto-merge isn't blocked.

## Deployment

Merges to `master` auto-deploy to Cloud Run via `.github/workflows/deploy.yml`
(project `rxfit-automation`, service `hub`, us-central1). No manual deploy step
is needed after merge.

## App layout

The Next.js app lives in `hub/`. Run all npm/test commands from that directory:
`npm run test` (vitest), `npx playwright test` (e2e), `npm run build`.

## Doc precedence: the agy migration has canonical sources

For the Antigravity CLI (agy) migration — strategy, phases, operations — the
canonical documents are, in order:

1. `scripts/agy/README.md` — migration blueprint, phase roadmap, risk framing
2. `hub/docs/runbooks/agy-gateway.md` — operating the gateway (token setup,
   failure classes, rotation)
3. Module-header docs in `hub/lib/agy.ts` — behavioral contracts of the code

These were produced from primary research (live verification against the agy
release server and CLI, Phase 0/1 implementation). Other instruction files —
including `AGENTS.md` — summarize or route to them. **On any conflict, the
canonical documents above win.** Do not follow a contradicting summary; fix the
contradiction with a PR instead.

When changing instruction files (`AGENTS.md`, this file): these auto-merge like
any green PR, but they program every future agent session. Keep them consistent
with the canonical docs, and prefer pointing at a canonical doc over restating
its content where drift could accumulate.
