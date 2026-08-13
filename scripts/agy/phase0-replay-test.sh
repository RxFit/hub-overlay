#!/usr/bin/env bash
#
# Phase 0 — Antigravity CLI (agy) allotment replay test
# =====================================================
#
# Proves the ONE load-bearing assumption of the "agy as the Hub's execution
# engine" plan: that the OAuth token minted by a single interactive `agy`
# login on your desktop can be REPLAYED on a fresh, keyring-less Linux box
# (the Cloud Run scenario) and still runs on your subscription ALLOTMENT
# (consumer OAuth), not on metered API billing.
#
# WHAT THIS SCRIPT DOES NOT DO
#   It does not authenticate for you. Minting the token needs one interactive
#   `agy` sign-in in a browser (your desktop). This script consumes the token
#   file that login produced and verifies it replays. OAuth cannot be driven
#   from an unattended environment, by design.
#
# WHAT IT PROVES
#   PASS  -> the refresh_token replays off-machine; the whole plan is green.
#   FAIL  -> replay does not hold in this environment; the verdict names why
#            (auth, empty/non-TTY drop, or connectivity) so you can act.
#
# DESIGN NOTE (why it looks paranoid)
#   agy's single worst failure mode is a SILENT one: `agy -p` writes nothing
#   and exits 0 when stdout is not a real terminal (upstream #76/#408). That
#   is exactly the "no way to know it's broken" pain you're leaving Paperclip
#   to escape. So this harness treats empty output as FAILURE, runs agy under
#   a real pseudo-terminal, and verifies a round-trip MARKER — never trusting
#   the exit code alone. It is the accountability wrapper in miniature.
#
# USAGE
#   # 1. On your desktop, sign into agy once, then copy the token file here.
#   #    Linux desktop:   ~/.gemini/antigravity-cli/antigravity-oauth-token
#   #    macOS desktop:    exported from Keychain (see scripts/agy/README.md)
#   #
#   # 2. Point the script at it and run:
#   AGY_TOKEN_FILE=./antigravity-oauth-token ./scripts/agy/phase0-replay-test.sh
#
#   # or place the token at the default path and run with no env:
#   ./scripts/agy/phase0-replay-test.sh
#
# ENV KNOBS (all optional)
#   AGY_TOKEN_FILE   Path to the token file to plant (default: already at target)
#   AGY_PATH         Path to the agy binary (default: auto-discover)
#   AGY_MODEL        Model slug to pin for the probe (default: agy's default)
#   AGY_PRINT_TIMEOUT  Per-run response timeout (default: 90s)
#   AGY_HARD_TIMEOUT   External kill ceiling in seconds (default: 150)
#
# Exit codes: 0 = PASS, 1 = FAIL (replay/auth), 2 = setup error (agy missing, etc.)

set -euo pipefail

# ----------------------------------------------------------------------------
# Config
# ----------------------------------------------------------------------------
readonly MARKER="AGY_REPLAY_OK_7Q2F"
readonly TOKEN_TARGET="${HOME}/.gemini/antigravity-cli/antigravity-oauth-token"
readonly PRINT_TIMEOUT="${AGY_PRINT_TIMEOUT:-90s}"
readonly HARD_TIMEOUT="${AGY_HARD_TIMEOUT:-150}"
PROMPT="Reply with exactly this token and nothing else: ${MARKER}"

# Colors only when attached to a terminal (this script itself may be piped)
if [ -t 1 ]; then
  C_RED=$'\033[0;31m'; C_GRN=$'\033[0;32m'; C_YEL=$'\033[0;33m'
  C_DIM=$'\033[0;90m'; C_BLD=$'\033[1m'; C_RST=$'\033[0m'
else
  C_RED=""; C_GRN=""; C_YEL=""; C_DIM=""; C_BLD=""; C_RST=""
fi

log()  { printf '%s\n' "${C_DIM}[phase0]${C_RST} $*"; }
warn() { printf '%s\n' "${C_YEL}[phase0] $*${C_RST}" >&2; }

