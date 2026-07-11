#!/bin/sh
# Container entrypoint (P1-I2): run DB migrations BEFORE the app serves traffic.
#
# drizzle/migrate.mjs is fully idempotent (CREATE TABLE / ADD COLUMN / CREATE
# INDEX ... IF NOT EXISTS, INSERT ... ON CONFLICT DO NOTHING), so running it on
# every cold start is safe and cheap — after the first apply, every statement is
# a no-op.
#
# MIGRATION FAILURE IS NON-FATAL BY DEFAULT (2026-07-10 deploy outage). The
# original fail-fast design (`set -e` + exit on migrate failure) meant ANY
# migration error made the container exit before binding :3000 — and because
# the script runs on every cold start, one bad statement bricked EVERY deploy:
# 14 consecutive "container failed to start on PORT=3000" failures while prod
# silently pinned to the last pre-entrypoint revision. Fail-fast here is also
# redundant as a serviceability gate — the /api/healthz startupProbe and the
# deploy.yml smoke test already verify DB reachability + AI keys before a
# revision takes/keeps traffic. So: log loudly, start the server, and let the
# real gates decide. Set MIGRATE_STRICT=1 on the service to restore fail-fast
# (e.g. while landing a migration new code genuinely cannot run without).
#
# The migration run is time-bounded by migrate.mjs' own watchdog
# (MIGRATE_WATCHDOG_MS, default 90s) so a hung DB connection cannot eat the
# startup-probe budget.
#
# `exec "$@"` replaces this shell with the CMD (`npm start` -> `next start`) so
# SIGTERM reaches Next directly for graceful shutdown.
set -e

echo "[entrypoint] Running database migrations (drizzle/migrate.mjs)..."
if node drizzle/migrate.mjs; then
  echo "[entrypoint] Migrations complete — starting server."
else
  status=$?
  echo "[entrypoint] ⚠️  MIGRATIONS FAILED (exit $status). See [migrate] logs above for the failing step."
  if [ "${MIGRATE_STRICT:-0}" = "1" ]; then
    echo "[entrypoint] MIGRATE_STRICT=1 — refusing to start the server with failed migrations."
    exit "$status"
  fi
  echo "[entrypoint] Starting the server anyway: schema statements are idempotent/additive and /api/healthz still gates serviceability. Fix the migration, but do not brick deploys."
fi

exec "$@"
