# Slack Context Bot + RAG

This bot connects Slack Socket Mode, OpenAI, and an OpenAI vector store so Slack users can ask questions against thread context plus an uploaded document library.

For F3, the repo becomes useful after you upload F3-specific docs such as SOPs, AO rules, event notes, FAQs, Q-source summaries, and leadership notes. This is RAG, not model training: the bot gives the model a searchable notebook to reference.

## Requirements

- Node.js
- A Slack app with Socket Mode enabled
- An OpenAI API key
- Documents to upload into an OpenAI vector store

Socket Mode means the bot does not need port forwarding, a public URL, a reverse proxy, or Cloudflare Tunnel. It does need to run continuously on a machine such as a homelab server, Mac mini, Linux box, container, or VPS.

## Install

```sh
npm install
cp .env.example .env
```

Fill in `.env`:

```sh
SLACK_BOT_TOKEN=xoxb...
SLACK_APP_TOKEN=xapp...
SLACK_ALLOWED_CHANNEL_IDS=C1234567890,G1234567890
OPENAI_API_KEY=sk...
OPENAI_MODEL=gpt-5-mini
VECTOR_STORE_ID=vs_...
WEB_SEARCH_ALLOWED_DOMAINS=f3nation.com
LOG_DIR=logs
LOG_RETENTION_DAYS=7
LOG_LEVEL=info
```

`SLACK_ALLOWED_CHANNEL_IDS` is optional. Leave it blank to let the bot answer in any channel it has access to. Set one or more comma-separated channel IDs to limit where the bot answers. Public channel IDs usually start with `C`; private channel IDs usually start with `G`.

The older single-channel variable `SLACK_ALLOWED_CHANNEL_ID` still works, but `SLACK_ALLOWED_CHANNEL_IDS` is preferred.

`WEB_SEARCH_ALLOWED_DOMAINS` is optional. Set it to one or more comma-separated bare domains, such as `f3nation.com`, to let the bot use OpenAI web search on those sites in addition to the vector store. Leave it blank to disable web search. Do not include `https://`.

`LOG_DIR` and `LOG_RETENTION_DAYS` are optional. By default, the bot writes daily log files to `logs/f3po-YYYY-MM-DD.log` and keeps seven days of logs. Old daily logs are cleaned up on startup and once per day while the bot runs.

`LOG_LEVEL` is optional and defaults to `info`. Use `error` for errors only, `info` for startup/cleanup/errors, or `debug` for full interaction logs including questions, answers, and follow-up decisions.

## Slack App Setup

1. Create a Slack app.
2. Add a bot user.
3. Enable Socket Mode.
4. Create an app-level token with the `connections:write` scope and put it in `SLACK_APP_TOKEN`.
5. Add bot scopes such as `app_mentions:read`, `chat:write`, `channels:history`, `channels:read`, `groups:history`, `groups:read`, and `users:read`.
6. Subscribe the bot to events: `app_mention`, `message.channels`, and `message.groups`.
7. Install the app into the workspace.
8. Invite the bot to each channel where it should answer.

## Upload Docs

Put source documents in a local folder, for example:

```text
docs/
  faq.md
  ao-rules.md
  leadership.md
```

Then run:

```sh
npm run rag:setup -- ./docs
```

The script uploads supported files, creates a new OpenAI vector store, waits for indexing, and prints:

```sh
VECTOR_STORE_ID=vs_abc123
```

Copy that value into `.env`.

Supported file extensions are:

```text
.md, .txt, .pdf, .docx, .html, .csv, .json
```

The local folder is your source of truth. The vector store is a disposable search index. For small collections, the simplest update workflow is to edit docs, create a new vector store with `rag_setup.js`, update `VECTOR_STORE_ID`, and restart the bot.

## Run

```sh
npm start
```

Mention the bot in Slack from an allowed channel:

```text
@bot What are the AO naming rules?
```

The bot reads the current Slack thread, searches the vector store first, and replies in-thread. If the thread plus vector store do not contain enough information, it falls back to OpenAI web search over `WEB_SEARCH_ALLOWED_DOMAINS`. If `SLACK_ALLOWED_CHANNEL_IDS` is set and the bot is mentioned somewhere else, it replies with a short nudge to use an allowed channel.

After the bot has replied in a thread, it can also answer follow-up messages in that same thread without another mention. For public channels, Slack must send the `message.channels` event. For private channels, Slack must send the `message.groups` event. It first checks whether the bot already participated, skips obvious acknowledgements like "thanks" or "got it", and uses OpenAI to decide whether ambiguous follow-ups are really directed at the bot.

When `LOG_LEVEL=debug`, the terminal and daily log file record each bot interaction: who asked, which channel/thread it came from, the incoming text, follow-up reply decisions, whether the answer came from the vector store or web fallback, the model/tools used, and the response sent. If `users:read` or `groups:read` are missing, the bot still works but logs Slack IDs instead of friendly names.

## RHEL systemd service

This repo can run as a long-lived `systemd` service on RHEL because Slack Socket Mode only needs outbound access to Slack and OpenAI.

The current deployment path is:

```sh
/mnt/nas/node/f3po-slack-bot
```

Initial setup:

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

Enable and start it:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now f3po-slack-bot.service
```

Useful service commands:

```sh
sudo systemctl status f3po-slack-bot.service
sudo systemctl restart f3po-slack-bot.service
sudo systemctl stop f3po-slack-bot.service
sudo journalctl -u f3po-slack-bot.service -f
```

The app also writes daily logs under:

```sh
/mnt/nas/node/f3po-slack-bot/logs/
```

Watch the app log directly:

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

## Verify

```sh
npm test
```

This currently runs syntax checks for the bot and RAG setup script.