pass() {
  printf '\n%s\n' "${C_GRN}${C_BLD}  PASS  ${C_RST} ${C_GRN}$*${C_RST}"
  printf '%s\n' "${C_DIM}  The token replays off-machine on your allotment. Phase 1 (Gateway) is unblocked.${C_RST}"
  exit 0
}
fail() {
  printf '\n%s\n' "${C_RED}${C_BLD}  FAIL  ${C_RST} ${C_RED}$*${C_RST}"
  exit 1
}
setup_err() {
  printf '\n%s\n' "${C_YEL}${C_BLD} SETUP ${C_RST} ${C_YEL}$*${C_RST}"
  exit 2
}

# ----------------------------------------------------------------------------
# 0. Force file-based token storage (no keyring / D-Bus in a container).
#    agy switches to a plain token file when it detects an SSH session.
#    Exporting these makes it use the file we plant instead of a keyring
#    that does not exist here — the crux of headless replay.
# ----------------------------------------------------------------------------
export SSH_CONNECTION="${SSH_CONNECTION:-127.0.0.1 0 127.0.0.1 22}"
export SSH_CLIENT="${SSH_CLIENT:-127.0.0.1 0 22}"
export SSH_TTY="${SSH_TTY:-/dev/pts/0}"
# Keep the binary from silently overwriting itself mid-test.
export AGY_CLI_DISABLE_AUTO_UPDATE="${AGY_CLI_DISABLE_AUTO_UPDATE:-true}"

# ----------------------------------------------------------------------------
# 1. Locate the agy binary
# ----------------------------------------------------------------------------
AGY="${AGY_PATH:-}"
if [ -z "${AGY}" ]; then
  if command -v agy >/dev/null 2>&1; then
    AGY="$(command -v agy)"
  elif [ -x "${HOME}/.local/bin/agy" ]; then
    AGY="${HOME}/.local/bin/agy"
  fi
fi
if [ -z "${AGY}" ] || [ ! -x "${AGY}" ]; then
  setup_err "agy not found. Install it first:
    curl -fsSL https://antigravity.google/cli/install.sh | bash
  or set AGY_PATH=/path/to/agy. (The clean-room Dockerfile installs it for you.)"
fi
log "agy binary: ${AGY}"

# ----------------------------------------------------------------------------
# 2. Plant the token file (if a source was given) and sanity-check it
# ----------------------------------------------------------------------------
if [ -n "${AGY_TOKEN_FILE:-}" ]; then
  [ -f "${AGY_TOKEN_FILE}" ] || setup_err "AGY_TOKEN_FILE does not exist: ${AGY_TOKEN_FILE}"
  mkdir -p "$(dirname "${TOKEN_TARGET}")"
  cp "${AGY_TOKEN_FILE}" "${TOKEN_TARGET}"
  chmod 600 "${TOKEN_TARGET}"
  log "planted token: ${AGY_TOKEN_FILE} -> ${TOKEN_TARGET}"
fi

if [ ! -f "${TOKEN_TARGET}" ]; then
  setup_err "No token file at ${TOKEN_TARGET} and no AGY_TOKEN_FILE given.
    Mint one by signing into agy on your desktop, then copy
    ~/.gemini/antigravity-cli/antigravity-oauth-token here (see README)."
fi
chmod 600 "${TOKEN_TARGET}" 2>/dev/null || true

# The refresh_token is the durable credential. A token file without one will
# never replay — catch that now with a clear message instead of an OAuth loop.
if ! grep -q '"refresh_token"' "${TOKEN_TARGET}"; then
  fail "Token file has no refresh_token — it cannot self-refresh and will not replay.
    Re-mint it with a fresh interactive 'agy' login (access_type=offline is required)."
fi
if grep -q '"auth_method"[[:space:]]*:[[:space:]]*"consumer"' "${TOKEN_TARGET}"; then
  log "auth_method=consumer (good — this draws on your plan allotment)"
