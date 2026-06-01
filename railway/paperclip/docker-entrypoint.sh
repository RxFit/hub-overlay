#!/bin/sh
set -e

INSTANCE_DIR="/root/.paperclip/instances/default"

mkdir -p "$INSTANCE_DIR"
cp /paperclip/config.json "$INSTANCE_DIR/config.json"

printf 'DATABASE_URL=%s\n' "$DATABASE_URL" > "$INSTANCE_DIR/.env"
printf 'PAPERCLIP_AGENT_JWT_SECRET=%s\n' "$PAPERCLIP_AGENT_JWT_SECRET" >> "$INSTANCE_DIR/.env"
printf 'PAPERCLIP_PUBLIC_URL=https://paperclip-production-4394.up.railway.app\n' >> "$INSTANCE_DIR/.env"
printf 'BETTER_AUTH_TRUSTED_ORIGINS=https://paperclip-production-4394.up.railway.app,https://hub-production-a923.up.railway.app,https://hub.casatrejo.com,https://api.paperclip.casatrejo.com,https://rxfit-paperclip-11747747730.us-central1.run.app\n' >> "$INSTANCE_DIR/.env"
printf 'PORT=3100\n' >> "$INSTANCE_DIR/.env"

# Debug: find the server entrypoint
echo "Searching for Paperclip entrypoints..."
find /root/.local/share/pnpm -name "server*" -type f -o -name "start*" -type f | grep paperclipai || true
ls -la /root/.local/share/pnpm/global/5/node_modules/paperclipai/dist || true
ls -la $(dirname $(which paperclipai)) || true

# Start the CLI run as fallback
echo "Starting fallback run..."
exec paperclipai run --no-repair
