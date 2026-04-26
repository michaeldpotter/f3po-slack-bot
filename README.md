# Slack Context Bot + RAG

This bot connects Slack Socket Mode, OpenAI, and an OpenAI vector store so Slack users can ask questions against thread context plus an uploaded document library.

For F3, the repo becomes useful after you upload F3-specific docs such as SOPs, AO rules, event notes, FAQs, Q-source summaries, and leadership notes. This is RAG, not model training: the bot gives the model a searchable notebook to reference.

## How it works

The bot runs continuously on a server and listens to Slack through Socket Mode.

```text
Slack Workspace
  -> Slack Socket Mode
  -> Your Bot Server
  -> OpenAI API
  -> Vector Store / Web Search
```

When someone asks a question, the bot can:

1. Read the current Slack thread context.
2. Search uploaded documents in an OpenAI vector store.
3. Fall back to allowed website search when the vector store does not have enough context.
4. Send the relevant context to OpenAI.
5. Reply in Slack.

The repo itself is not trained on F3. It becomes F3-aware when you upload F3-related documents such as F3 Nation docs, Wichita region SOPs, AO naming rules, event rules, FAQs, Q-source summaries, leadership notes, meeting notes, or Slack summaries.

Useful example questions:

```text
@bot What are AO naming rules?
@bot What was decided in this thread?
@bot Summarize this conversation.
@bot What are the requirements for a convergence?
```

## RAG, not training

RAG means Retrieval-Augmented Generation. Instead of answering from model memory alone, the bot first retrieves relevant reference material and gives that material to the model.

```text
Without RAG:
Question -> AI answers from memory

With RAG:
Question -> Search docs -> Give docs to AI -> Answer
```

This is not model training. You are not creating a new model, permanently teaching OpenAI, or fine-tuning. You are giving the model a searchable reference library.

Think of it this way:

```text
Training = changing the brain
RAG = giving it a notebook to reference
```

For this project:

```text
Folder = source of truth
Vector Store = disposable search index
Bot = Slack interface to search + AI
```

## API costs

The bot uses your OpenAI API key. A ChatGPT Plus subscription does not cover API usage.

Small internal usage is usually inexpensive, but heavy usage can become noticeable because every bot request consumes API tokens. Lower-cost model choices such as `gpt-5-mini` are a good default for this kind of internal helper bot.

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
VECTOR_STORE_SOURCE_DIR=VectorStore
VECTOR_STORE_RESTART_SERVICE=f3po-slack-bot.service
WEB_SEARCH_ALLOWED_DOMAINS=f3nation.com
LOG_DIR=logs
LOG_RETENTION_DAYS=7
LOG_LEVEL=info
```

`SLACK_ALLOWED_CHANNEL_IDS` is optional. Leave it blank to let the bot answer in any channel it has access to. Set one or more comma-separated channel IDs to limit where the bot answers. Public channel IDs usually start with `C`; private channel IDs usually start with `G`.

The older single-channel variable `SLACK_ALLOWED_CHANNEL_ID` still works, but `SLACK_ALLOWED_CHANNEL_IDS` is preferred.

`WEB_SEARCH_ALLOWED_DOMAINS` is optional. Set it to one or more comma-separated bare domains, such as `f3nation.com`, to let the bot use OpenAI web search on those sites in addition to the vector store. Leave it blank to disable web search. Do not include `https://`.

`VECTOR_STORE_SOURCE_DIR` is optional and defaults to `VectorStore`. It is the folder `rag_setup.js` reads when rebuilding or updating the OpenAI vector store without an explicit folder argument.

`VECTOR_STORE_RESTART_SERVICE` is optional and defaults to `f3po-slack-bot.service`. After `rag:rebuild` updates `.env`, the script restarts this systemd service on Linux so the bot picks up the new `VECTOR_STORE_ID`. Set it to `none` to disable automatic restart.

`LOG_DIR` and `LOG_RETENTION_DAYS` are optional. By default, the bot writes daily log files to `logs/f3po-YYYY-MM-DD.log` and keeps seven days of logs. Old daily logs are cleaned up on startup and once per day while the bot runs.

`LOG_LEVEL` is optional and defaults to `info`. Use `error` for errors only, `info` for startup/cleanup/errors, or `debug` for full interaction logs including questions, answers, and follow-up decisions.

