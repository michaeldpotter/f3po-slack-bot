#!/usr/bin/env node
// Test the general F3PO answer path from a terminal.
//
// This is intentionally not a Slack client. It approximates the Slack bot flow:
// reporting/F3 Nation API first, then vector-store answer, then allowed web search
// fallback when configured.

require("dotenv").config();

const fs = require("fs");
const readline = require("readline");
const OpenAI = require("openai");
const { maybeAnswerReportingQuestion } = require("../lib/reporting");
const { loadBotTuning, replyStyleInstruction } = require("../lib/bot-tuning");

const openai = new OpenAI({ apiKey: requireEnv("OPENAI_API_KEY") });

const MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";
const VECTOR_STORE_ID = requireEnv("VECTOR_STORE_ID");
const BOT_TUNING = loadBotTuning();
const WEB_SEARCH_ALLOWED_DOMAINS = BOT_TUNING.webSearchAllowedDomains;
const LOCAL_REGION_NAME = BOT_TUNING.localRegionName;
const REPLY_STYLE = BOT_TUNING.replyStyle;

const BOT_INSTRUCTIONS =
  "You are F3PO, a helpful but slightly sarcastic F3 guy. " +
  `You help ${LOCAL_REGION_NAME} PAX answer questions using F3 documents, reporting/API data, and approved web sources. ` +
  replyStyleInstruction(REPLY_STYLE) +
  "Use an F3-flavored voice by default: plainspoken, brotherly, lightly witty, and comfortable with common F3 terms like PAX, Q, AO, Site Q, HIM, gloom, beatdown, mumblechatter, and coffeeteria when they naturally fit. " +
  "Add one small F3-style turn of phrase or aside when it helps the reply feel alive, but do not force jargon into every sentence and do not let jokes bury the answer. " +
  "For serious, sensitive, operational, or troubleshooting questions, keep the flavor restrained: useful first, color second. " +
  "When the user says something like 'see above', 'what he said', 'same question', or 'that one', use the current fake thread context first and answer the referenced question directly. Only restate the referenced context in a short phrase if needed for clarity. " +
  "For workout designs, exercise lists, Q sheets, and exercise how-to answers, stay compact and useful. If asked for exercises, give 8-10 good options max. If asked for a full workout, give one runnable workout with warm-up, main work, finisher, and quick modifications; do not write an encyclopedia unless asked. " +
  "For questions about teaching or training the bot on a challenge, event, AO, or recurring topic, keep it brief: say to add or update the relevant vectorstore doc with aliases/search terms and rerun `npm run rag:add`; offer a template only if the user asks. " +
  "When asked for F3 name ideas for a new PAX, explain that good names come from the PAX's story and ask for 2-3 useful details first: first or hospital name, job, hometown, hobbies, teams, personality, or a funny first-post moment. Do not suggest existing Wichita PAX names as reusable names. Use existing names only as style examples if needed, clearly labeled as examples. Avoid generic tough-guy names; prefer playful, specific, memorable, usually ironic options. " +
  `For ${LOCAL_REGION_NAME} leadership, roster, Site Q, AO Q, or role-holder questions, answer the specific question directly and stop once the useful fact and brief source context are given. Do not add generic confirmation/contact next steps, F3 Nation app advice, \`/calendar\` advice, or channel suggestions unless the user explicitly asks how to verify, contact, or update the information. ` +
  "Do not invent Slack channels, and do not tell users to post in a channel. " +
  "Do not ask users to paste, upload, or link backblasts, Slack threads, photos, or other source material for you to inspect. " +
  "For playful photo-proof questions about PAX, say you cannot inspect private Slack/Facebook photos and give a brief fun answer instead of searching unless the user explicitly asks for a serious public-source search. " +
  "If asked what you can do, answer in a fun F3PO voice while staying concise and specific.";

const VECTOR_ONLY_INSTRUCTIONS =
  BOT_INSTRUCTIONS +
  " Use the conversation plus file search. Do not include citations, source markers, annotation tokens, or file-search citation markup. " +
  "Do not offer to search, list searchable domains, or ask which site to check. " +
  "If the docs do not contain enough information and web search would be needed, return exactly NEED_WEB_SEARCH and nothing else.";

const WEB_FALLBACK_INSTRUCTIONS =
  BOT_INSTRUCTIONS +
  " The vector store did not contain enough information. Use allowed web search domains to answer. " +
  "Do not list the allowed domains unless the user explicitly asks what domains are enabled. " +
  "If the allowed websites do not contain the answer, say so briefly.";

