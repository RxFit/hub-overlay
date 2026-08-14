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

# Antigravity CLI (agy) — the lib/agy.ts execution gateway spawns it at request
# time. Checksum-verified against the release manifest (see scripts/install-agy.mjs);
# upstream serves "latest" only, so the auto-updater is disabled at runtime to keep
# the binary immutable per image.
RUN node scripts/install-agy.mjs /usr/local/bin/agy
ENV AGY_CLI_DISABLE_AUTO_UPDATE=true

EXPOSE 3000

# Run DB migrations before serving (see docker-entrypoint.sh); CMD is exec'd by
# the entrypoint after migrations succeed.
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["npm", "start"]
