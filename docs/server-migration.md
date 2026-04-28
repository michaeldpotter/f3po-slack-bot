# Server Migration Runbook

Use this when moving F3PO to a new RHEL-compatible server.

The repo contains scripts that make the server setup repeatable. They deliberately do not commit or generate secrets. `.env` and Google credentials are still local/server-only.

## What Gets Installed

- npm dependencies from `package-lock.json`
- F3PO Slack bot systemd service
- F3PO bot health check systemd timer
- optional Google Cloud CLI for BigQuery access
- optional 3 AM reporting sync systemd timer
- optional local Google Application Default Credentials copy

## New Server Setup

On the new server:

```sh
sudo mkdir -p /mnt/nas/node
sudo chown "$USER:$USER" /mnt/nas/node
git clone https://github.com/michaeldpotter/f3po-slack-bot.git /mnt/nas/node/f3po-slack-bot
cd /mnt/nas/node/f3po-slack-bot
cp .env.example .env
chmod 600 .env
```

Edit `.env` with real Slack/OpenAI/vector store values before installing services.
If using Healthchecks.io for bot uptime, set `HEALTHCHECKS_F3PO_BOT_URL` in `.env` before installing the health timer.

Then run:

```sh
./scripts/setup-rhel-f3po-server.sh
```

That script:

1. Runs `npm ci`.
2. Runs `npm test`.
3. Optionally installs Google Cloud CLI.
4. Installs/starts `f3po-slack-bot.service`.
5. Optionally installs the 3 AM reporting sync timer.

Install the bot health timer after setup:

```sh
./scripts/install-f3po-health-timer.sh
```

## BigQuery Credentials

Preferred, if available:

- create a read-only service account
- set `GOOGLE_APPLICATION_CREDENTIALS` to the service account key path

Current practical option:

- authenticate the server user with Google Application Default Credentials

On the server:

```sh
gcloud auth application-default login
gcloud config set project f3data
cd /mnt/nas/node/f3po-slack-bot
npm run reporting:sync:dry-run
npm run reporting:health
```

If interactive auth on the server is awkward, copy your local ADC file from your Mac:

```sh
./scripts/copy-local-gcloud-adc-to-server.sh rhel10mdp01
```

This copies:

```text
~/.config/gcloud/application_default_credentials.json
```

to the target server user's:

```text
~/.config/gcloud/application_default_credentials.json
```

That file is sensitive. Only copy it to a server/user you trust.

## Individual Scripts

Install Google Cloud CLI on RHEL:

```sh
./scripts/setup-rhel-gcloud.sh
```

Install the Slack bot service:

```sh
./scripts/install-f3po-service.sh
```

Install the every-minute bot health timer:

```sh
./scripts/install-f3po-health-timer.sh
```

Install the 3 AM reporting sync timer:

```sh
./scripts/install-reporting-sync-timer.sh
```

Copy local ADC credentials to a server:

```sh
./scripts/copy-local-gcloud-adc-to-server.sh user@server
```

## Service Checks

```sh
systemctl status f3po-slack-bot.service --no-pager
systemctl list-timers f3po-bot-health.timer --no-pager
systemctl list-timers f3po-reporting-sync.timer --no-pager
sudo journalctl -u f3po-slack-bot.service -n 100 --no-pager
sudo journalctl -u f3po-bot-health.service -n 100 --no-pager
sudo journalctl -u f3po-reporting-sync.service -n 100 --no-pager
```

## Data Checks

```sh
npm run health
npm run health:deep
npm run reporting:sync:dry-run
npm run reporting:sync:full
npm run reporting:health
```

The local SQLite reporting database lives at:

```text
export/google/f3po-reporting.sqlite
```

That path is ignored by Git.
