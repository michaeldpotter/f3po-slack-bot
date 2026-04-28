#!/usr/bin/env node

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const OpenAI = require("openai");
const {
  readStatus,
  redact,
  statusPath,
  validateStatus,
} = require("../lib/health-status");

const DEFAULT_REPORTING_DB_PATH = path.join("export", "google", "f3po-reporting.sqlite");
const DEFAULT_INTERACTION_DB_PATH = path.join("export", "google", "f3po-conversations.sqlite");

function parseArgs(argv) {
  const args = argv.slice(2);
  const valueAfter = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };

  return {
    help: args.includes("--help") || args.includes("-h"),
    json: args.includes("--json"),
    deep: args.includes("--deep"),
    statusPath: valueAfter("--status") || statusPath(),
    maxAgeSeconds: Number.parseInt(
      valueAfter("--max-age-seconds") || process.env.F3PO_HEALTH_MAX_AGE_SECONDS || "180",
      10
    ),
  };
}

function printUsage() {
  console.log(`
Usage:
  npm run health
  npm run health -- --json
  npm run health -- --deep

Checks:
  - heartbeat file freshness
  - required environment variables
  - reporting/interaction SQLite files are readable when present
  - OpenAI vector store is reachable with --deep
`);
}

function push(checks, name, ok, detail = "") {
  checks.push({ name, ok: Boolean(ok), detail });
}

function fileReadable(filePath) {
  fs.accessSync(filePath, fs.constants.R_OK);
}

function sqliteReadable(filePath) {
  fileReadable(filePath);
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    db.prepare("SELECT 1").get();
  } finally {
    db.close();
  }
}

async function runDeepChecks(checks) {
  const vectorStoreId = process.env.VECTOR_STORE_ID;
  if (!process.env.OPENAI_API_KEY || !vectorStoreId) {
    push(checks, "openai_vector_store", false, "OPENAI_API_KEY or VECTOR_STORE_ID missing");
    return;
  }

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const store = await openai.vectorStores.retrieve(vectorStoreId);
    push(checks, "openai_vector_store", Boolean(store?.id), `${store?.id || "missing"} ${store?.status || ""}`.trim());
  } catch (err) {
    push(checks, "openai_vector_store", false, err.message || String(err));
  }

  if (process.env.F3_NATION_API_KEY) {
    try {
      const baseUrl = process.env.F3_NATION_API_BASE_URL || "https://api.f3nation.com";
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/ping`, {
        headers: {
          Authorization: `Bearer ${process.env.F3_NATION_API_KEY}`,
          Client: process.env.F3_NATION_API_CLIENT || "f3po-slack-bot",
          Accept: "application/json",
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      push(checks, "f3nation_api", res.ok, `${res.status} ${res.statusText}`);
    } catch (err) {
      push(checks, "f3nation_api", false, err.message || String(err));
    }
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printUsage();
    return;
  }

  const checks = [];
  let status = null;

  try {
    status = readStatus(args.statusPath);
    validateStatus(status, { maxAgeSeconds: args.maxAgeSeconds }).forEach((check) =>
      checks.push(check)
    );
  } catch (err) {
    push(checks, "heartbeat_readable", false, `${args.statusPath}: ${err.message}`);
  }

  for (const name of ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "OPENAI_API_KEY", "VECTOR_STORE_ID"]) {
    push(checks, `env_${name.toLowerCase()}`, Boolean(process.env[name]), process.env[name] ? redact(process.env[name]) : "missing");
  }

  for (const [name, filePath] of [
    ["reporting_db", process.env.REPORTING_DB_PATH || DEFAULT_REPORTING_DB_PATH],
  ]) {
    try {
      sqliteReadable(filePath);
      push(checks, name, true, filePath);
    } catch (err) {
      push(checks, name, false, `${filePath}: ${err.message}`);
    }
  }

  const interactionDbPath = process.env.INTERACTION_DB_PATH || DEFAULT_INTERACTION_DB_PATH;
  try {
    if (fs.existsSync(interactionDbPath)) {
      sqliteReadable(interactionDbPath);
      push(checks, "interaction_db", true, interactionDbPath);
    } else {
      fs.mkdirSync(path.dirname(interactionDbPath), { recursive: true });
      fileReadable(path.dirname(interactionDbPath));
      push(checks, "interaction_db", true, `${interactionDbPath} not created yet`);
    }
  } catch (err) {
    push(checks, "interaction_db", false, `${interactionDbPath}: ${err.message}`);
  }

  if (args.deep) {
    await runDeepChecks(checks);
  }

  const ok = checks.every((check) => check.ok);
  const result = {
    ok,
    checked_at: new Date().toISOString(),
    status_path: args.statusPath,
    status,
    checks,
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(ok ? "F3PO health: OK" : "F3PO health: FAIL");
    for (const check of checks) {
      console.log(`${check.ok ? "OK  " : "FAIL"} ${check.name}${check.detail ? ` - ${check.detail}` : ""}`);
    }
  }

  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
