#!/usr/bin/env bash
# Install a systemd timer that runs npm run health for the bot every minute.

set -euo pipefail

REPO_DIR="${F3PO_REPO_DIR:-/mnt/nas/node/f3po-slack-bot}"
SERVICE_USER="${F3PO_SERVICE_USER:-${SUDO_USER:-${USER}}}"
SERVICE_FILE="/etc/systemd/system/f3po-bot-health.service"
TIMER_FILE="/etc/systemd/system/f3po-bot-health.timer"

if [[ ! -d "$REPO_DIR" ]]; then
  echo "Repo directory not found: $REPO_DIR" >&2
  exit 1
fi

sudo tee "$SERVICE_FILE" >/dev/null <<EOF
[Unit]
Description=F3PO Bot Health Check

[Service]
Type=oneshot
User=$SERVICE_USER
WorkingDirectory=$REPO_DIR
EnvironmentFile=$REPO_DIR/.env
ExecStart=$REPO_DIR/scripts/run-f3po-health-with-healthchecks.sh
EOF

sudo tee "$TIMER_FILE" >/dev/null <<EOF
[Unit]
Description=Run F3PO Bot Health Check

[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
Unit=f3po-bot-health.service

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now f3po-bot-health.timer

systemctl list-timers f3po-bot-health.timer --no-pager
