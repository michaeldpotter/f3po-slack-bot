# Bot Interaction Log

F3PO can keep a local, searchable SQLite database of questions it receives and responses it sends.

This is separate from the plain text runtime logs and separate from the local reporting database.

## What It Stores

Table: `bot_interactions`

- timestamp
- trigger type, such as `app_mention` or `thread_follow_up`
- Slack channel ID and label
- Slack user ID and display name
- thread/message timestamps
- OpenAI model
- answer source, such as `vector_store` or `web_search`
- question text
- response text
- error text, when present

If the local SQLite build supports FTS5, the app also maintains `bot_interactions_fts` for full-text search across questions, responses, user names, and channel labels.

## Privacy Position

This database may contain Slack user questions and bot responses. Treat it like Slack history.

Do not commit it, upload it, or expose it directly through the bot.

The default path is ignored by Git:

```text
export/google/f3po-conversations.sqlite
```

## Settings

```sh
INTERACTION_DB_PATH=export/google/f3po-conversations.sqlite
INTERACTION_RETENTION_DAYS=90
```

The bot prunes old interaction rows on startup and once per day while running.

## Search

Search with the helper script:

```sh
npm run interactions:search -- "IronPax"
```

Limit result count:

```sh
npm run interactions:search -- "FNG counts" --limit 25
```

Use a different database path:

```sh
npm run interactions:search -- "Chubbs" --db export/google/f3po-conversations.sqlite
```

Direct SQL still works:

```sh
sqlite3 export/google/f3po-conversations.sqlite \
  "SELECT created_at, user_name, question_text, response_text FROM bot_interactions ORDER BY id DESC LIMIT 10;"
```
