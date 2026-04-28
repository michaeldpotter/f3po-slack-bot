#!/usr/bin/env node
// Test the deterministic reporting/F3 Nation API path without going through Slack.
//
// This intentionally does not call the model fallback. If it prints "No reporting
// reply", the Slack bot would likely fall through to the general model path.

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { maybeAnswerReportingQuestion } = require("../lib/reporting");

const DEFAULT_DB_PATH = path.join("export", "google", "f3po-reporting.sqlite");

function printUsage() {
  console.log(`
Usage:
  node scripts/ask-reporting.js "who is q on sat at ww?"
  node scripts/ask-reporting.js --thread thread.txt "rest of the month?"
  node scripts/ask-reporting.js --interactive
  node scripts/ask-reporting.js --stdin

Options:
  --db PATH          SQLite reporting DB path. Default: REPORTING_DB_PATH or export/google/f3po-reporting.sqlite
  --thread PATH      Plain text file with prior thread messages separated by blank lines.
  --interactive, -i   Keep a fake thread open for follow-up testing.
  --stdin            Read the prompt from stdin.
  --json             Print the raw result as JSON.
  --help             Show this help.

Tip:
  In interactive mode, use /thread to inspect context, /clear to reset it, and /exit to quit.
`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const valueAfter = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };

  return {
    help: args.includes("--help") || args.includes("-h"),
    stdin: args.includes("--stdin"),
    interactive: args.includes("--interactive") || args.includes("-i"),
    json: args.includes("--json"),
    dbPath: valueAfter("--db") || process.env.REPORTING_DB_PATH || DEFAULT_DB_PATH,
    threadPath: valueAfter("--thread"),
    prompt: args
      .filter((arg, index) => {
        const previous = args[index - 1];
        return !arg.startsWith("--") && previous !== "--db" && previous !== "--thread";
      })
      .join(" "),
  };
}

async function askOnce(prompt, args, threadMessages) {
  const result = await maybeAnswerReportingQuestion(prompt, {
    dbPath: args.dbPath,
    threadMessages,
    requesterName: process.env.TEST_REQUESTER_NAME || "",
    botUserId: process.env.TEST_BOT_USER_ID || "",
    log: (message, err) => console.error(`${message}: ${err?.message || err}`),
  });

  if (args.json) return JSON.stringify(result, null, 2);

  if (!result) {
    return "No reporting reply. This prompt would likely fall through to the model path.";
  }

  return `[${result.source}]\n${result.text}`;
}

function printThread(threadMessages) {
  if (threadMessages.length === 0) {
    console.log("(thread is empty)");
    return;
  }
  threadMessages.forEach((message, index) => {
    console.log(`\n[${index + 1}]`);
    console.log(message.text);
  });
}

async function interactive(args) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY,
  });
  const threadMessages = readThreadMessages(args.threadPath);

  console.log("F3PO reporting tester. Type a prompt, then follow-ups. Commands: /thread, /clear, /exit");
  if (threadMessages.length > 0) {
    console.log(`Loaded ${threadMessages.length} thread message(s) from ${args.threadPath}.`);
  }

  try {
    if (process.stdin.isTTY) rl.setPrompt("\nYou> ");
    if (process.stdin.isTTY) rl.prompt();

    for await (const line of rl) {
      const prompt = line.trim();
      if (!prompt) continue;
      if (prompt === "/exit" || prompt === "/quit") break;
      if (prompt === "/clear") {
        threadMessages.length = 0;
        console.log("Thread cleared.");
        if (process.stdin.isTTY) rl.prompt();
        continue;
      }
      if (prompt === "/thread") {
        printThread(threadMessages);
        if (process.stdin.isTTY) rl.prompt();
        continue;
      }

      const output = await askOnce(prompt, args, threadMessages);
      console.log(`\nF3PO>\n${output}`);

      threadMessages.push({ text: prompt });
      threadMessages.push({ text: output });
      if (process.stdin.isTTY) rl.prompt();
    }
  } finally {
    rl.close();
  }
}

function readStdin() {
  return fs.readFileSync(0, "utf8").trim();
}

function readThreadMessages(threadPath) {
  if (!threadPath) return [];
  const text = fs.readFileSync(threadPath, "utf8");
  return text
    .split(/\n\s*\n/g)
    .map((message) => message.trim())
    .filter(Boolean)
    .map((message) => ({ text: message }));
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printUsage();
    return;
  }

  if (args.interactive) {
    await interactive(args);
    return;
  }

  const prompt = args.stdin ? readStdin() : args.prompt.trim();
  if (!prompt) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const output = await askOnce(prompt, args, readThreadMessages(args.threadPath));
  console.log(output);
  if (output.startsWith("No reporting reply.")) process.exitCode = 2;
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
