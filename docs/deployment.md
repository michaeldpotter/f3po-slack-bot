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

## BigQuery Access

To let the RHEL server run the BigQuery backblast exporter directly, install and authenticate the Google Cloud CLI:

```sh
cd /mnt/nas/node/f3po-slack-bot
./scripts/setup-rhel-gcloud.sh
```

Then verify:

```sh
npm run backblasts:bigquery:dry-run
```

Create `/etc/systemd/system/f3po-slack-bot.service`:

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

Update an existing deployment:

```sh
cd /mnt/nas/node/f3po-slack-bot
git pull
npm ci
sudo systemctl restart f3po-slack-bot.service
```
