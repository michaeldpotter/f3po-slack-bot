#!/usr/bin/env bash
# Install or update the systemd timer that keeps the local SQLite reporting
# database synced from BigQuery every day at 3 AM.
#
# Why a timer:
# The Slack bot should query a local SQLite database for reports instead of
# hitting BigQuery live on every Slack request. This makes usage predictable and
# gives us a place to enforce privacy/reporting rules.
#
# The timer runs:
#
#   npm run reporting:sync
#
# The systemd service must run as the same Linux user that authenticated Google
# Application Default Credentials with:
#
#   gcloud auth application-default login
#
# By default, this script uses SUDO_USER when invoked via sudo, otherwise USER.
# Override if needed:
#
#   F3PO_SERVICE_USER=mpotter ./scripts/install-reporting-sync-timer.sh
#

set -euo pipefail

REPO_DIR="${F3PO_REPO_DIR:-/mnt/nas/node/f3po-slack-bot}"
SERVICE_USER="${F3PO_SERVICE_USER:-${SUDO_USER:-${USER}}}"
SERVICE_HOME="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
SERVICE_FILE="/etc/systemd/system/f3po-reporting-sync.service"
TIMER_FILE="/etc/systemd/system/f3po-reporting-sync.timer"

if [[ ! -d "$REPO_DIR" ]]; then
  echo "Repo directory not found: $REPO_DIR" >&2
  exit 1
fi

if [[ -z "$SERVICE_HOME" ]]; then
  echo "Could not determine home directory for user: $SERVICE_USER" >&2
  exit 1
fi

echo "Installing reporting sync systemd service..."
sudo tee "$SERVICE_FILE" >/dev/null <<EOF
[Unit]
Description=F3PO BigQuery to SQLite reporting sync
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$SERVICE_USER
Environment=HOME=$SERVICE_HOME
WorkingDirectory=$REPO_DIR
ExecStart=/usr/bin/npm run reporting:sync
EOF

echo "Installing reporting sync timer..."
sudo tee "$TIMER_FILE" >/dev/null <<EOF
[Unit]
Description=Run F3PO reporting sync daily at 3 AM

[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true
Unit=f3po-reporting-sync.service

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now f3po-reporting-sync.timer

echo "Installed timer:"
systemctl list-timers f3po-reporting-sync.timer --no-pager
echo
echo "Run an immediate sync with:"
echo "  sudo systemctl start f3po-reporting-sync.service"
echo
echo "View logs with:"
echo "  sudo journalctl -u f3po-reporting-sync.service -n 100 --no-pager"
