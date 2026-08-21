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

# PINNED agy install (hardening move 2): exact artifact + IN-REPO sha512 from
# scripts/agy/agy-version.lock, replacing curl|bash "latest" whose version was
# Docker-cache-controlled (how 1.1.16 arrived untested and produced the first
# dispatch `parse` failure). Changing the lock busts this layer — an upgrade
# is now a deliberate PR (scripts/agy/update-agy-pin.sh + Phase 0 replay).
COPY --chown=agyuser:agyuser scripts/agy/agy-version.lock /tmp/agy-version.lock
RUN . /tmp/agy-version.lock \
 && echo "installing pinned agy ${AGY_VERSION}" \
 && mkdir -p /home/agyuser/.local/bin \
 && curl -fsSL -o /tmp/agy.tar.gz "${AGY_URL}" \
 && echo "${AGY_SHA512}  /tmp/agy.tar.gz" | sha512sum -c - \
 && tar -xzf /tmp/agy.tar.gz -C /tmp antigravity \
 && mv /tmp/antigravity /home/agyuser/.local/bin/agy \
 && chmod +x /home/agyuser/.local/bin/agy \
 && rm -f /tmp/agy.tar.gz /tmp/agy-version.lock \
 && /home/agyuser/.local/bin/agy --version || true
ENV PATH="/home/agyuser/.local/bin:${PATH}"

WORKDIR /home/agyuser/hub
COPY --chown=agyuser:agyuser hub/package.json hub/package-lock.json ./
RUN npm ci
COPY --chown=agyuser:agyuser hub/ ./

ARG WORKER_GIT_SHA=dev
ENV WORKER_GIT_SHA=${WORKER_GIT_SHA}

ENTRYPOINT ["npx", "tsx", "scripts/dispatch-worker.ts"]