`node_modules/` is created by `npm install` or `npm ci`. It contains dependencies such as Slack Bolt, the OpenAI SDK, websocket packages, and their transitive dependencies. Do not commit `node_modules/`; it can be rebuilt from `package.json` and `package-lock.json`.

The `logs/` folder is committed with a `.gitkeep` placeholder so the app always has a standard place to write logs. Actual daily log files are ignored by Git.

If you fork this repo, a typical setup flow is:

```text
Fork repo on GitHub
  -> Clone your fork
  -> Run npm install or npm ci
  -> Configure .env
  -> Upload docs and set VECTOR_STORE_ID
  -> Run the bot
```

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

Put source documents in `VectorStore/`. The repo includes `VectorStore/F3 Nation Documents/` as a shared document set. Local/private document folders can live beside it, but should be ignored if they should not be committed.

Current repo policy:

```text
VectorStore/
  F3 Nation Documents/      committed
  F3 Wichita Documents/     ignored
logs/
  .gitkeep                  committed
  f3po-YYYY-MM-DD.log       ignored
f3po_slack_profile_pic.png  committed
```

Supported file extensions are:

```text
.md, .txt, .pdf, .docx, .html, .csv, .json
```

After upload, OpenAI keeps an indexed searchable copy of the files in your account. The files also remain on your local system.

The local folder is your source of truth. The vector store is a disposable search index.

The RAG setup script has two main modes:

```sh
npm run rag:rebuild
npm run rag:add
```

`npm run rag:setup` still works as a backward-compatible alias for rebuild behavior.

### Rebuild the vector store

Use rebuild when you want a clean OpenAI vector store made from the local source folder.

```sh
npm run rag:rebuild
```

This defaults to:

```sh
VectorStore
```

The script:

1. Finds supported documents in `VECTOR_STORE_SOURCE_DIR`.
2. Uploads them to OpenAI file storage.
3. Creates a new OpenAI vector store.
4. Adds the uploaded files to that vector store.
5. Waits for indexing to finish.
6. Updates `VECTOR_STORE_ID` in `.env`.
7. Restarts `VECTOR_STORE_RESTART_SERVICE` on Linux when systemd is available.
8. Prints the new `VECTOR_STORE_ID`.

```sh
VECTOR_STORE_ID=vs_abc123
```

You can also pass a folder explicitly:

```sh
npm run rag:rebuild -- ./VectorStore
```

Or rebuild only from one document folder:

```sh
npm run rag:rebuild -- "./VectorStore/F3 Nation Documents"
```

After rebuild, the script restarts `f3po-slack-bot.service` automatically on RHEL so the running process reads the updated `VECTOR_STORE_ID` from `.env`.

If automatic restart is disabled or systemd is not available, restart the bot manually:

```sh
sudo systemctl restart f3po-slack-bot.service
```

### Add new or changed documents

Use add when you want to keep the existing vector store and only add files that are new or changed locally.

```sh
npm run rag:add
```

`rag:add` uses the current `VECTOR_STORE_ID` from `.env`. Uploaded files are tagged with their source path and content hash. If a local file is unchanged, it is skipped. If a local file changed, the old vector store entry for that source path is removed and the updated file is uploaded.

This mode does not remove OpenAI file-storage objects; it only removes replaced files from the vector store index. Use rebuild when you want the cleanest index.

You can also add from a specific folder:

```sh
npm run rag:add -- "./VectorStore/F3 Nation Documents"
```

Use `rag:add` for normal document maintenance:

```text
Add or edit a document
  -> npm run rag:add
  -> keep the same VECTOR_STORE_ID
  -> no bot restart required
```

Use `rag:rebuild` when you want to replace the whole searchable index:

```text
Large doc cleanup or fresh setup
  -> npm run rag:rebuild
  -> .env gets a new VECTOR_STORE_ID
  -> systemd service restarts automatically on RHEL
```

The script also supports direct usage:

```sh
node rag_setup.js --help
node rag_setup.js rebuild ./VectorStore
node rag_setup.js add ./VectorStore
```

Recommended first test:

```text
VectorStore/
  faq.md
  ao-rules.md
  leadership.md
```

Then:

```sh
npm run rag:rebuild
```

Start the bot and ask questions in Slack.

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
