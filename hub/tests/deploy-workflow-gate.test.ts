import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parse } from 'yaml'

/**
 * Guard: the production deploy gate in .github/workflows/deploy.yml.
 *
 * WHY THIS EXISTS — deploy run 214 (2026-09-22, merge 5832098 of #241)
 * concluded `skipped` while run 213, seventeen minutes earlier on the same
 * workflow file, deployed. Nothing about the workflow differed: the triggering
 * CI run's FIRST attempt had failed in the DB harness (a migrate.mjs catalog
 * race, fixed separately), so `workflow_run.conclusion` was `failure` and the
 * job's `if:` held the deploy back exactly as designed. The green re-run then
 * fired run 215, which deployed. The gate did its job — but the incident showed
 * that nothing in the repo PINS that behaviour, and that one line beside the
 * gate was quietly wrong: `GIT_SHA=$GITHUB_SHA`. On a workflow_run event
 * GITHUB_SHA is "last commit on the default branch" at the time the event
 * fired, not the commit the job checks out (workflow_run.head_sha). A re-run
 * that completes after master has moved on stamps the built revision with a
 * SHA it was not built from, and /api/worker/claim's version-drift check
 * reports drift (or parity) that is not real.
 *
 * What is pinned here, from the workflow files themselves:
 *   1. THE HANDSHAKE. deploy.yml listens for the workflow ci.yml is actually
 *      named, on the branch ci.yml actually pushes, for `completed` only, and
 *      keeps the manual escape hatch. Rename "CI" and every deploy silently
 *      stops — a skipped deploy has no symptom (the 13-day stale-production
 *      incident behind tests/gcloudignore-build-context.test.ts).
 *   2. THE GATE. The job `if:` is evaluated with a small evaluator for the
 *      GitHub-expression subset it uses, against the recorded contexts of runs
 *      213 (deployed) and 214 (skipped), plus the spoof cases the comment in
 *      deploy.yml promises to close. A comment is not a check; this is.
 *   3. THE DEPLOYED COMMIT. Checkout and the GIT_SHA stamp read ONE value,
 *      DEPLOY_SHA, whose expression is evaluated against a context where master
 *      HAS moved on and must still resolve to the validated commit; and nothing
 *      in the job reads GITHUB_SHA / github.sha directly.
 *
 * FAILS CLOSED. Anything the evaluator cannot parse is a thrown error naming
 * the token, never a pass — the same posture as the other static guards.
 */

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const OUR_REPO = 'RxFit/hub-overlay'

/* ── Workflow shapes (only the keys this guard reads) ─────────────────────── */

interface Step {
  name?: string
  uses?: string
  run?: string
  with?: Record<string, unknown>
  env?: Record<string, unknown>
  if?: string
}

interface DeployWorkflow {
  on: {
    workflow_run?: { workflows?: unknown; types?: unknown; branches?: unknown }
    workflow_dispatch?: unknown
  }
  concurrency?: { group?: unknown; 'cancel-in-progress'?: unknown }
  jobs: Record<string, { if?: unknown; env?: Record<string, unknown>; steps?: Step[] }>
}

interface CiWorkflow {
  name: string
  on: { push?: { branches?: unknown }; pull_request?: { branches?: unknown } }
}

function loadWorkflow<T>(file: string): T {
  return parse(readFileSync(join(repoRoot, '.github', 'workflows', file), 'utf8')) as T
}

const deploy = loadWorkflow<DeployWorkflow>('deploy.yml')
const ci = loadWorkflow<CiWorkflow>('ci.yml')

