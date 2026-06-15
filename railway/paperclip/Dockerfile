# syntax = docker/dockerfile:1

ARG NODE_VERSION=20
FROM node:${NODE_VERSION}-slim AS base

LABEL fly_launch_runtime="Node.js"

# Enable pnpm via corepack (built into Node 20)
RUN corepack enable && corepack prepare pnpm@9 --activate
ENV PNPM_HOME="/root/.local/share/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

WORKDIR /app

# Install Paperclip globally from npm
RUN pnpm add -g paperclipai@2026.609.0

# Set up Paperclip instance directory
ENV PAPERCLIP_INSTANCE_DIR=/paperclip
RUN mkdir -p /paperclip/data/storage /paperclip/secrets /paperclip/logs /paperclip/db \
    /root/.paperclip/instances/default

# Copy instance config
COPY config.json /paperclip/config.json

EXPOSE 3100

# Health check — Paperclip mounts health under the /api router
# (GET /health returns 404; the watchdog scripts already use /api/health)
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:3100/api/health || exit 1

# Entrypoint: write master.key from env var, then start paperclip
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

ENTRYPOINT ["/docker-entrypoint.sh"]
