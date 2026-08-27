# node:22 to match CI (ci.yml uses Node 22) and hub/package.json "engines.node".
# Previously node:20 — CI tested on 22 while the container shipped 20, so the
# runtime differed from what CI validated.
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# Ensure the migrate-then-serve entrypoint is executable (COPY preserves the git
# mode, but set it explicitly so the image is correct regardless of checkout).
RUN chmod +x docker-entrypoint.sh

# Antigravity CLI (agy): the lib/agy.ts gateway provisions the binary at
# RUNTIME (lazy, checksum-verified, first use per instance) — deliberately NOT
# here. A build-time download coupled `gcloud run deploy` to the undocumented
# third-party release server and broke the deploy pipeline (2026-08-14); a
# runtime failure instead surfaces as a typed error in /api/admin/agy-health
# while deploys stay independent. scripts/install-agy.mjs remains for local
# prebakes. The auto-updater stays off so a provisioned binary never replaces
# itself mid-request.
ENV AGY_CLI_DISABLE_AUTO_UPDATE=true

# Server source maps resolve at RUNTIME (ERROR_REPORTING_2026-08-24.md §5):
# next.config.js emits them (experimental.serverSourceMaps) and this flag makes
# Node apply them, so production stack frames point at real source files
# instead of .next/server/chunks/*.js. Set after the build stage — build time
# needs no map resolution.
ENV NODE_OPTIONS="--enable-source-maps"

EXPOSE 3000

# Run DB migrations before serving (see docker-entrypoint.sh); CMD is exec'd by
# the entrypoint after migrations succeed.
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["npm", "start"]
