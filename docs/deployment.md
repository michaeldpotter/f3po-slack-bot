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
npm run reporting:health
```

To keep the local SQLite reporting database fresh, install the daily 3 AM reporting sync timer:

```sh
./scripts/install-reporting-sync-timer.sh
```

If using Healthchecks.io, put the full ping URL in `.env` before installing or reinstalling the timer:

```sh
HEALTHCHECKS_REPORTING_SYNC_URL=https://hc-ping.com/your-uuid
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
The service is configured to restart automatically, use `.env` as an `EnvironmentFile`, and cap memory usage with `MemoryMax`.

Manual equivalent:

```ini
[Unit]
Description=F3PO Slack Bot
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
User=mpotter
WorkingDirectory=/mnt/nas/node/f3po-slack-bot
EnvironmentFile=/mnt/nas/node/f3po-slack-bot/.env
ExecStart=/usr/bin/node app.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
MemoryMax=512M
TimeoutStopSec=20
KillSignal=SIGTERM

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

## Health Monitoring

The bot writes a heartbeat/status file while it is running. The default path is:

```sh
tmp/f3po-status.json
```

Run a local health check from the RHEL server:

```sh
cd /mnt/nas/node/f3po-slack-bot
npm run health
npm run health -- --json
npm run health:deep
```

The normal health check validates the heartbeat age, required env vars, and readable SQLite files. The deep check also verifies the OpenAI vector store and F3 Nation API when configured.

Install the every-minute health timer:

```sh
./scripts/install-f3po-health-timer.sh
```

Optional Healthchecks.io bot monitoring:

```sh
HEALTHCHECKS_F3PO_BOT_URL=https://hc-ping.com/your-check-id
```

The wrapper pings the base URL on success and `/fail` when `npm run health` fails.

You can also ask the bot in Slack:

```text
@F3PO status
@F3PO config
@F3PO vectorstore
@F3PO last error
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
