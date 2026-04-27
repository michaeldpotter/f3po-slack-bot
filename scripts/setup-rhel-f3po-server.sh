#!/usr/bin/env bash
# High-level helper for bringing up a new RHEL F3PO server from an existing repo checkout.
#
# This script intentionally does NOT create or copy .env secrets. You still need
# to provide .env yourself, because it contains Slack/OpenAI tokens.
#
# Typical new-server flow:
#
#   sudo mkdir -p /mnt/nas/node
#   sudo chown "$USER:$USER" /mnt/nas/node
#   git clone https://github.com/michaeldpotter/f3po-slack-bot.git /mnt/nas/node/f3po-slack-bot
#   cd /mnt/nas/node/f3po-slack-bot
#   cp .env.example .env
#   vi .env
#   ./scripts/setup-rhel-f3po-server.sh
#
# What it does:
# - installs npm dependencies with `npm ci`
# - optionally installs Google Cloud CLI
# - installs/starts the F3PO Slack bot systemd service
# - optionally installs the 3 AM reporting sync timer
# - runs tests along the way
#

set -euo pipefail

REPO_DIR="${F3PO_REPO_DIR:-$(pwd)}"

if [[ ! -f "$REPO_DIR/package.json" || ! -f "$REPO_DIR/app.js" ]]; then
  echo "Run this from the repo root, or set F3PO_REPO_DIR=/path/to/f3po-slack-bot." >&2
  exit 1
fi

cd "$REPO_DIR"

if [[ ! -f .env ]]; then
  echo "Missing .env. Copy .env.example to .env and fill in secrets before continuing." >&2
  exit 1
fi

echo "Installing npm dependencies..."
npm ci

echo "Running checks..."
npm test

read -r -p "Install/update Google Cloud CLI on this server? [y/N] " install_gcloud
if [[ "$install_gcloud" =~ ^[Yy]$ ]]; then
  ./scripts/setup-rhel-gcloud.sh
fi

echo "Installing F3PO Slack bot service..."
./scripts/install-f3po-service.sh

read -r -p "Install daily 3 AM reporting sync timer? [y/N] " install_timer
if [[ "$install_timer" =~ ^[Yy]$ ]]; then
  ./scripts/install-reporting-sync-timer.sh
fi

echo "Server setup complete."
echo
echo "Useful checks:"
echo "  systemctl status f3po-slack-bot.service --no-pager"
echo "  npm run reporting:sync:dry-run"
