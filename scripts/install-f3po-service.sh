#!/usr/bin/env bash
# Install or update the long-running F3PO Slack bot systemd service.
#
# Run this on the RHEL server from inside the repo checkout:
#
#   cd /mnt/nas/node/f3po-slack-bot
#   ./scripts/install-f3po-service.sh
#
# Useful overrides:
#
#   F3PO_REPO_DIR=/opt/f3po-slack-bot ./scripts/install-f3po-service.sh
#   F3PO_SERVICE_USER=mpotter ./scripts/install-f3po-service.sh
#   F3PO_SERVICE_NAME=f3po-slack-bot.service ./scripts/install-f3po-service.sh
#
# The service runs the bot continuously with Slack Socket Mode. It assumes:
# - npm dependencies have already been installed with `npm ci`
# - .env exists in the repo directory
# - .env contains valid Slack/OpenAI settings and VECTOR_STORE_ID

set -euo pipefail

REPO_DIR="${F3PO_REPO_DIR:-/mnt/nas/node/f3po-slack-bot}"
SERVICE_USER="${F3PO_SERVICE_USER:-${SUDO_USER:-${USER}}}"
SERVICE_NAME="${F3PO_SERVICE_NAME:-f3po-slack-bot.service}"
SERVICE_FILE="/etc/systemd/system/$SERVICE_NAME"
NODE_BIN="${F3PO_NODE_BIN:-$(command -v node)}"

if [[ ! "$SERVICE_NAME" =~ ^[A-Za-z0-9_.@:-]+\.service$ ]]; then
  echo "Invalid systemd service name: $SERVICE_NAME" >&2
  exit 1
fi

if [[ ! -d "$REPO_DIR" ]]; then
  echo "Repo directory not found: $REPO_DIR" >&2
  exit 1
fi

if [[ ! -f "$REPO_DIR/app.js" ]]; then
  echo "Expected app.js in repo directory: $REPO_DIR" >&2
  exit 1
fi

if [[ ! -f "$REPO_DIR/.env" ]]; then
  echo "Missing .env in $REPO_DIR. Copy .env.example to .env and fill it in before installing the service." >&2
  exit 1
fi

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "Could not find executable node binary. Set F3PO_NODE_BIN=/path/to/node." >&2
  exit 1
fi

echo "Installing $SERVICE_NAME"
echo "  repo: $REPO_DIR"
echo "  user: $SERVICE_USER"
echo "  node: $NODE_BIN"

sudo tee "$SERVICE_FILE" >/dev/null <<EOF
[Unit]
Description=F3PO Slack Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$REPO_DIR
ExecStart=$NODE_BIN app.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now "$SERVICE_NAME"

echo "Installed service:"
systemctl status "$SERVICE_NAME" --no-pager