/* ── A minimal evaluator for the GitHub-expression subset the gate uses ──────
 * Grammar, lowest precedence first. GitHub's operator table runs `( )`, `!`,
 * comparisons, `==`/`!=`, `&&`, `||` from tightest to loosest, so `!` binds
 * to its operand BEFORE any comparison (`!a == b` is `(!a) == b`):
 *   or      := and ('||' and)*
 *   and     := cmp ('&&' cmp)*
 *   cmp     := primary (('==' | '!=') primary)?
 *   primary := '!' primary | '(' or ')' | 'string' | number | true | false
 *              | null | ctx.path
 * Semantics that matter here: string equality is case-insensitive; operands of
 * different types are coerced to numbers (null → 0, '' → 0, a string that is a
 * legal JSON number → that number, any other string → NaN, and NaN equals
 * nothing); `&&` / `||` return an operand, and the job runs on a truthy result
 * (anything but false / null / 0 / ''). Property names may contain `-`
 * (GitHub allows `steps.build-image.outputs.x`), so a hyphen is part of a path,
 * never an operator. Context lookups are case-insensitive, as GitHub's are. */

type Val = string | number | boolean | null

type Token =
  | { kind: 'op'; value: '(' | ')' | '||' | '&&' | '==' | '!=' | '!' }
  | { kind: 'str'; value: string }
  | { kind: 'num'; value: number }
  | { kind: 'path'; value: string }

function tokenize(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) { i++; continue }
    const two = src.slice(i, i + 2)
    if (two === '||' || two === '&&' || two === '==' || two === '!=') {
      out.push({ kind: 'op', value: two }); i += 2; continue
    }
    if (c === '(' || c === ')' || c === '!') { out.push({ kind: 'op', value: c }); i++; continue }
    if (c === "'") {
      let j = i + 1
      let s = ''
      for (;;) {
        if (j >= src.length) throw new Error(`unterminated string literal at ${i}`)
        if (src[j] === "'") {
          if (src[j + 1] === "'") { s += "'"; j += 2; continue } // '' escapes a quote
          break
        }
        s += src[j]; j++
      }
      out.push({ kind: 'str', value: s }); i = j + 1; continue
    }
    // Number literals as GitHub accepts them: decimal with optional fraction
    // and exponent, or hexadecimal.
    const num = /^(0x[0-9a-fA-F]+|-?\d+(\.\d+)?([eE][+-]?\d+)?)/.exec(src.slice(i))
    if (num) { out.push({ kind: 'num', value: Number(num[0]) }); i += num[0].length; continue }
    const path = /^[A-Za-z_][A-Za-z0-9_\-]*(\.[A-Za-z_][A-Za-z0-9_\-]*)*/.exec(src.slice(i))
    if (path) { out.push({ kind: 'path', value: path[0] }); i += path[0].length; continue }
    throw new Error(`cannot tokenize ${JSON.stringify(src.slice(i, i + 12))} at ${i}`)
  }
  return out
}

/** GitHub's number coercion for `==`: strings parse "from any legal JSON number format, otherwise NaN"; '' is 0. */
function toNumber(v: Val): number {
  if (v === null) return 0
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'number') return v
  if (v === '') return 0
  return /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(v) ? Number(v) : Number.NaN
}

function looseEquals(a: Val, b: Val): boolean {
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase()
  if (typeof a === typeof b) return a === b
  const na = toNumber(a)
  const nb = toNumber(b)
  return !Number.isNaN(na) && !Number.isNaN(nb) && na === nb
}

function truthy(v: Val): boolean {
  return !(v === null || v === false || v === 0 || v === '')
}

function lookup(ctx: unknown, path: string): Val {
  let cur: unknown = ctx
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return null
    const rec = cur as Record<string, unknown>
    const key = Object.keys(rec).find((k) => k.toLowerCase() === part.toLowerCase())
    cur = key === undefined ? null : rec[key]
  }
  if (cur === undefined) return null
  if (cur === null || typeof cur === 'string' || typeof cur === 'number' || typeof cur === 'boolean') return cur
  throw new Error(`context path ${path} resolves to a non-scalar; the gate never compares objects`)
}

