#!/bin/sh
# Container entrypoint (P1-I2): run DB migrations BEFORE the app serves traffic.
#
# drizzle/migrate.mjs is fully idempotent (CREATE TABLE / ADD COLUMN / CREATE
# INDEX ... IF NOT EXISTS, INSERT ... ON CONFLICT DO NOTHING), so running it on
# every cold start is safe and cheap — after the first apply, every statement is
# a no-op. `set -e` + migrate.mjs' own `process.exit(1)` on failure means a
# broken migration makes the container exit non-zero, so Cloud Run's startup
# gate fails and the revision never takes traffic (fail fast, don't half-serve).
#
# `exec "$@"` replaces this shell with the CMD (`npm start` -> `next start`) so
# SIGTERM reaches Next directly for graceful shutdown. Adds a small one-time
# cold-start cost (a handful of IF-NOT-EXISTS round-trips); with minScale=1 cold
# starts are rare. Chosen over a deploy-pipeline migrate step because the DB is
# Cloud SQL reachable only from inside Cloud Run (cloudsql-instances socket) —
# GitHub Actions has no network path to it.
set -e

echo "[entrypoint] Running database migrations (drizzle/migrate.mjs)..."
node drizzle/migrate.mjs
echo "[entrypoint] Migrations complete — starting server."

exec "$@"
