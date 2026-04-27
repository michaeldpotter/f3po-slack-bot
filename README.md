# Slack Context Bot + RAG

F3PO connects Slack Socket Mode, OpenAI, and an OpenAI vector store so Slack users can ask questions against thread context plus an uploaded document library.

This is RAG, not model training: the repo gives the model a searchable notebook to reference. F3PO becomes F3-aware when you upload F3-specific docs such as SOPs, AO rules, event notes, FAQs, Q-source summaries, leadership notes, meeting notes, and YouTube summaries.

## How It Works

```text
Slack Workspace
  -> Slack Socket Mode
  -> F3PO
  -> OpenAI API
  -> Vector Store / Web Search
```

When someone asks a question, the bot can:

1. Read the current Slack thread context.
2. Search uploaded documents in an OpenAI vector store.
3. Fall back to allowed website search when the vector store does not have enough context.
4. Send the relevant context to OpenAI.
5. Reply in Slack.

Useful example questions:

```text
@bot What are AO naming rules?
@bot What was decided in this thread?
@bot Summarize this conversation.
@bot What are the requirements for a convergence?
```

## Requirements

- Node.js
- A Slack app with Socket Mode enabled
- An OpenAI API key
- Documents under `vectorstore/` to upload into an OpenAI vector store
- Optional for local reporting sync: Google Cloud CLI (`gcloud`) and access to the F3 data project

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
VECTOR_STORE_SOURCE_DIR=vectorstore
VECTOR_STORE_RESTART_SERVICE=f3po-slack-bot.service
WEB_SEARCH_ALLOWED_DOMAINS=f3nation.com
GOOGLE_CLOUD_PROJECT=f3data
LOG_DIR=logs
LOG_RETENTION_DAYS=7
LOG_LEVEL=info
INTERACTION_DB_PATH=export/google/f3po-conversations.sqlite
INTERACTION_RETENTION_DAYS=90
MESSAGE_DEDUPE_TTL_MS=300000
QUESTION_DEDUPE_TTL_MS=120000
THREAD_REPLY_LIMIT=4
THREAD_REPLY_LIMIT_WINDOW_MS=60000
```

Key env notes:

- `SLACK_ALLOWED_CHANNEL_IDS` is optional. Leave it blank to let the bot answer in any channel it has access to.
- `WEB_SEARCH_ALLOWED_DOMAINS` is optional. Use comma-separated bare domains like `f3nation.com`; do not include `https://`.
- `VECTOR_STORE_SOURCE_DIR` defaults to `vectorstore`.
- `VECTOR_STORE_RESTART_SERVICE` defaults to `f3po-slack-bot.service`. Set it to `none` to disable automatic restart after vector store rebuilds.
- `GOOGLE_CLOUD_PROJECT=f3data` is used by the local reporting sync.
- `LOG_LEVEL` can be `error`, `info`, or `debug`.
- `INTERACTION_DB_PATH` stores searchable bot questions/responses in local SQLite.
- `MESSAGE_DEDUPE_TTL_MS`, `QUESTION_DEDUPE_TTL_MS`, `THREAD_REPLY_LIMIT`, and `THREAD_REPLY_LIMIT_WINDOW_MS` are runtime guardrails that prevent duplicate Slack event handling and runaway thread replies.

`node_modules/`, `.env`, `export/`, daily logs, and private Wichita vectorstore docs are ignored by Git.

## Slack App Setup

1. Create a Slack app.
2. Add a bot user.
3. Enable Socket Mode.
4. Create an app-level token with the `connections:write` scope and put it in `SLACK_APP_TOKEN`.
5. Add bot scopes such as `app_mentions:read`, `chat:write`, `channels:history`, `channels:read`, `groups:history`, `groups:read`, and `users:read`.
6. Subscribe the bot to events: `app_mention`, `message.channels`, and `message.groups`.
7. Install the app into the workspace.
8. Invite the bot to each channel where it should answer.

## Common Workflows

Run the bot:

```sh
npm start
```

Update the vector store with new or changed local docs:

```sh
npm run rag:add
```

Remove vector store entries whose source files were deleted locally:

```sh
npm run rag:prune
```

Rebuild the vector store from scratch:

```sh
npm run rag:rebuild
```

Sync the local SQLite reporting database:

```sh
npm run reporting:sync:full
npm run reporting:sync
npm run reporting:health
```

Search the local bot interaction database:

```sh
npm run interactions:search -- "IronPax"
```

Export the F3 Wichita YouTube index:

```sh
npm run youtube:export
```

Run checks:

```sh
npm test
```

## Repo Layout

```text
app.js                         Slack bot runtime
scripts/                       Maintenance/export tooling
docs/                          Operational docs
vectorstore/F3 Nation Documents/  Shared committed source docs
vectorstore/F3 Wichita Documents/ Ignored local/private source docs
export/youtube/                Ignored YouTube metadata/caption exports
export/google/                 Ignored Google/BigQuery scratch/review exports
logs/                          Ignored daily runtime logs
```

## More Docs

- [RAG and vector store](docs/rag.md)
- [Local reporting database](docs/reporting-db.md)
- [Bot interaction log](docs/interaction-log.md)
- [YouTube export](docs/youtube-export.md)
- [Deployment](docs/deployment.md)
- [Server migration runbook](docs/server-migration.md)

## Behavior Notes

The bot reads the current Slack thread, searches the vector store first, and replies in-thread. If the thread plus vector store do not contain enough information, it can fall back to OpenAI web search over `WEB_SEARCH_ALLOWED_DOMAINS`.

If `SLACK_ALLOWED_CHANNEL_IDS` is set and the bot is mentioned somewhere else, it replies that it is not enabled in that channel.

F3PO should not invent Slack channel names. If it cannot answer an F3 Wichita tech or IT question, it should use the vector store docs to identify the current Tech Q / IT Q and suggest contacting that person.

After the bot has replied in a thread, it can answer follow-up messages in that same thread without another mention. For public channels, Slack must send the `message.channels` event. For private channels, Slack must send the `message.groups` event.

To control cost and avoid reply loops, F3PO ignores bot-authored messages, deduplicates repeated Slack event deliveries by channel/message timestamp, suppresses very similar questions repeated in the same thread for a short cooldown, and caps how many times it will answer in one thread during a rolling window.

The bot also writes answered questions and responses to the local interaction SQLite database so they can be searched later. Interaction rows include detected question tone (`factual`, `playful`, or `sensitive`), a short tone reason, and elapsed response time. When `LOG_LEVEL=debug`, the terminal and daily log file record more detailed retrieval path, tone, timings, and model/tool usage.