function evaluateExpression(expression: string, ctx: unknown): Val {
  const wrapped = /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(expression)
  const tokens = tokenize(wrapped ? wrapped[1] : expression)
  let pos = 0
  const peek = (): Token | undefined => tokens[pos]
  const takeOp = (value: string): boolean => {
    const t = peek()
    if (t?.kind === 'op' && t.value === value) { pos++; return true }
    return false
  }

  const primary = (): Val => {
    const t = peek()
    if (!t) throw new Error('unexpected end of expression')
    pos++
    if (t.kind === 'op' && t.value === '!') return !truthy(primary())
    if (t.kind === 'op' && t.value === '(') {
      const v = or()
      if (!takeOp(')')) throw new Error('missing )')
      return v
    }
    if (t.kind === 'str') return t.value
    if (t.kind === 'num') return t.value
    if (t.kind === 'path') {
      if (t.value === 'true') return true
      if (t.value === 'false') return false
      if (t.value === 'null') return null
      return lookup(ctx, t.value)
    }
    throw new Error(`unexpected token ${JSON.stringify(t)}`)
  }
  const cmp = (): Val => {
    const left = primary()
    if (takeOp('==')) return looseEquals(left, primary())
    if (takeOp('!=')) return !looseEquals(left, primary())
    return left
  }
  const and = (): Val => {
    let v = cmp()
    while (takeOp('&&')) { const r = cmp(); v = truthy(v) ? r : v }
    return v
  }
  const or = (): Val => {
    let v = and()
    while (takeOp('||')) { const r = and(); v = truthy(v) ? v : r }
    return v
  }

  const result = or()
  if (pos !== tokens.length) throw new Error(`trailing tokens from ${JSON.stringify(tokens[pos])}`)
  return result
}

/** Would the deploy job RUN under this `github` context? (true = run, false = skipped) */
function jobRuns(ctx: unknown): boolean {
  const cond = deploy.jobs.deploy.if
  if (typeof cond !== 'string' || cond.trim() === '') {
    throw new Error('jobs.deploy has no `if:` — the CI gate is gone')
  }
  return truthy(evaluateExpression(cond, ctx))
}

/* ── Recorded contexts. Fields are the ones the gate and DEPLOY_SHA read, as
 * GitHub sent them for these runs (conclusion / event / head_repository from
 * the CI run each deploy was triggered by). `github.sha` is what GITHUB_SHA
 * holds on a workflow_run event: the DEFAULT-BRANCH TIP when the event fired,
 * which is only sometimes the validated commit. ─────────────────────────── */

const SHA_3480342 = '34803421920e664a447a235b77be9ed2883d64ce' // #240, deployed by run 213
const SHA_5832098 = '5832098a47e188a652777e4b9d30137d4ebf48ab' // #241, skipped by 214, deployed by 215
/** A hypothetical later push to master that lands while a CI re-run is still in flight. */
const LATER_MASTER_TIP = 'ffffffffffffffffffffffffffffffffffffffff'

interface WorkflowRunCtx {
  conclusion: string | null
  event: string
  head_branch: string
  head_sha: string
  head_repository: { full_name: string }
}

function workflowRunEvent(
  run: Partial<WorkflowRunCtx>,
  opts: { repository?: string; masterTip?: string } = {},
) {
  const workflow_run: WorkflowRunCtx = {
    conclusion: 'success',
    event: 'push',
    head_branch: 'master',
    head_sha: SHA_3480342,
    head_repository: { full_name: OUR_REPO },
    ...run,
  }
  return {
    github: {
      event_name: 'workflow_run',
      repository: opts.repository ?? OUR_REPO,
      sha: opts.masterTip ?? workflow_run.head_sha,
      event: { workflow_run },
    },
  }
}

/** Run 213: CI run 591 on master, push, success → deployed 3480342. */
const run213 = workflowRunEvent({ head_sha: SHA_3480342 })
/** Run 214: CI run 594 attempt 1 on master, push, FAILURE → skipped 5832098. */
const run214 = workflowRunEvent({ conclusion: 'failure', head_sha: SHA_5832098 })
/** Run 215: CI run 594 attempt 2 (the re-run), push, success → deployed 5832098.
 *  Modelled with master already moved on, the case GITHUB_SHA gets wrong. */
