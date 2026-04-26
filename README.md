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
SLACK_ALLOWED_CHANNEL_ID=C1234567890
OPENAI_API_KEY=sk...
OPENAI_MODEL=gpt-5-mini
VECTOR_STORE_ID=vs_...
```

`SLACK_ALLOWED_CHANNEL_ID` is optional. If set, the bot only answers in that channel and nudges users elsewhere to use the configured channel.

## Slack App Setup

1. Create a Slack app.
2. Add a bot user.
3. Enable Socket Mode.
4. Create an app-level token with the `connections:write` scope and put it in `SLACK_APP_TOKEN`.
5. Add bot scopes such as `app_mentions:read`, `chat:write`, `channels:history`, and `channels:read`.
6. Install the app into the workspace.
7. Invite the bot to the channel where it should answer.

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

Mention the bot in Slack from the allowed channel:

```text
@bot What are the AO naming rules?
```

The bot reads the current Slack thread, searches the vector store, and replies in-thread.

## Verify

```sh
npm test
```

This currently runs syntax checks for the bot and RAG setup script.