function printUsage() {
  console.log(`
Usage:
  node scripts/ask-bot.js "what can you do?"
  node scripts/ask-bot.js --interactive
  node scripts/ask-bot.js --stdin

Options:
  --interactive, -i   Keep a fake thread open for follow-up testing.
  --stdin             Read the prompt from stdin.
  --json              Print raw source/text JSON.
  --help              Show this help.

Commands in interactive mode:
  /thread             Show the current fake thread.
  /clear              Clear the fake thread.
  /exit               Quit.
`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  return {
    help: args.includes("--help") || args.includes("-h"),
    stdin: args.includes("--stdin"),
    interactive: args.includes("--interactive") || args.includes("-i"),
    json: args.includes("--json"),
    prompt: args.filter((arg) => !arg.startsWith("--") && arg !== "-i").join(" "),
  };
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function capabilityReply() {
  return [
    `Hey, I'm F3PO: ${LOCAL_REGION_NAME}'s answer bot with just enough attitude to keep the paperwork awake.`,
    "",
    "I can:",
    "- Find leadership, roster, Site Q, AO Q, and role-holder info.",
    "- Pull answers from uploaded docs instead of vibes and campfire memory.",
    "- Check Q schedules through reporting/F3 Nation API data.",
    "- Search approved F3 sites when that is enabled.",
    "- Help debug bot/reporting weirdness when the machines start acting too confident.",
    "",
    "Ask me something specific and I'll go dig. Ask me something vague and I'll still try, but I reserve the right to sigh digitally.",
  ].join("\n");
}

function maybeAnswerCapabilityQuestion(text = "") {
  const cleaned = text.trim().toLowerCase();
  if (/^(what can you do|help|commands|what do you do)\??$/.test(cleaned)) {
    return capabilityReply();
  }
  return null;
}

function maybeAnswerPlayfulPhotoQuestion(text = "") {
  const normalized = text
    .replace(/<@[\w]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const asksPhotoProof =
    /\b(backblast|photo|picture|image)\b/.test(normalized) &&
    /\b(smile|smiled|shirt|camera|looking|proof|evidence)\b/.test(normalized);
  const asksSmileProof = /\bhas\s+.+?\s+ever\s+smiled\b/.test(normalized);

  if (!asksPhotoProof && !asksSmileProof) return null;

  return (
    "I can’t inspect private Slack/Facebook photos from here, so I’m not going to pretend I saw the receipt 📸. " +
    "Official ruling: possible, suspicious, and absolutely worth bringing up at coffeeteria."
  );
}

function buildTools({ includeFileSearch = true, includeWebSearch = false } = {}) {
  const tools = [];
  if (includeFileSearch) {
    tools.push({ type: "file_search", vector_store_ids: [VECTOR_STORE_ID] });
  }
  if (includeWebSearch && WEB_SEARCH_ALLOWED_DOMAINS.length > 0) {
    tools.push({
      type: "web_search",
      filters: { allowed_domains: WEB_SEARCH_ALLOWED_DOMAINS },
    });
  }
  return tools;
}

function sanitizeModelReply(text = "") {
  return text
    .replace(/[\uE000-\uF8FF]filecite:[^\s.,;!?]+/g, "")
    .replace(/[\uE000-\uF8FF]cite:[^\s.,;!?]+/g, "")
    .replace(/[\uE000-\uF8FF]+/g, "")
    .replace(/\bfilecite:[^\s.,;!?]+/g, "")
    .replace(/\bcite:[^\s.,;!?]+/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function threadToInput(threadMessages, prompt) {
  const messages = [];
  for (const message of threadMessages) {
    messages.push({
      role: message.role,
      content: message.text,
    });
  }
  messages.push({ role: "user", content: prompt });
  return messages;
}

async function askOnce(prompt, args, threadMessages) {
  const capability = maybeAnswerCapabilityQuestion(prompt);
  if (capability) {
    return {
      source: "bot_help",
      text: capability,
    };
  }

  const playfulPhotoReply = maybeAnswerPlayfulPhotoQuestion(prompt);
  if (playfulPhotoReply) {
    return {
      source: "playful_reply",
      text: playfulPhotoReply,
    };
  }

  const reportingReply = await maybeAnswerReportingQuestion(prompt, {
    threadMessages: threadMessages.map((message) => ({ text: message.text })),
    requesterName: process.env.TEST_REQUESTER_NAME || "",
    botUserId: process.env.TEST_BOT_USER_ID || "",
    log: (message, err) => console.error(`${message}: ${err?.message || err}`),
  });

  if (reportingReply) {
    return {
      source: reportingReply.source,
      text: reportingReply.text,
    };
  }

  const input = threadToInput(threadMessages, prompt);
  const vectorResp = await openai.responses.create({
    model: MODEL,
    instructions: VECTOR_ONLY_INSTRUCTIONS,
    input,
    tools: buildTools({ includeFileSearch: true }),
  });
  const vectorReply = sanitizeModelReply(vectorResp.output_text || "");

  if (vectorReply && vectorReply !== "NEED_WEB_SEARCH") {
    return { source: "vector_store", text: vectorReply };
  }

  if (WEB_SEARCH_ALLOWED_DOMAINS.length === 0) {
    return {
      source: "vector_store_no_answer",
      text: "I couldn't find that in the uploaded docs, and web search is not enabled.",
    };
  }

  const webResp = await openai.responses.create({
    model: MODEL,
    instructions: WEB_FALLBACK_INSTRUCTIONS,
    input,
    tools: buildTools({ includeWebSearch: true }),
  });

  return {
    source: "web_search",
    text: sanitizeModelReply(webResp.output_text || "") || "I couldn't generate a response.",
  };
}

function printThread(threadMessages) {
  if (threadMessages.length === 0) {
    console.log("(thread is empty)");
    return;
  }
  threadMessages.forEach((message, index) => {
    console.log(`\n[${index + 1}] ${message.role}`);
    console.log(message.text);
  });
}

async function interactive(args) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY,
  });
  const threadMessages = [];

  console.log("F3PO full-path tester. Commands: /thread, /clear, /exit");

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

      const result = await askOnce(prompt, args, threadMessages);
      const output = args.json ? JSON.stringify(result, null, 2) : `[${result.source}]\n${result.text}`;
      console.log(`\nF3PO>\n${output}`);

      threadMessages.push({ role: "user", text: prompt });
      threadMessages.push({ role: "assistant", text: result.text });
      if (process.stdin.isTTY) rl.prompt();
    }
  } finally {
    rl.close();
  }
}

function readStdin() {
  return fs.readFileSync(0, "utf8").trim();
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

  const result = await askOnce(prompt, args, []);
  console.log(args.json ? JSON.stringify(result, null, 2) : `[${result.source}]\n${result.text}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
