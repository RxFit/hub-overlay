# Desktop dispatch worker (Phase 2.5 PR 2) — runs on the operator's Docker
# Desktop, NEVER on Cloud Run. Derived from scripts/agy/Dockerfile.phase0:
# node:22-slim + util-linux (`script` pty) + non-root agyuser, agy installed at
# build time with auto-update pinned off. The hub package is COPYed from the
# local checkout so lib/agy.ts and lib/dispatch-worker.ts run verbatim —
# no Artifact Registry auth and NO DATABASE_URL ever reach this machine
# (the worker speaks only HTTPS to /api/worker/*).
#
# BUILD (from the repo root, which is the compose context):
#   docker compose -f scripts/agy-worker/docker-compose.yml build
# The nightly update task rebuilds from freshly-pulled master, stamping
# WORKER_GIT_SHA so dispatch-health can show drift vs the Hub's GIT_SHA.

FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl util-linux procps git \
 && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash agyuser
ENV AGY_CLI_DISABLE_AUTO_UPDATE=true
USER agyuser
WORKDIR /home/agyuser
ENV HOME=/home/agyuser

RUN curl -fsSL https://antigravity.google/cli/install.sh | bash \
 && /home/agyuser/.local/bin/agy --version || true
ENV PATH="/home/agyuser/.local/bin:${PATH}"

WORKDIR /home/agyuser/hub
COPY --chown=agyuser:agyuser hub/package.json hub/package-lock.json ./
RUN npm ci
COPY --chown=agyuser:agyuser hub/ ./

ARG WORKER_GIT_SHA=dev
ENV WORKER_GIT_SHA=${WORKER_GIT_SHA}

ENTRYPOINT ["npx", "tsx", "scripts/dispatch-worker.ts"]
