#!/usr/bin/env bash
# Run the bot health check and optionally ping Healthchecks.io.
#
# Set HEALTHCHECKS_F3PO_BOT_URL in .env to the full ping URL.

set -euo pipefail

REPO_DIR="${F3PO_REPO_DIR:-/mnt/nas/node/f3po-slack-bot}"
ENV_FILE="$REPO_DIR/.env"

read_env_value() {
  local key="$1"
  if [[ ! -f "$ENV_FILE" ]]; then
    return 0
  fi
  grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true
}

HEALTHCHECKS_URL="$(read_env_value HEALTHCHECKS_F3PO_BOT_URL)"

cd "$REPO_DIR"

if npm run health; then
  if [[ -n "$HEALTHCHECKS_URL" ]]; then
    curl -fsS --max-time 10 "$HEALTHCHECKS_URL" >/dev/null
  fi
else
  status=$?
  if [[ -n "$HEALTHCHECKS_URL" ]]; then
    curl -fsS --max-time 10 "${HEALTHCHECKS_URL%/}/fail" >/dev/null || true
  fi
  exit "$status"
fi
