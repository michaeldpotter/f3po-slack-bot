# Deployment

This repo can run as a long-lived `systemd` service on RHEL because Slack Socket Mode only needs outbound access to Slack and OpenAI.

Current deployment path:

```sh
/mnt/nas/node/f3po-slack-bot
```

## Initial Setup

```sh
sudo mkdir -p /mnt/nas/node
sudo chown "$USER:$USER" /mnt/nas/node
git clone https://github.com/michaeldpotter/f3po-slack-bot.git /mnt/nas/node/f3po-slack-bot
cd /mnt/nas/node/f3po-slack-bot
npm ci
cp .env.example .env
chmod 600 .env
```

Edit `.env` with the real Slack/OpenAI values before starting the service.

For a more complete new-server checklist, see [Server Migration Runbook](server-migration.md).

## BigQuery Access

To let the RHEL server sync BigQuery data into the local SQLite reporting database, install and authenticate the Google Cloud CLI:

```sh
cd /mnt/nas/node/f3po-slack-bot
./scripts/setup-rhel-gcloud.sh
```

Then verify:

```sh
npm run reporting:sync:dry-run
```

To keep the local SQLite reporting database fresh, install the daily 3 AM reporting sync timer:

```sh
./scripts/install-reporting-sync-timer.sh
```

Run the timer under the same user that authenticated `gcloud`. Override the service user if needed:

```sh
F3PO_SERVICE_USER=mpotter ./scripts/install-reporting-sync-timer.sh
```

Install the Slack bot service with:

```sh
./scripts/install-f3po-service.sh
```

The script writes `/etc/systemd/system/f3po-slack-bot.service`, reloads systemd, enables the service, and starts it.

Manual equivalent:

```ini
[Unit]
Description=F3PO Slack Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=mpotter
WorkingDirectory=/mnt/nas/node/f3po-slack-bot
ExecStart=/usr/bin/node app.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Enable and start:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now f3po-slack-bot.service
```

Useful commands:

```sh
sudo systemctl status f3po-slack-bot.service
sudo systemctl restart f3po-slack-bot.service
sudo systemctl stop f3po-slack-bot.service
sudo journalctl -u f3po-slack-bot.service -f
```

Watch app logs:

```sh
tail -f /mnt/nas/node/f3po-slack-bot/logs/f3po-$(date +%F).log
```

Search bot question/response history:

```sh
cd /mnt/nas/node/f3po-slack-bot
npm run interactions:search -- "IronPax"
```

The interaction database defaults to `export/google/f3po-conversations.sqlite` and is ignored by Git.

Update an existing deployment:

```sh
cd /mnt/nas/node/f3po-slack-bot
git pull
npm ci
sudo systemctl restart f3po-slack-bot.service
```
