#!/usr/bin/env node
// Search the local F3PO interaction database.
//
// Usage:
//   node scripts/search-interactions.js ironpax
//   node scripts/search-interactions.js "FNG counts" --limit 20
//   npm run interactions:search -- "where did Chubbs"
//
// The database is local-only and ignored by Git. It may contain Slack user
// questions and bot responses, so treat exports/results with the same care you
// would give Slack history.

require("dotenv").config();

const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const DEFAULT_DB_PATH = path.join("export", "google", "f3po-conversations.sqlite");

function parseArgs(argv) {
  const args = argv.slice(2);
  const valueAfter = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const queryParts = [];

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--limit" || args[i] === "--db") {
      i += 1;
      continue;
    }
    queryParts.push(args[i]);
  }

  const limit = Number.parseInt(valueAfter("--limit") || "10", 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("--limit must be an integer between 1 and 100.");
  }

  return {
    dbPath: valueAfter("--db") || process.env.INTERACTION_DB_PATH || DEFAULT_DB_PATH,
    query: queryParts.join(" ").trim(),
    limit,
  };
}

function escapeFtsQuery(value) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(" ");
}

function searchWithFts(db, query, limit) {
  return db
    .prepare(
      `SELECT
         i.id,
         i.created_at,
         i.trigger,
         i.channel_label,
         i.user_name,
         i.answer_source,
         i.question_tone,
         i.question_tone_reason,
         i.elapsed_ms,
         i.question_text,
         i.response_text,
         bm25(bot_interactions_fts) AS rank
       FROM bot_interactions_fts
       JOIN bot_interactions i ON i.id = bot_interactions_fts.rowid
       WHERE bot_interactions_fts MATCH ?
       ORDER BY rank
       LIMIT ?`
    )
    .all(escapeFtsQuery(query), limit);
}

function searchWithLike(db, query, limit) {
  const like = `%${query}%`;
  return db
    .prepare(
      `SELECT
         id,
         created_at,
         trigger,
         channel_label,
         user_name,
         answer_source,
         question_tone,
         question_tone_reason,
         elapsed_ms,
         question_text,
         response_text
       FROM bot_interactions
       WHERE question_text LIKE ? OR response_text LIKE ? OR user_name LIKE ? OR channel_label LIKE ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(like, like, like, like, limit);
}

function truncate(value = "", max = 220) {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function printRows(rows) {
  if (rows.length === 0) {
    console.log("No matching interactions found.");
    return;
  }

  for (const row of rows) {
    console.log("=".repeat(80));
    console.log(`#${row.id} ${row.created_at} ${row.channel_label || ""}`);
    console.log(`user: ${row.user_name || "unknown"}`);
    console.log(`trigger: ${row.trigger || "unknown"}`);
    console.log(`source: ${row.answer_source || "unknown"}`);
    console.log(
      `tone: ${row.question_tone || "unknown"}${
        row.question_tone_reason ? ` (${row.question_tone_reason})` : ""
      }`
    );
    console.log(`elapsed: ${row.elapsed_ms ?? "unknown"} ms`);
    console.log(`question: ${truncate(row.question_text || "")}`);
    console.log(`response: ${truncate(row.response_text || "")}`);
  }
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.query) {
    throw new Error("Provide a search query.");
  }

  const db = new DatabaseSync(args.dbPath);
  let rows;

  try {
    rows = searchWithFts(db, args.query, args.limit);
  } catch (err) {
    rows = searchWithLike(db, args.query, args.limit);
  } finally {
    db.close();
  }

  printRows(rows);
}

try {
  main();
} catch (err) {
  console.error(err.message || String(err));
  process.exit(1);
}