const run215 = workflowRunEvent({ head_sha: SHA_5832098 }, { masterTip: LATER_MASTER_TIP })

const manualDispatch = {
  github: { event_name: 'workflow_dispatch', repository: OUR_REPO, sha: SHA_5832098, event: {} },
}

/* ── 1. The handshake ─────────────────────────────────────────────────────── */

describe('deploy.yml listens to the CI workflow that actually exists', () => {
  it('names ci.yml by its `name:` — a rename would silently stop every deploy', () => {
    expect(ci.name, 'ci.yml must have a name for workflow_run to reference').toBeTruthy()
    expect(deploy.on.workflow_run?.workflows).toEqual([ci.name])
  })

  it('reacts to completed runs only, on the branch ci.yml pushes', () => {
    expect(deploy.on.workflow_run?.types).toEqual(['completed'])
    expect(deploy.on.workflow_run?.branches).toEqual(['master'])
    expect(ci.on.push?.branches, 'ci.yml must run on push to the branch deploy.yml watches').toEqual(['master'])
  })

  it('keeps the manual escape hatch (Actions → Run workflow)', () => {
    expect(deploy.on.workflow_dispatch).toBeDefined()
  })

  it('never cancels an in-flight deploy (a half-promoted candidate is the worst state)', () => {
    expect(deploy.concurrency?.group).toBe('deploy-hub')
    expect(deploy.concurrency?.['cancel-in-progress']).toBe(false)
  })
})

/* ── 2. The gate ──────────────────────────────────────────────────────────── */

describe('the deploy job gate, evaluated as GitHub evaluates it', () => {
  it('run 213: a successful push CI on this repo deploys', () => {
    expect(jobRuns(run213)).toBe(true)
  })

  it('run 214: the same workflow with a FAILED CI is skipped — the gate, not the file, held the deploy', () => {
    expect(jobRuns(run214)).toBe(false)
  })

  it('run 215: the green re-run of that CI deploys the same commit', () => {
    expect(jobRuns(run215)).toBe(true)
  })

  it('a cancelled CI (superseded by a newer master push) is skipped', () => {
    expect(jobRuns(workflowRunEvent({ conclusion: 'cancelled' }))).toBe(false)
  })

  it('a CI run that is not a push never deploys, even from this repo (pull_request on a branch named master)', () => {
    expect(jobRuns(workflowRunEvent({ event: 'pull_request' }))).toBe(false)
  })

  it('a push CI from a fork never deploys (head_repository is not ours)', () => {
    expect(jobRuns(workflowRunEvent({ head_repository: { full_name: 'someone-else/hub-overlay' } }))).toBe(false)
  })

  it('manual dispatch deploys with no workflow_run payload at all', () => {
    expect(jobRuns(manualDispatch)).toBe(true)
  })

  it('a non-dispatch event with no workflow_run payload is skipped (nothing was validated)', () => {
    expect(jobRuns({ github: { event_name: 'push', repository: OUR_REPO, event: {} } })).toBe(false)
  })

  it('evaluator sanity: precedence, case-insensitive strings, JSON-number coercion', () => {
    expect(evaluateExpression("'A' == 'a'", {})).toBe(true)
    expect(evaluateExpression("null == 'success'", {})).toBe(false)
    expect(evaluateExpression("missing.path == 'x'", {})).toBe(false)
    expect(evaluateExpression("GITHUB.Event_Name == 'push'", { github: { event_name: 'PUSH' } })).toBe(true)
    // && binds tighter than ||, and both return operands.
    expect(evaluateExpression("false || 'yes' && 'no'", {})).toBe('no')
    expect(evaluateExpression("(false || 'yes') && false", {})).toBe(false)
    // ! binds tighter than ==: `!a == b` is `(!a) == b`, as on GitHub.
    expect(evaluateExpression("!'x' == false", {})).toBe(true)
    expect(evaluateExpression("!('a' == 'b')", {})).toBe(true)
    expect(evaluateExpression("!'success' == 'success'", { })).toBe(false)
    // Strings coerce by JSON-number rules only: '1e2' is 100, '0x10' is NaN.
    expect(evaluateExpression("'1e2' == 100", {})).toBe(true)
    expect(evaluateExpression("'0x10' == 16", {})).toBe(false)
    expect(evaluateExpression("0x10 == 16", {})).toBe(true)
    expect(evaluateExpression("'' == null", {})).toBe(true)
    expect(() => evaluateExpression("'a' == ", {})).toThrow()
    expect(() => evaluateExpression("a == 'b' ??", {})).toThrow()
  })
})

