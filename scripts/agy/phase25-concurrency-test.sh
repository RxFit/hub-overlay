#!/usr/bin/env bash
#
# Phase 2.5 — agy token CONCURRENCY test
# ======================================
#
# Answers the open question flagged in
# hub/docs/architecture/DESKTOP_DISPATCH_2026-08-15.md: does ONE consumer-OAuth
# token tolerate CONCURRENT agy runs? The answer decides the desktop worker's
# slot policy — strictly serial (chat blocks issue runs) vs parallel slots.
#
# WHERE TO RUN: the desktop that minted the token (residential IP), same as
# Phase 0. From a datacenter IP every run auth-fails regardless — that finding
# is settled; do not use this script to re-test it.
#
#   # Windows (PowerShell), via the Phase 0 clean-room image:
#   docker build -f scripts/agy/Dockerfile.phase0 -t agy-phase0 scripts/agy
#   docker run --rm -v "$env:USERPROFILE\.gemini\antigravity-cli:/token-dir" `
#     -e AGY_TOKEN_FILE=/token-dir/antigravity-oauth-token `
#     --entrypoint /bin/bash agy-phase0 /repo/scripts/agy/phase25-concurrency-test.sh
#   # (or copy this script into the container; any Linux+agy+token env works)
#
# WHAT IT DOES
#   1. Control: one solo marker run (must pass — else the environment is bad
#      and concurrency conclusions would be noise).
#   2. Fires N (default 3) marker runs SIMULTANEOUSLY on the same token.
#   3. Verifies each run's distinct marker; hashes the token file before/after
#      to detect torn refresh writes.
#   4. Prints a LOUD verdict: PARALLEL_OK | SERIAL_ONLY | INCONCLUSIVE.
#
# Phase 0 paranoia applies throughout: real pty per run (script -qec), empty
# output is ALWAYS failure, exit codes are never trusted.
#
# ENV KNOBS
#   AGY_CONC_N          Concurrent runs (default 3)
#   AGY_TOKEN_FILE      Token to plant (default: already at agy's path)
#   AGY_PATH            agy binary (default: auto-discover)
#   AGY_PRINT_TIMEOUT   Per-run timeout (default 90s)
#
# Exit codes: 0 = PARALLEL_OK, 1 = SERIAL_ONLY, 2 = setup/control failure,
#             3 = INCONCLUSIVE (mixed signals — read the per-run report)

set -euo pipefail

readonly N="${AGY_CONC_N:-3}"
readonly TOKEN_TARGET="${HOME}/.gemini/antigravity-cli/antigravity-oauth-token"
readonly PRINT_TIMEOUT="${AGY_PRINT_TIMEOUT:-90s}"
readonly HARD_TIMEOUT=150

if [ -t 1 ]; then
  C_RED=$'\033[0;31m'; C_GRN=$'\033[0;32m'; C_YEL=$'\033[0;33m'
  C_DIM=$'\033[0;90m'; C_BLD=$'\033[1m'; C_RST=$'\033[0m'
else
  C_RED=""; C_GRN=""; C_YEL=""; C_DIM=""; C_BLD=""; C_RST=""
fi
log()  { printf '%s\n' "${C_DIM}[conc]${C_RST} $*"; }
warn() { printf '%s\n' "${C_YEL}[conc] $*${C_RST}" >&2; }

# Force file-based token storage; freeze the binary (Phase 0 conventions).
export SSH_CONNECTION="${SSH_CONNECTION:-127.0.0.1 0 127.0.0.1 22}"
export SSH_CLIENT="${SSH_CLIENT:-127.0.0.1 0 22}"
export SSH_TTY="${SSH_TTY:-/dev/pts/0}"
export AGY_CLI_DISABLE_AUTO_UPDATE="${AGY_CLI_DISABLE_AUTO_UPDATE:-true}"

AGY="${AGY_PATH:-}"
if [ -z "${AGY}" ]; then
  if command -v agy >/dev/null 2>&1; then AGY="$(command -v agy)";
  elif [ -x "${HOME}/.local/bin/agy" ]; then AGY="${HOME}/.local/bin/agy"; fi
fi
[ -n "${AGY}" ] && [ -x "${AGY}" ] || { warn "agy not found — install it or set AGY_PATH"; exit 2; }
log "agy binary: ${AGY} ($(${AGY} --version 2>/dev/null || echo '?'))"

if [ -n "${AGY_TOKEN_FILE:-}" ]; then
  [ -f "${AGY_TOKEN_FILE}" ] || { warn "AGY_TOKEN_FILE does not exist: ${AGY_TOKEN_FILE}"; exit 2; }
  mkdir -p "$(dirname "${TOKEN_TARGET}")"
  cp "${AGY_TOKEN_FILE}" "${TOKEN_TARGET}"
  chmod 600 "${TOKEN_TARGET}"
fi
[ -f "${TOKEN_TARGET}" ] || { warn "no token at ${TOKEN_TARGET} and no AGY_TOKEN_FILE given"; exit 2; }
grep -q '"refresh_token"' "${TOKEN_TARGET}" || { warn "token has no refresh_token — re-mint it"; exit 2; }

