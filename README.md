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
```

`SLACK_ALLOWED_CHANNEL_IDS` is optional. Leave it blank to let the bot answer in any channel it has access to. Set one or more comma-separated channel IDs to limit where the bot answers. Public channel IDs usually start with `C`; private channel IDs usually start with `G`.

The older single-channel variable `SLACK_ALLOWED_CHANNEL_ID` still works, but `SLACK_ALLOWED_CHANNEL_IDS` is preferred.

## Slack App Setup

1. Create a Slack app.
2. Add a bot user.
3. Enable Socket Mode.
4. Create an app-level token with the `connections:write` scope and put it in `SLACK_APP_TOKEN`.
5. Add bot scopes such as `app_mentions:read`, `chat:write`, `channels:history`, `channels:read`, and `groups:history`.
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

The bot reads the current Slack thread, searches the vector store, and replies in-thread. If `SLACK_ALLOWED_CHANNEL_IDS` is set and the bot is mentioned somewhere else, it replies with a short nudge to use an allowed channel.

After the bot has replied in a thread, it can also answer follow-up messages in that same thread without another mention. For public channels, Slack must send the `message.channels` event. For private channels, Slack must send the `message.groups` event. It first checks whether the bot already participated, skips obvious acknowledgements like "thanks" or "got it", and uses OpenAI to decide whether ambiguous follow-ups are really directed at the bot.

## Verify

```sh
npm test
```

This currently runs syntax checks for the bot and RAG setup script.
