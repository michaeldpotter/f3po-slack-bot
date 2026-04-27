#!/usr/bin/env bash
# Copy local Google Application Default Credentials to a server.
#
# This is a convenience path when you cannot create a service account and the
# server cannot easily complete `gcloud auth application-default login`.
#
# IMPORTANT:
# - This copies your personal Google ADC refresh credentials.
# - Only use this for a server/user you trust.
# - The target file is chmod 600.
# - If your Google access is revoked or expires, rerun auth/copy.
#
# Usage:
#
#   ./scripts/copy-local-gcloud-adc-to-server.sh rhel10mdp01
#   ./scripts/copy-local-gcloud-adc-to-server.sh mpotter@new-server.example.com
#
# Optional:
#
#   GOOGLE_APPLICATION_CREDENTIALS=/path/to/application_default_credentials.json ./scripts/copy-local-gcloud-adc-to-server.sh rhel10mdp01
#   F3PO_REPO_DIR=/mnt/nas/node/f3po-slack-bot ./scripts/copy-local-gcloud-adc-to-server.sh rhel10mdp01
#

set -euo pipefail

TARGET_HOST="${1:-}"
LOCAL_ADC="${GOOGLE_APPLICATION_CREDENTIALS:-$HOME/.config/gcloud/application_default_credentials.json}"
REMOTE_GCLOUD_DIR=".config/gcloud"
REMOTE_ADC_PATH="$REMOTE_GCLOUD_DIR/application_default_credentials.json"
REPO_DIR="${F3PO_REPO_DIR:-/mnt/nas/node/f3po-slack-bot}"

if [[ -z "$TARGET_HOST" ]]; then
  echo "Usage: $0 user@host-or-host-alias" >&2
  exit 1
fi

if [[ ! -f "$LOCAL_ADC" ]]; then
  echo "Local ADC file not found: $LOCAL_ADC" >&2
  echo "Run: gcloud auth application-default login" >&2
  exit 1
fi

cat <<EOF
About to copy Google Application Default Credentials.

  local:  $LOCAL_ADC
  target: $TARGET_HOST:~/$REMOTE_ADC_PATH

This grants the target server/user the same BigQuery access as your local ADC.
EOF

read -r -p "Continue? Type YES: " confirmation
if [[ "$confirmation" != "YES" ]]; then
  echo "Aborted."
  exit 1
fi

ssh "$TARGET_HOST" "mkdir -p '$REMOTE_GCLOUD_DIR' && chmod 700 '$REMOTE_GCLOUD_DIR'"
scp "$LOCAL_ADC" "$TARGET_HOST:$REMOTE_ADC_PATH"
ssh "$TARGET_HOST" "chmod 600 '$REMOTE_ADC_PATH'"

echo "ADC copied. Testing reporting sync dry run if repo exists at $REPO_DIR..."
ssh "$TARGET_HOST" "if [ -d '$REPO_DIR' ]; then cd '$REPO_DIR' && npm run reporting:sync:dry-run; else echo 'Repo not found at $REPO_DIR; skipping test.'; fi"