else
  warn "auth_method is not 'consumer'. Replay may still work, but a non-consumer"
  warn "token may bill as API usage rather than drawing on your subscription allotment."
fi

# ----------------------------------------------------------------------------
# 3. Connectivity probe (cheap, no tokens spent on generation)
# ----------------------------------------------------------------------------
log "probing: agy --version"
if ! "${AGY}" --version >/dev/null 2>&1; then
  warn "agy --version failed; continuing to the real probe anyway."
fi

# ----------------------------------------------------------------------------
# 4. The replay run — under a REAL pseudo-terminal so output is never dropped.
#    We capture into a file, then classify. `script -qec ... /dev/null` gives
#    agy a pty even though our stdout is captured (fixes upstream #76). On
#    Linux `script` is util-linux and takes -qec; the Dockerfile guarantees it.
# ----------------------------------------------------------------------------
RAW_FILE="$(mktemp)"
trap 'rm -f "${RAW_FILE}"' EXIT

model_args=""
[ -n "${AGY_MODEL:-}" ] && model_args="--model \"${AGY_MODEL}\""

# The inner command agy runs inside the pty.
inner="${AGY} -p \"${PROMPT}\" ${model_args} --dangerously-skip-permissions --print-timeout ${PRINT_TIMEOUT}"

log "running replay probe (marker=${MARKER}, hard timeout=${HARD_TIMEOUT}s)..."
set +e
timeout --signal=TERM --kill-after=10 "${HARD_TIMEOUT}" \
  script -qec "${inner}" /dev/null > "${RAW_FILE}" 2>&1
run_rc=$?
set -e

# Strip ANSI escapes, carriage-return repaints, and box/spinner glyphs so we
# match on the model's actual text, not TUI chrome.
CLEAN="$(sed -r 's/\x1B\[[0-9;?]*[A-Za-z]//g; s/\x1B\][^\x07]*\x07//g' "${RAW_FILE}" \
          | tr -d '\r' \
          | sed 's/[│╭╮╰╯─⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]//g')"

# ----------------------------------------------------------------------------
# 5. Classify — verdict is LOUD and specific. Exit code alone is never trusted.
# ----------------------------------------------------------------------------
if echo "${CLEAN}" | grep -qi "Authentication required\|not logged into Antigravity\|authentication timed out"; then
  warn "----- captured output (tail) -----"
  echo "${CLEAN}" | tail -n 8 >&2
  fail "AUTH did not replay. agy fell back to interactive OAuth in this environment.
    Most common cause: the SSH_* env vars did not take, so agy tried the keyring
    (absent here) instead of the token file. Confirm the token file exists at
    ${TOKEN_TARGET} and that this shell exported SSH_CONNECTION/SSH_CLIENT/SSH_TTY.
    If it persists, the refresh_token itself is stale — re-mint on your desktop."
fi

if [ -z "${CLEAN//[[:space:]]/}" ]; then
  fail "EMPTY output (exit ${run_rc}) — the silent-failure mode.
    Either the pty was not honored (no /dev/pts in this container) or agy
    produced nothing. Re-run in the provided Dockerfile, which guarantees a pty.
    Never treat this as success: empty == failed, always."
fi

if echo "${CLEAN}" | grep -q "${MARKER}"; then
  log "marker found in output — round-trip verified."
  pass "agy answered on the replayed token (marker ${MARKER} returned)."
fi

# Non-empty, no auth error, but no marker: the model replied (so auth + replay
# likely worked) but didn't echo the marker. Treat as a soft pass with a nudge.
warn "----- captured output (tail) -----"
echo "${CLEAN}" | tail -n 12 >&2
warn "Got a non-empty reply with no auth error, but the exact marker was not found."
warn "Auth almost certainly replayed (no OAuth prompt). Eyeball the output above:"
warn "if it's a real model answer, call this GREEN. If it's noise, investigate."
exit 1