hash_token() { sha256sum "${TOKEN_TARGET}" | cut -d' ' -f1; }

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

strip_tui() {
  sed -r 's/\x1B\[[0-9;?]*[A-Za-z]//g; s/\x1B\][^\x07]*\x07//g' "$1" \
    | tr -d '\r' | sed 's/[│╭╮╰╯─⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]//g'
}

# run_one <label> <marker> — pty run, output to ${WORK}/<label>.out
run_one() {
  local label="$1" marker="$2"
  local prompt="Reply with exactly this token and nothing else: ${marker}"
  local inner="${AGY} -p \"${prompt}\" --dangerously-skip-permissions --print-timeout ${PRINT_TIMEOUT}"
  timeout --signal=TERM --kill-after=10 "${HARD_TIMEOUT}" \
    script -qec "${inner}" /dev/null > "${WORK}/${label}.out" 2>&1 || true
}

# classify <label> <marker> → pass|auth|empty|noise
classify() {
  local label="$1" marker="$2"
  local clean; clean="$(strip_tui "${WORK}/${label}.out")"
  if echo "${clean}" | grep -q "${marker}"; then echo pass; return; fi
  if echo "${clean}" | grep -qiE "authentication required|not logged into antigravity|authentication (failed|timed out)|rate.?limit|too many|429"; then
    echo auth; return
  fi
  if [ -z "${clean//[[:space:]]/}" ]; then echo empty; return; fi
  echo noise
}

# ── 1. Control run ───────────────────────────────────────────────────────────
HASH_BEFORE="$(hash_token)"
log "control: one solo marker run first (bad environment ⇒ stop, don't guess)"
run_one control "CONC_CONTROL_9X4"
CONTROL="$(classify control CONC_CONTROL_9X4)"
if [ "${CONTROL}" != "pass" ]; then
  warn "----- control output (tail) -----"; strip_tui "${WORK}/control.out" | tail -n 8 >&2
  printf '\n%s\n' "${C_YEL}${C_BLD} SETUP ${C_RST} ${C_YEL}Solo control run FAILED (${CONTROL}) — environment/token is bad; concurrency untested.${C_RST}"
  exit 2
fi
log "control passed — environment is good. Firing ${N} concurrent runs..."

# ── 2. Concurrent runs ───────────────────────────────────────────────────────
PIDS=()
for i in $(seq 1 "${N}"); do
  run_one "c${i}" "CONC_MARKER_${i}_7Q2F" &
  PIDS+=("$!")
done
for pid in "${PIDS[@]}"; do wait "${pid}"; done

# ── 3. Classify + verdict ────────────────────────────────────────────────────
PASSES=0; AUTHS=0; EMPTIES=0; NOISES=0
for i in $(seq 1 "${N}"); do
  r="$(classify "c${i}" "CONC_MARKER_${i}_7Q2F")"
  case "${r}" in
    pass)  PASSES=$((PASSES+1)); log "run ${i}: PASS";;
    auth)  AUTHS=$((AUTHS+1));   warn "run ${i}: AUTH/RATE failure";;
    empty) EMPTIES=$((EMPTIES+1)); warn "run ${i}: EMPTY output";;
    noise) NOISES=$((NOISES+1)); warn "run ${i}: replied but no marker (soft — eyeball ${WORK}/c${i}.out)";;
  esac
done

HASH_AFTER="$(hash_token)"
if [ "${HASH_BEFORE}" != "${HASH_AFTER}" ]; then
  log "token file changed during the test (refresh happened) — checking it still parses"
  grep -q '"refresh_token"' "${TOKEN_TARGET}" \
    && log "token still has refresh_token — refresh survived concurrency" \
    || warn "TOKEN FILE DAMAGED — no refresh_token after concurrent runs. Re-mint before anything else."
fi

printf '\n%s runs: %s pass / %s auth / %s empty / %s no-marker\n\n' "${N}" "${PASSES}" "${AUTHS}" "${EMPTIES}" "${NOISES}"

if [ "${PASSES}" -eq "${N}" ]; then
  printf '%s\n' "${C_GRN}${C_BLD} PARALLEL_OK ${C_RST} ${C_GRN}All ${N} concurrent runs answered on one token. The worker may run parallel slots (chat + work_item).${C_RST}"
  exit 0
elif [ "${PASSES}" -ge 1 ] && [ "${AUTHS}" -ge 1 ]; then
  printf '%s\n' "${C_RED}${C_BLD} SERIAL_ONLY ${C_RST} ${C_RED}Concurrent runs trip auth/rate limits (control passed solo). Keep the worker strictly serial — chat preempts, work_items yield.${C_RST}"
  exit 1
else
  printf '%s\n' "${C_YEL}${C_BLD} INCONCLUSIVE ${C_RST} ${C_YEL}Mixed signals (empties/no-marker without clean auth failures). Re-run; if it persists, treat as SERIAL_ONLY — the safe default.${C_RST}"
  exit 3
fi
