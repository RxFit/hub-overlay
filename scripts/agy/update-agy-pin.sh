#!/usr/bin/env bash
#
# update-agy-pin.sh — DELIBERATELY move the agy version pin.
#
# Fetches the current linux_amd64 release manifest, downloads the artifact,
# computes the sha512 FROM THE BYTES (the manifest's own hash is
# self-attesting — same server as the binary — so it is compared but never
# trusted as the anchor), and rewrites scripts/agy/agy-version.lock.
#
# This script does NOT bless the version: run the Phase 0 replay test against
# it (README.md § Phase 0) before committing the changed lock. The worker's
# boot canary is the last net if an unblessed pin ships anyway.
set -euo pipefail

LOCK_FILE="$(cd "$(dirname "$0")" && pwd)/agy-version.lock"
MANIFEST_URL="https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_amd64.json"

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

echo "→ fetching manifest: $MANIFEST_URL"
manifest="$(curl -fsSL "$MANIFEST_URL")"

parse_key() {
  printf '%s' "$manifest" | sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
}

version="$(parse_key version)"
url="$(parse_key url)"
manifest_sha="$(parse_key sha512)"
[ -n "$version" ] && [ -n "$url" ] || { echo "FATAL: could not parse manifest" >&2; exit 1; }

echo "→ latest published: $version"
echo "→ downloading artifact for independent hashing…"
curl -fsSL -o "$workdir/agy.tar.gz" "$url"
computed_sha="$(sha512sum "$workdir/agy.tar.gz" | cut -d' ' -f1)"

if [ "$computed_sha" != "$manifest_sha" ]; then
  echo "WARNING: manifest sha512 does not match the downloaded bytes." >&2
  echo "  manifest: $manifest_sha" >&2
  echo "  computed: $computed_sha" >&2
  echo "The lock records the COMPUTED hash; investigate the mismatch before trusting this build." >&2
fi

# Sanity: the archive must contain the single 'antigravity' member the
# Dockerfiles extract.
tar -tzf "$workdir/agy.tar.gz" | grep -qx 'antigravity' \
  || { echo "FATAL: archive layout changed — no 'antigravity' member. Update the Dockerfiles first." >&2; exit 1; }

# Rewrite only the value lines; the header commentary stays.
tmp="$workdir/lock.new"
grep -v '^AGY_VERSION=\|^AGY_URL=\|^AGY_SHA512=' "$LOCK_FILE" > "$tmp"
{
  echo "AGY_VERSION=\"$version\""
  echo "AGY_URL=\"$url\""
  echo "AGY_SHA512=\"$computed_sha\""
} >> "$tmp"
mv "$tmp" "$LOCK_FILE"

echo "✓ lock updated → $version"
echo
echo "NEXT: bless it before committing —"
echo "  docker build -f scripts/agy/Dockerfile.phase0 -t agy-phase0 scripts/agy"
echo "  docker run --rm -v /path/to/token:/token:ro -e AGY_TOKEN_FILE=/token agy-phase0"