/* ── 3. The deployed commit ───────────────────────────────────────────────── */

describe('the job deploys, and stamps, exactly one commit', () => {
  const job = deploy.jobs.deploy
  const steps = job.steps ?? []
  const deploySha = job.env?.DEPLOY_SHA

  /** Any spelling of the default-branch SHA: $GITHUB_SHA / ${GITHUB_SHA},
   *  github.sha in any case, or the bracket form github['sha']. */
  const DEFAULT_BRANCH_SHA = /\$\{?GITHUB_SHA|\bgithub(\.sha\b|\s*\[\s*['"]sha['"]\s*\])/i

  it('DEPLOY_SHA is an expression that resolves to the CI-validated commit even after master has moved on', () => {
    expect(typeof deploySha, 'jobs.deploy.env.DEPLOY_SHA is missing').toBe('string')
    const expr = String(deploySha)
    expect(expr).toMatch(/^\$\{\{[\s\S]*\}\}$/)
    // Run 215's context has master at a LATER commit than the one CI validated;
    // GITHUB_SHA would hand back that later commit. DEPLOY_SHA must not.
    expect(run215.github.sha).not.toBe(SHA_5832098)
    expect(evaluateExpression(expr, run215)).toBe(SHA_5832098)
    expect(evaluateExpression(expr, run213)).toBe(SHA_3480342)
  })

  it('DEPLOY_SHA falls back to the dispatched tip on a manual run', () => {
    expect(evaluateExpression(String(deploySha), manualDispatch)).toBe(SHA_5832098)
  })

  it('checkout reads DEPLOY_SHA, not github.ref or github.sha', () => {
    const checkout = steps.find((s) => typeof s.uses === 'string' && s.uses.startsWith('actions/checkout@'))
    expect(checkout, 'no actions/checkout step').toBeDefined()
    expect(checkout?.with?.ref).toBe('${{ env.DEPLOY_SHA }}')
  })

  it('GIT_SHA is stamped from DEPLOY_SHA, and nothing else in the job reads the default-branch SHA', () => {
    const deployStep = steps.find((s) => typeof s.run === 'string' && s.run.includes('gcloud run deploy'))
    expect(deployStep, 'no `gcloud run deploy` step').toBeDefined()
    expect(deployStep?.run).toMatch(/GIT_SHA=\$DEPLOY_SHA\b/)

    // Job-level env: DEPLOY_SHA is the ONE place github.sha may appear (as the
    // manual-dispatch fallback).
    for (const [key, value] of Object.entries(job.env ?? {})) {
      if (key === 'DEPLOY_SHA') continue
      expect(String(value), `job env ${key} reads the default-branch SHA`).not.toMatch(DEFAULT_BRANCH_SHA)
    }

    // Match CODE, not the comments explaining why the code avoids GITHUB_SHA:
    // shell comment lines are dropped from `run` scripts before matching, the
    // same specifier-not-mention discipline as tests/no-google-font-fetch.test.ts.
    const shellCode = (script: string) => script.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n')
    for (const step of steps) {
      const surfaces = [
        shellCode(step.run ?? ''),
        step.if ?? '',
        ...Object.values(step.with ?? {}).map(String),
        ...Object.values(step.env ?? {}).map(String),
      ]
      for (const text of surfaces) {
        expect(text, `step "${step.name ?? step.uses}" reads the default-branch SHA instead of DEPLOY_SHA`)
          .not.toMatch(DEFAULT_BRANCH_SHA)
      }
    }
  })
})
