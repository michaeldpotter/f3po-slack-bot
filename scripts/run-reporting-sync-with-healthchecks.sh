#!/usr/bin/env bash
# Run the BigQuery -> SQLite reporting sync and optionally report the result to
# Healthchecks.io.
#
# Healthchecks wiring:
# - Set HEALTHCHECKS_REPORTING_SYNC_URL in .env to the full Healthchecks ping URL.
# - The URL is a secret. Do not commit it.
# - When configured, this wrapper sends:
#     <url>/start  before the sync starts
#     <url>        after sync + health check succeeds
#     <url>/fail   if either sync or health check fails
#
# This wrapper is what the systemd timer should run. It keeps the timer focused
# on one operational question: "Did the daily reporting database refresh work?"

set -euo pipefail

REPO_DIR="${F3PO_REPO_DIR:-$(pwd)}"
ENV_FILE="${F3PO_ENV_FILE:-$REPO_DIR/.env}"

cd "$REPO_DIR"

read_env_value() {
  local key="$1"
  if [[ -n "${!key:-}" ]]; then
    printf '%s' "${!key}"
    return
  fi

  if [[ -f "$ENV_FILE" ]]; then
    local line
    line="$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1 || true)"
    if [[ -n "$line" ]]; then
      local value="${line#*=}"
      value="${value%\"}"
      value="${value#\"}"
      value="${value%\'}"
      value="${value#\'}"
      printf '%s' "$value"
    fi
  fi
}

HEALTHCHECKS_URL="$(read_env_value HEALTHCHECKS_REPORTING_SYNC_URL)"

ping_healthchecks() {
  local suffix="${1:-}"
  local body="${2:-}"

  if [[ -z "$HEALTHCHECKS_URL" ]]; then
    return
  fi

  if ! curl -fsS --retry 3 --max-time 10 -X POST "${HEALTHCHECKS_URL}${suffix}" \
    --data-binary "$body" >/dev/null; then
    echo "Warning: Healthchecks ping failed for suffix '${suffix:-success}'." >&2
  fi
}

run_output=""
run_status=0

ping_healthchecks "/start" "F3PO reporting sync started on $(hostname) at $(date -Is)."

set +e
run_output="$(
  {
    echo "Running reporting sync..."
    npm run reporting:sync
    echo
    echo "Running reporting health check..."
    npm run reporting:health
  } 2>&1
)"
run_status=$?
set -e

printf '%s\n' "$run_output"

if [[ "$run_status" -eq 0 ]]; then
  ping_healthchecks "" "$run_output"
  exit 0
fi

ping_healthchecks "/fail" "$run_output"
exit "$run_status"
