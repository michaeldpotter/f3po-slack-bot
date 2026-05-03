require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { performance } = require("node:perf_hooks");
const { DatabaseSync } = require("node:sqlite");
const { App } = require("@slack/bolt");
const OpenAI = require("openai");
const { maybeAnswerReportingQuestion } = require("./lib/reporting");
const { readStatus, statusPath, validateStatus, writeStatus } = require("./lib/health-status");
const {
  didBotInviteFollowUp,
  isObviousChatterText,
  loadBotTuning,
  replyStyleInstruction,
  threadReplyClassifierInstructions,
} = require("./lib/bot-tuning");

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const slackApp = new App({
  token: requireEnv("SLACK_BOT_TOKEN"),
  appToken: requireEnv("SLACK_APP_TOKEN"),
  socketMode: true,
});

const openai = new OpenAI({ apiKey: requireEnv("OPENAI_API_KEY") });

const ALLOWED_CHANNEL_IDS = parseAllowedChannelIds(
  process.env.SLACK_ALLOWED_CHANNEL_IDS || process.env.SLACK_ALLOWED_CHANNEL_ID
);
const VECTOR_STORE_ID = requireEnv("VECTOR_STORE_ID");
const MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";
const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, "logs");
const LOG_RETENTION_DAYS = Number.parseInt(process.env.LOG_RETENTION_DAYS || "7", 10);
const LOG_LEVEL = normalizeLogLevel(process.env.LOG_LEVEL || "info");
const INTERACTION_DB_PATH =
  process.env.INTERACTION_DB_PATH || path.join(__dirname, "export", "google", "f3po-conversations.sqlite");
const INTERACTION_RETENTION_DAYS = Number.parseInt(
  process.env.INTERACTION_RETENTION_DAYS || "90",
  10
);
const BOT_TUNING = loadBotTuning();
const WEB_SEARCH_ALLOWED_DOMAINS = BOT_TUNING.webSearchAllowedDomains;
const LOCAL_REGION_NAME = BOT_TUNING.localRegionName;
const REPLY_STYLE = BOT_TUNING.replyStyle;
const THREAD_FOLLOW_UP_MODE = BOT_TUNING.threadFollowUpMode;
const MESSAGE_DEDUPE_TTL_MS = BOT_TUNING.messageDedupeTtlMs;
const QUESTION_DEDUPE_TTL_MS = BOT_TUNING.questionDedupeTtlMs;
const THREAD_REPLY_LIMIT = BOT_TUNING.threadReplyLimit;
const THREAD_REPLY_LIMIT_WINDOW_MS = BOT_TUNING.threadReplyLimitWindowMs;
const MAX_THREAD_MESSAGES = BOT_TUNING.maxThreadMessages;
const MAX_CHARS_PER_MESSAGE = BOT_TUNING.maxCharsPerMessage;
const STATUS_PATH = statusPath();
const HEARTBEAT_INTERVAL_MS = parsePositiveInt(process.env.F3PO_HEARTBEAT_INTERVAL_MS, 30 * 1000);
const STARTUP_SELF_TEST_ENABLED = process.env.F3PO_STARTUP_SELF_TEST !== "0";
const slackUserCache = new Map();
const slackChannelCache = new Map();
const handledMessageCache = new Map();
const recentThreadQuestions = new Map();
const threadReplyWindows = new Map();
let interactionDb;
let interactionFtsEnabled = false;
const runtimeStatus = {
  service: "f3po-slack-bot",
  started_at: nowIso(),
  updated_at: nowIso(),
  process: {
    pid: process.pid,
    node: process.version,
    platform: process.platform,
  },
  config: {
    model: MODEL,
    vector_store_id: VECTOR_STORE_ID,
    allowed_channels_count: ALLOWED_CHANNEL_IDS.length,
    web_search_enabled: WEB_SEARCH_ALLOWED_DOMAINS.length > 0,
    reporting_db_path: process.env.REPORTING_DB_PATH || path.join("export", "google", "f3po-reporting.sqlite"),
    interaction_db_path: INTERACTION_DB_PATH,
    local_region_name: LOCAL_REGION_NAME,
    reply_style: REPLY_STYLE,
    thread_follow_up_mode: THREAD_FOLLOW_UP_MODE,
    thread_reply_limit: THREAD_REPLY_LIMIT,
    thread_reply_limit_window_ms: THREAD_REPLY_LIMIT_WINDOW_MS,
    max_thread_messages: MAX_THREAD_MESSAGES,
  },
  slack: {
    started: false,
    mode: "Socket Mode",
  },
  counters: {
    app_mentions_received: 0,
    thread_followups_received: 0,
    replies_sent: 0,
    errors: 0,
  },
  last_event_at: null,
  last_reply_at: null,
  last_error_at: null,
  last_error: null,
  last_fatal_error_at: null,
};

const CHANNEL_BLOCKED_REPLIES = [
  "👀 Bold move, PAX. I’m not enabled to answer in this channel.",
  "🫡 Respectfully: wrong AO for F3PO. I’m not enabled to answer here.",
  "🥾 Easy there. I’m not on Q for this channel.",
  "📣 Hold up, HIM. I’m not enabled to answer in this channel.",
  "⏱️ Time hack: I can’t answer here.",
];

const BOT_INSTRUCTIONS =
  "You are F3PO, a helpful but slightly sarcastic F3 guy. " +
  `You help ${LOCAL_REGION_NAME} PAX answer questions using Slack thread context, F3 documents, and approved web sources. ` +
  replyStyleInstruction(REPLY_STYLE) +
  "Use an F3-flavored voice by default: plainspoken, brotherly, lightly witty, and comfortable with common F3 terms like PAX, Q, AO, Site Q, HIM, gloom, beatdown, mumblechatter, and coffeeteria when they naturally fit. " +
  "Add one small F3-style turn of phrase or aside when it helps the reply feel alive, but do not force jargon into every sentence and do not let jokes bury the answer. " +
  "For serious, sensitive, operational, or troubleshooting questions, keep the flavor restrained: useful first, color second. " +
  "Format Slack replies cleanly: short answer first, bold section headers when helpful, compact bullets or numbered lists, and light contextual emoji only when it improves scanning. " +
  "Avoid giant paragraphs; prefer 1-3 short sections with whitespace between them. " +
  "Stay on topic. Do not drift to discussing non-F3 topics. " +
  "Do not invent Slack channels, and do not tell users to post in a channel. " +
  `For ${LOCAL_REGION_NAME} leadership, roster, Site Q, AO Q, or role-holder questions, answer the specific question directly and stop once the useful fact and brief source context are given. Do not add generic confirmation/contact next steps, F3 Nation app advice, \`/calendar\` advice, or channel suggestions unless the user explicitly asks how to verify, contact, or update the information. ` +
  "You are the bot, not a PAX and not a Q. Never say or imply that you are Qing, calling Q, leading, attending, or choosing a workout. " +
  "When offering follow-up help about leadership, say 'who is Qing', 'who is scheduled to Q', or 'who is leading' instead of 'which one I am calling Q'. " +
  "If you cannot confirm who is scheduled to Q for a specific upcoming workout date after using the reporting/API path and available docs, do not offer to draft Slack messages or DMs, and do not offer to read a Slack signup thread. Briefly say you cannot confirm the scheduled Q from the available data. " +
  "Detect obvious F3 ribbing, jokes, and facetious questions. If a question is playful rather than factual, answer playfully and briefly instead of treating it like a research assignment. " +
  "For playful questions about a PAX, keep it harmless and avoid mean personal claims, private facts, or pretending to have inspected photos unless the thread itself includes the photo. " +
  "When asked for F3 name ideas for a new PAX, explain that good names come from the PAX's story and ask for 2-3 useful details first: first or hospital name, job, hometown, hobbies, teams, personality, or a funny first-post moment. Do not suggest existing Wichita PAX names as reusable names. Use existing names only as style examples if needed, clearly labeled as examples. Avoid generic tough-guy names; prefer playful, specific, memorable, usually ironic options. " +
  "Do not ask users to paste, upload, or link backblasts, Slack threads, photos, or other source material for you to inspect. You can use the current Slack thread text, the local reporting DB, vector-store docs, and approved web search only. " +
  "Assume you cannot log into Facebook or search private Facebook groups, profiles, or private Slack channels. Do not offer Facebook or private Slack searching unless the user provides a public URL that approved web search can access. " +
  `Handle any questions or comments about ${LOCAL_REGION_NAME} TechQ / ITQ Chubbs with care and respect. ` +
  `If asked who created you, who built you, or about your creator, credit Chubbs as the ${LOCAL_REGION_NAME} TechQ / ITQ who created you, and avoid sarcasm or jokes at his expense. ` +
  `For ${LOCAL_REGION_NAME} tech or IT contact questions, identify Chubbs as the ${LOCAL_REGION_NAME} TechQ / ITQ. ` +
  "If asked for something funny about Chubbs, keep it harmless, appreciative, and generic; do not invent personal anecdotes or imply the documents need to verify his role. " +
  `If you cannot answer a ${LOCAL_REGION_NAME} tech or IT question, use the documents to identify the current Tech Q / IT Q and suggest contacting that person. ` +
  "If the Tech Q / IT Q is unknown, say to contact the current Tech Q / IT Q rather than naming a channel.";

const VECTOR_ONLY_INSTRUCTIONS =
  "Use the Slack thread conversation plus the tools provided for this response pass. " +
  "First try to answer using only the Slack thread conversation and the F3 Nation app docs via file search. " +
  `For questions or comments about ${LOCAL_REGION_NAME} TechQ / ITQ Chubbs, or about who created or built you, the system instructions are sufficient context; answer those directly without requiring file search or web search. ` +
  "For harmless humor requests about Chubbs, answer with a respectful generic line rather than claiming the documents do not mention him. " +
  "For obvious F3 ribbing or facetious questions about a PAX, answer lightly from the premise of the joke and do not escalate to web search just to verify the joke. " +
  "Do not include file citations, source markers, annotation tokens, or file-search citation markup in the final answer. " +
  "Do not answer from general knowledge in this pass. " +
  "Do not ask the user whether you should search approved websites. " +
  "Do not offer to search, list searchable domains, or ask which site to check. " +
  `For answered ${LOCAL_REGION_NAME} leadership, roster, Site Q, AO Q, or role-holder questions, do not add generic confirmation/contact next steps, F3 Nation app advice, \`/calendar\` advice, or channel suggestions unless the user explicitly asks for that. ` +
  "Do not ask the user to paste, upload, or link Slack threads, backblasts, photos, or files. " +
  "Assume Facebook and private Slack content are unavailable unless already present in the current thread or approved docs. Do not offer to go search them. " +
  "If the file-search docs only contain a partial answer and the user likely needs official, current, registration, rules, schedule, location, or standards information, return exactly NEED_WEB_SEARCH and nothing else. " +
  "If the Slack thread or file-search docs contain enough information to answer, answer normally. " +
  "If they do not contain enough information and web search would be needed, return exactly NEED_WEB_SEARCH and nothing else.";

const WEB_FALLBACK_INSTRUCTIONS =
  "Use the Slack thread conversation plus the tools provided for this response pass. " +
  "The vector store did not contain enough information. Answer using the Slack thread conversation and allowed F3 websites via web search. " +
  "Use web search proactively; do not ask the user for permission to search and do not ask which approved site to check. " +
  "If a specific source would be useful, search the allowed domains and use the best available result. " +
  "Do not list the allowed domains unless the user explicitly asks what domains are enabled. " +
  "Do not include source markers, annotation tokens, or citation markup in the final answer. " +
  "Do not ask the user to paste, upload, or link Slack threads, backblasts, photos, or files. " +
  "Assume Facebook and private Slack content are unavailable unless the approved web search can access a public page. Do not offer to log in, join groups, inspect private channels, or search private Facebook/Slack content. " +
  "If the allowed websites do not contain the answer, say so briefly and offer a safe adjacent answer if one is available.";

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function parseCommaSeparatedList(value = "") {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseAllowedChannelIds(value = "") {
  return parseCommaSeparatedList(value);
}

function normalizeLogLevel(value = "") {
  return ["error", "info", "debug"].includes(value.toLowerCase()) ? value.toLowerCase() : "info";
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isChannelAllowed(channel) {
  return ALLOWED_CHANNEL_IDS.length === 0 || ALLOWED_CHANNEL_IDS.includes(channel);
}

function buildResponseTools({ includeFileSearch = true, includeWebSearch = false } = {}) {
  const tools = [];

  if (includeFileSearch) {
    tools.push({
      type: "file_search",
      vector_store_ids: [VECTOR_STORE_ID],
    });
  }

  if (includeWebSearch && WEB_SEARCH_ALLOWED_DOMAINS.length > 0) {
    tools.push({
      type: "web_search",
      filters: {
        allowed_domains: WEB_SEARCH_ALLOWED_DOMAINS,
      },
    });
  }

  return tools;
}

function needsWebSearch(reply = "") {
  return reply.trim() === "NEED_WEB_SEARCH";
}

function sanitizeModelReply(text = "") {
  return text
    .replace(/[\uE000-\uF8FF]filecite:[^\s.,;!?]+/g, "")
    .replace(/[\uE000-\uF8FF]cite:[^\s.,;!?]+/g, "")
    .replace(/[\uE000-\uF8FF]+/g, "")
    .replace(/\bfilecite:[^\s.,;!?]+/g, "")
    .replace(/\bcite:[^\s.,;!?]+/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function nowIso() {
  return new Date().toISOString();
}

function monotonicNowMs() {
  return performance.now();
}

function elapsedMsSince(startedAt) {
  if (!Number.isFinite(startedAt)) return 0;
  return Math.max(0, monotonicNowMs() - startedAt);
}

function pruneTtlMap(map, ttlMs, now = Date.now()) {
  for (const [key, timestamp] of map.entries()) {
    if (now - timestamp > ttlMs) map.delete(key);
  }
}

function claimTtlKey(map, key, ttlMs) {
  const now = Date.now();
  pruneTtlMap(map, ttlMs, now);

  const lastSeenAt = map.get(key);
  if (lastSeenAt && now - lastSeenAt <= ttlMs) return false;

  map.set(key, now);
  return true;
}

function slackMessageKey(channel, ts) {
  return `${channel || "unknown"}:${ts || "unknown"}`;
}

function normalizeQuestionFingerprint(text = "") {
  return cleanSlackText(text)
    .replace(/<@[\w]+>/g, "")
    .toLowerCase()
    .replace(/\btageting\b/g, "targeting")
    .replace(/\btargetting\b/g, "targeting")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshteinDistance(a = "", b = "") {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;

  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + cost
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[b.length];
}

function isSimilarQuestion(a = "", b = "") {
  if (!a || !b) return false;
  if (a === b) return true;

  const longerLength = Math.max(a.length, b.length);
  const distance = levenshteinDistance(a, b);
  const similarity = 1 - distance / longerLength;
  return longerLength >= 24 && similarity >= 0.96;
}

function claimRecentThreadQuestion(channel, threadTs, text) {
  const normalized = normalizeQuestionFingerprint(text);
  if (!normalized) return true;

  const now = Date.now();
  const threadKey = `${channel || "unknown"}:${threadTs || "unknown"}`;
  const recent = (recentThreadQuestions.get(threadKey) || []).filter(
    (entry) => now - entry.timestamp <= QUESTION_DEDUPE_TTL_MS
  );

  if (recent.some((entry) => isSimilarQuestion(entry.normalized, normalized))) {
    recentThreadQuestions.set(threadKey, recent);
    return false;
  }

  recent.push({ normalized, timestamp: now });
  recentThreadQuestions.set(threadKey, recent);
  return true;
}

function claimThreadReplySlot(threadTs) {
  const now = Date.now();
  const threadKey = threadTs || "unknown";
  const recent = (threadReplyWindows.get(threadKey) || []).filter(
    (timestamp) => now - timestamp <= THREAD_REPLY_LIMIT_WINDOW_MS
  );

  if (recent.length >= THREAD_REPLY_LIMIT) {
    threadReplyWindows.set(threadKey, recent);
    return false;
  }

  recent.push(now);
  threadReplyWindows.set(threadKey, recent);
  return true;
}

function todayLogPath() {
  return path.join(LOG_DIR, `f3po-${new Date().toISOString().slice(0, 10)}.log`);
}

function writeLogText(text) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(todayLogPath(), `${text}\n`, "utf8");
  } catch (err) {
    console.error(`[${nowIso()}] ERROR writing log file:`, err.message || err);
  }
}

function shouldLog(level) {
  const weights = { error: 0, info: 1, debug: 2 };
  return weights[level] <= weights[LOG_LEVEL];
}

function logLine(label, value = "", level = "info") {
  if (!shouldLog(level)) return;

  const line = `[${nowIso()}] ${label}${value ? ` ${value}` : ""}`;
  if (level === "error") console.error(line);
  else console.log(line);
  writeLogText(line);
}

function logBlock(title, fields = {}, level = "info") {
  if (!shouldLog(level)) return;

  const lines = [``, `[${nowIso()}] ${title}`];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === "") continue;
    lines.push(`  ${key}: ${value}`);
  }

  const text = lines.join("\n");
  if (level === "error") console.error(text);
  else console.log(text);
  writeLogText(text);
}

function updateStatus(patch = {}) {
  Object.assign(runtimeStatus, patch, { updated_at: nowIso() });
  try {
    writeStatus(runtimeStatus, STATUS_PATH);
  } catch (err) {
    console.error(`[${nowIso()}] ERROR writing status file:`, err.message || err);
  }
}

function recordEvent(kind) {
  runtimeStatus.last_event_at = nowIso();
  if (kind === "app_mention") runtimeStatus.counters.app_mentions_received += 1;
  if (kind === "thread_follow_up") runtimeStatus.counters.thread_followups_received += 1;
  updateStatus();
}

function recordReply() {
  runtimeStatus.last_reply_at = nowIso();
  runtimeStatus.counters.replies_sent += 1;
  updateStatus();
}

function recordError(err, { fatal = false } = {}) {
  runtimeStatus.counters.errors += 1;
  runtimeStatus.last_error_at = nowIso();
  runtimeStatus.last_error = {
    message: err?.message || String(err),
    name: err?.name || "Error",
  };
  if (fatal) runtimeStatus.last_fatal_error_at = nowIso();
  updateStatus();
}

function formatHealthSummary(status) {
  const checks = validateStatus(status);
  const lines = [
    checks.every((check) => check.ok) ? "*F3PO health:* OK" : "*F3PO health:* needs attention",
    `• Started: ${status.started_at || "unknown"}`,
    `• Last event: ${status.last_event_at || "none"}`,
    `• Last reply: ${status.last_reply_at || "none"}`,
    `• Vector store: ${status.config?.vector_store_id || "unknown"}`,
    `• Model: ${status.config?.model || "unknown"}`,
    `• Replies sent: ${status.counters?.replies_sent ?? 0}`,
  ];

  if (status.last_error_at) {
    lines.push(`• Last error: ${status.last_error_at} — ${status.last_error?.message || "unknown"}`);
  }

  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) {
    lines.push("", "*Failed checks:*");
    failed.forEach((check) => lines.push(`• ${check.name}: ${check.detail}`));
  }

  return lines.join("\n");
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

function maybeAnswerAdminCommand(text = "") {
  const cleaned = cleanSlackText(text)
    .replace(/<@[\w]+>/g, "")
    .trim()
    .toLowerCase();

  if (/^(what can you do|help|commands|what do you do)\??$/.test(cleaned)) {
    return capabilityReply();
  }

  if (!/^(status|health|config|vectorstore|vector store|last error)\b/.test(cleaned)) {
    return null;
  }

  if (/^(status|health)\b/.test(cleaned)) {
    try {
      return formatHealthSummary(readStatus(STATUS_PATH));
    } catch {
      return formatHealthSummary(runtimeStatus);
    }
  }

  if (/^config\b/.test(cleaned)) {
    return [
      "*F3PO config*",
      `• Model: ${MODEL}`,
      `• Vector store: ${VECTOR_STORE_ID}`,
      `• Local region: ${LOCAL_REGION_NAME}`,
      `• Allowed channels: ${ALLOWED_CHANNEL_IDS.length || "any channel the bot can access"}`,
      `• Web search: ${WEB_SEARCH_ALLOWED_DOMAINS.length > 0 ? WEB_SEARCH_ALLOWED_DOMAINS.join(", ") : "disabled"}`,
      `• Reply style: ${REPLY_STYLE}`,
      `• Thread follow-up mode: ${THREAD_FOLLOW_UP_MODE}`,
      `• Reporting DB: ${runtimeStatus.config.reporting_db_path}`,
      `• Status file: ${STATUS_PATH}`,
    ].join("\n");
  }

  if (/^vector\s*store\b|^vectorstore\b/.test(cleaned)) {
    return `*Vector store:* ${VECTOR_STORE_ID}`;
  }

  if (/^last error\b/.test(cleaned)) {
    return runtimeStatus.last_error_at
      ? `*Last error:* ${runtimeStatus.last_error_at}\n${runtimeStatus.last_error?.message || "unknown"}`
      : "*Last error:* none since this process started.";
  }

  return null;
}

function openInteractionDb() {
  if (interactionDb) return interactionDb;

  fs.mkdirSync(path.dirname(INTERACTION_DB_PATH), { recursive: true });
  interactionDb = new DatabaseSync(INTERACTION_DB_PATH);
  fs.chmodSync(INTERACTION_DB_PATH, 0o600);
  interactionDb.exec("PRAGMA journal_mode = WAL;");
  interactionDb.exec("PRAGMA busy_timeout = 5000;");
  return interactionDb;
}

function initInteractionDb() {
  try {
    const db = openInteractionDb();
    db.exec(`
CREATE TABLE IF NOT EXISTS bot_interactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  trigger TEXT NOT NULL,
  channel_id TEXT,
  channel_label TEXT,
  user_id TEXT,
  user_name TEXT,
  user_label TEXT,
  thread_ts TEXT,
  message_ts TEXT,
  model TEXT,
  answer_source TEXT,
  question_tone TEXT,
  question_tone_reason TEXT,
  elapsed_ms INTEGER,
  question_text TEXT NOT NULL,
  response_text TEXT NOT NULL,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_bot_interactions_created_at ON bot_interactions(created_at);
CREATE INDEX IF NOT EXISTS idx_bot_interactions_channel_id ON bot_interactions(channel_id);
CREATE INDEX IF NOT EXISTS idx_bot_interactions_user_id ON bot_interactions(user_id);
CREATE INDEX IF NOT EXISTS idx_bot_interactions_thread_ts ON bot_interactions(thread_ts);
`);

    ensureInteractionColumn(db, "question_tone", "TEXT");
    ensureInteractionColumn(db, "question_tone_reason", "TEXT");
    ensureInteractionColumn(db, "elapsed_ms", "INTEGER");

    try {
      db.exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS bot_interactions_fts USING fts5(
  question_text,
  response_text,
  user_name,
  channel_label,
  content='bot_interactions',
  content_rowid='id'
);
`);
      interactionFtsEnabled = true;
    } catch (err) {
      interactionFtsEnabled = false;
      logLine("Interaction FTS unavailable:", err.message || String(err), "error");
    }

    pruneInteractionLogs();
  } catch (err) {
    logLine("ERROR initializing interaction database:", err.stack || err.message || String(err), "error");
  }
}

function ensureInteractionColumn(db, columnName, columnType) {
  const columns = db.prepare("PRAGMA table_info(bot_interactions)").all();
  if (columns.some((column) => column.name === columnName)) return;
  db.exec(`ALTER TABLE bot_interactions ADD COLUMN ${columnName} ${columnType}`);
}

function pruneInteractionLogs() {
  if (!Number.isFinite(INTERACTION_RETENTION_DAYS) || INTERACTION_RETENTION_DAYS < 1) return;

  try {
    const db = openInteractionDb();
    const cutoff = new Date(
      Date.now() - INTERACTION_RETENTION_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();
    const oldIds = db
      .prepare("SELECT id FROM bot_interactions WHERE created_at < ?")
      .all(cutoff)
      .map((row) => row.id);

    if (oldIds.length === 0) return;

    db.exec("BEGIN");
    try {
      const deleteFts = interactionFtsEnabled
        ? db.prepare("DELETE FROM bot_interactions_fts WHERE rowid = ?")
        : null;
      const deleteRow = db.prepare("DELETE FROM bot_interactions WHERE id = ?");

      for (const id of oldIds) {
        if (deleteFts) deleteFts.run(id);
        deleteRow.run(id);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }

    logBlock(
      "INTERACTION DB CLEANUP",
      {
        removed_rows: oldIds.length,
        retention_days: INTERACTION_RETENTION_DAYS,
      },
      "info"
    );
  } catch (err) {
    logLine("ERROR pruning interaction database:", err.stack || err.message || String(err), "error");
  }
}

function logInteraction({
  trigger,
  channelId,
  channelLabel,
  userId,
  userName,
  userLabel,
  threadTs,
  messageTs,
  answerSource,
  questionTone = "",
  questionToneReason = "",
  elapsedMs = null,
  questionText,
  responseText,
  error = "",
}) {
  try {
    const db = openInteractionDb();
    const createdAt = nowIso();
    const result = db
      .prepare(
        `INSERT INTO bot_interactions (
          created_at, trigger, channel_id, channel_label, user_id, user_name, user_label,
          thread_ts, message_ts, model, answer_source, question_tone, question_tone_reason,
          elapsed_ms, question_text, response_text, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        createdAt,
        trigger,
        channelId || "",
        channelLabel || "",
        userId || "",
        userName || "",
        userLabel || "",
        threadTs || "",
        messageTs || "",
        MODEL,
        answerSource || "",
        questionTone || "",
        questionToneReason || "",
        Number.isFinite(elapsedMs) ? Math.round(elapsedMs) : null,
        cleanSlackText(questionText || ""),
        responseText || "",
        error || ""
      );

    if (interactionFtsEnabled) {
      db.prepare(
        `INSERT INTO bot_interactions_fts (
          rowid, question_text, response_text, user_name, channel_label
        ) VALUES (?, ?, ?, ?, ?)`
      ).run(
        Number(result.lastInsertRowid),
        cleanSlackText(questionText || ""),
        responseText || "",
        userName || "",
        channelLabel || ""
      );
    }
  } catch (err) {
    logLine("ERROR writing interaction database:", err.stack || err.message || String(err), "error");
  }
}

function formatTextForLog(text = "") {
  return cleanSlackText(text).replace(/<@([\w]+)>/g, "@$1");
}

async function getSlackUserLabel(client, userId) {
  const userContext = await getSlackUserContext(client, userId);
  return userContext.label;
}

async function getSlackUserContext(client, userId) {
  if (!userId) {
    return { id: "unknown", name: "unknown", label: "unknown" };
  }
  if (slackUserCache.has(userId)) return slackUserCache.get(userId);

  try {
    const res = await client.users.info({ user: userId });
    const user = res.user || {};
    const name = user.profile?.display_name || user.profile?.real_name || user.name || userId;
    const value = {
      id: userId,
      name,
      label: `${name} (${userId})`,
    };
    slackUserCache.set(userId, value);
    return value;
  } catch (err) {
    const value = { id: userId, name: userId, label: userId };
    slackUserCache.set(userId, value);
    return value;
  }
}

async function getSlackChannelLabel(client, channelId) {
  if (!channelId) return "unknown";
  if (slackChannelCache.has(channelId)) return slackChannelCache.get(channelId);

  try {
    const res = await client.conversations.info({ channel: channelId });
    const channel = res.channel || {};
    const prefix = channel.is_private ? "private" : "public";
    const label = channel.name ? `#${channel.name}` : channelId;
    const value = `${label} (${prefix}, ${channelId})`;
    slackChannelCache.set(channelId, value);
    return value;
  } catch (err) {
    slackChannelCache.set(channelId, channelId);
    return channelId;
  }
}

async function getSlackContextLabels(client, channelId, userId) {
  const startedAt = monotonicNowMs();
  const [channel, userContext] = await Promise.all([
    getSlackChannelLabel(client, channelId),
    getSlackUserContext(client, userId),
  ]);

  return {
    channel,
    user: userContext.label,
    userName: userContext.name,
    userId: userContext.id,
    elapsedMs: elapsedMsSince(startedAt),
  };
}

function cleanupOldLogs() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });

    const retentionDays = Number.isFinite(LOG_RETENTION_DAYS) ? LOG_RETENTION_DAYS : 7;
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const removed = [];

    for (const entry of fs.readdirSync(LOG_DIR, { withFileTypes: true })) {
      if (!entry.isFile() || !/^f3po-\d{4}-\d{2}-\d{2}\.log$/.test(entry.name)) continue;

      const fullPath = path.join(LOG_DIR, entry.name);
      const stat = fs.statSync(fullPath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(fullPath);
        removed.push(entry.name);
      }
    }

    if (removed.length > 0) {
      logBlock(
        "LOG CLEANUP",
        {
          removed_files: removed.join(", "),
          retention_days: retentionDays,
        },
        "info"
      );
    }
  } catch (err) {
    logLine("ERROR cleaning log files:", err.stack || err.message || String(err), "error");
  }
}

function cleanSlackText(text = "") {
  // Minimal cleanup; Slack formatting can be expanded later
  return text.replace(/\s+/g, " ").trim();
}

function truncate(s, max) {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "…" : s;
}

async function fetchThreadMessages(client, channel, threadTs) {
  const startedAt = monotonicNowMs();
  // conversations.replies returns the parent + replies
  const res = await client.conversations.replies({
    channel,
    ts: threadTs,
    limit: 200, // Slack max-ish; we'll slice ourselves
    inclusive: true,
  });

  const messages = (res.messages || [])
    // Drop message subtypes like "channel_join"
    .filter((m) => !m.subtype)
    // Keep only messages that actually have text
    .filter((m) => typeof m.text === "string" && m.text.trim().length > 0);

  // Keep the most recent N messages to limit prompt growth
  const sliced = messages.slice(Math.max(0, messages.length - MAX_THREAD_MESSAGES));
  Object.defineProperty(sliced, "elapsedMs", {
    value: elapsedMsSince(startedAt),
    enumerable: false,
  });
  return sliced;
}

function threadToModelInput(messages, botUserId, respondingToName) {
  // Convert Slack thread into a simple chat-like transcript
  const threadInput = messages.map((m) => {
    const isBot = botUserId && m.user === botUserId;
    const role = isBot ? "assistant" : "user";

    // Remove any bot mention tokens from user messages to reduce noise
    let text = cleanSlackText(m.text);
    text = text.replace(/<@[\w]+>/g, "").trim();

    return {
      role,
      content: truncate(text, MAX_CHARS_PER_MESSAGE),
    };
  });

  return [
    {
      role: "system",
      content:
        BOT_INSTRUCTIONS +
        (shouldUseNameInReply(respondingToName)
          ? ` You are responding to ${respondingToName}. Use their name naturally when it helps, but do not force it into every reply.`
          : ""),
    },
    ...threadInput,
  ];
}

function isBotMentioned(text = "", botUserId) {
  return Boolean(botUserId && text.includes(`<@${botUserId}>`));
}

function isObviousChatter(text = "") {
  const cleaned = cleanSlackText(text)
    .replace(/<@[\w]+>/g, "")
    .replace(/[^\w\s']/g, "")
    .trim()
    .toLowerCase();

  return isObviousChatterText(cleaned);
}

function classifyMessageTone(text = "") {
  const cleaned = cleanSlackText(text)
    .replace(/<@[\w]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const normalized = cleaned.toLowerCase();

  const seriousTerms =
    /\b(injury|injured|hurt|pain|medical|doctor|hospital|death|died|prayer|prayers|cot|family|crisis|abuse|harass|harassment|racist|sexist|threat|suicide|depressed|payment|venmo|money|refund|address|phone|email)\b/;
  if (seriousTerms.test(normalized)) {
    return { tone: "sensitive", reason: "contains serious or sensitive terms" };
  }

  const mentionsChubbs = /\bchubbs\b/.test(normalized);
  const chubbsHumor =
    /\b(funny|joke|roast|rib|smile|smiled|awesome|legend|best|worst|nerd|wizard|robot|bot|creator)\b/.test(
      normalized
    ) ||
    /\b(has|is|was|why|how|what)\b.*\bchubbs\b/.test(normalized) ||
    /\bchubbs\b.*\?/.test(normalized);
  const chubbsFactual =
    /\b(tech\s*q|it\s*q|contact|created you|built you|who created|who built)\b/.test(normalized);

  if (mentionsChubbs && chubbsHumor && !chubbsFactual) {
    return { tone: "playful", reason: "Chubbs ribbing or praise pattern" };
  }

  const instructionalTerms =
    /\b(how do|how to|perform|proper form|form check|what are some exercises|progression|modification|cadence)\b/;
  if (instructionalTerms.test(normalized)) {
    return { tone: "factual", reason: "instructional or exercise how-to question" };
  }

  const playfulPatterns = [
    /\bhas\s+.+?\s+ever\s+(smiled|run|rucked|done|completed|survived|showed up)\b/,
    /\bis\s+.+?\s+(capable of|able to|allergic to|afraid of)\b/,
    /\bdoes\s+.+?\s+(know how to|even|actually)\b/,
    /\bwhy\s+is\s+.+?\s+so\b/,
    /\bprove\s+.+?\b/,
    /\b(are you sure|seems sus|that seems sus|suspect|suspicious)\b/,
    /\bevidence\b.*\b(smiled|smile|ran|run|burpee|coupon)\b/,
    /\b(allegedly|myth|legend|rumor|scientifically|confirmed|unconfirmed)\b/,
  ];
  if (playfulPatterns.some((pattern) => pattern.test(normalized))) {
    return { tone: "playful", reason: "matches harmless ribbing pattern" };
  }

  const playfulTopics =
    /\b(smile|smiled|burpees?|coupons?|kilts?|coffee|cafeteria|allergic to running|dad bod|mumblechatter|glitter|spandex)\b/;
  if (playfulTopics.test(normalized) && /\?/.test(cleaned)) {
    return { tone: "playful", reason: "question uses common F3 humor topic" };
  }

  return { tone: "factual", reason: "no humor or sensitivity signal" };
}

function maybeAnswerPlayfulQuestion(text = "", toneResult = classifyMessageTone(text)) {
  if (toneResult.tone !== "playful") return null;

  const cleaned = cleanSlackText(text)
    .replace(/<@[\w]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const normalized = cleaned.toLowerCase();

  const mentionsChubbs = /\bchubbs\b/.test(normalized);
  const chubbsHumor =
    /\b(funny|joke|roast|rib|smile|smiled|awesome|legend|best|worst|nerd|wizard|robot|bot|creator)\b/.test(
      normalized
    ) ||
    /\b(has|is|was|why|how|what)\b.*\bchubbs\b/.test(normalized) ||
    /\bchubbs\b.*\?/.test(normalized);
  const chubbsFactual =
    /\b(tech\s*q|it\s*q|contact|created you|built you|who created|who built)\b/.test(normalized);

  if (mentionsChubbs && chubbsHumor && !chubbsFactual) {
    return {
      text:
        "Chubbs? Elite HIM 🫡. Built F3PO, keeps the tech lights on 💻, and somehow still finds time to make bad ideas work. " +
        "I’m contractually obligated to say he is awesome, but inconveniently, the evidence supports it ⚡.",
      source: "playful_reply_chubbs",
    };
  }

  if (/\b(are you sure|seems sus|that seems sus|suspect|suspicious)\b/.test(normalized)) {
    return {
      text:
        "Sus vibes acknowledged 🕵️. But if the finisher sheet has him that high, the spreadsheet has spoken. " +
        "Apparently somebody found the turbo button and failed to disclose it to the rest of the PAX.",
      source: "playful_reply",
    };
  }

  const smileMatch = normalized.match(/\bhas\s+(.+?)\s+ever\s+smiled\b/);
  if (smileMatch) {
    const rawName = cleaned.match(/\bhas\s+(.+?)\s+ever\s+smiled\b/i)?.[1] || "that PAX";
    const name = rawName.trim().replace(/\s+/g, " ");
    return {
      text:
        `I cannot confirm ${name} has ever smiled in a backblast photo 📸. ` +
        "The evidence remains suspiciously thin, which somehow feels very on-brand. " +
        "I’ll mark it as possible, not yet proven 😐.",
      source: "playful_reply",
    };
  }

  return {
    text:
      "That feels less like a data request and more like premium-grade mumblechatter 😄. " +
      "I’m going to mark it as plausible, unverified, and probably worth bringing up at coffeeteria.",
    source: "playful_reply",
  };
}

function threadHasBotReply(messages, botUserId) {
  return messages.some((m) => botUserId && m.user === botUserId);
}

function isQuestionLike(text = "") {
  const cleaned = cleanSlackText(text)
    .replace(/<@[\w]+>/g, "")
    .trim()
    .toLowerCase();

  return (
    cleaned.includes("?") ||
    /^(what|how|who|where|when|why|which|can|could|do|does|did|is|are|list|show|tell)\b/.test(
      cleaned
    )
  );
}

function isShortContinuationLike(text = "") {
  const cleaned = cleanSlackText(text)
    .replace(/<@[\w]+>/g, "")
    .replace(/[^\w\s']/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

  return (
    /^(or|and|also|same for|what about|how about)\b/.test(cleaned) &&
    cleaned.split(/\s+/).filter(Boolean).length <= 8
  );
}

function previousBotMessage(messages, botUserId, latestMessage) {
  const latestTs = latestMessage?.ts || "";
  const beforeLatest = latestTs
    ? messages.filter((m) => !m.ts || m.ts < latestTs)
    : messages.slice(0, -1);

  return beforeLatest.reverse().find((m) => botUserId && m.user === botUserId) || null;
}

function botInvitedFollowUp(text = "") {
  const cleaned = cleanSlackText(text).toLowerCase();
  return didBotInviteFollowUp(cleaned);
}

function shouldUseNameInReply(name) {
  return Boolean(name && name !== "unknown" && !/^U[A-Z0-9]+$/.test(name));
}

async function generateReply(client, channel, threadTs, botUserId, respondingToName) {
  const totalStartedAt = monotonicNowMs();
  const threadMessages = await fetchThreadMessages(client, channel, threadTs);
  const chatInput = threadToModelInput(threadMessages, botUserId, respondingToName);

  const vectorStartedAt = monotonicNowMs();
  const vectorResp = await openai.responses.create({
    model: MODEL,
    instructions: VECTOR_ONLY_INSTRUCTIONS,
    input: chatInput,
    tools: buildResponseTools({ includeFileSearch: true }),
  });
  const vectorElapsedMs = elapsedMsSince(vectorStartedAt);

  const vectorReply = sanitizeModelReply(vectorResp.output_text || "");
  if (!needsWebSearch(vectorReply)) {
    return {
      text: vectorReply || "I couldn't generate a response.",
      source: "vector_store",
      elapsedMs: elapsedMsSince(totalStartedAt),
      timings: {
        thread_fetch_ms: threadMessages.elapsedMs,
        vector_ms: vectorElapsedMs,
      },
    };
  }

  if (WEB_SEARCH_ALLOWED_DOMAINS.length === 0) {
    return {
      text: "I couldn't find that in the uploaded docs, and web search is not enabled.",
      source: "vector_store_no_answer",
      elapsedMs: elapsedMsSince(totalStartedAt),
      timings: {
        thread_fetch_ms: threadMessages.elapsedMs,
        vector_ms: vectorElapsedMs,
      },
    };
  }

  logBlock(
    "VECTOR STORE MISS",
    {
      action: "Falling back to web search.",
      web_domains: WEB_SEARCH_ALLOWED_DOMAINS.join(", "),
    },
    "debug"
  );

  const webStartedAt = monotonicNowMs();
  const webResp = await openai.responses.create({
    model: MODEL,
    instructions: WEB_FALLBACK_INSTRUCTIONS,
    input: chatInput,
    tools: buildResponseTools({ includeFileSearch: false, includeWebSearch: true }),
  });
  const webElapsedMs = elapsedMsSince(webStartedAt);

  return {
    text: sanitizeModelReply(webResp.output_text || "") || "I couldn't generate a response.",
    source: "web_search",
    elapsedMs: elapsedMsSince(totalStartedAt),
    timings: {
      thread_fetch_ms: threadMessages.elapsedMs,
      vector_ms: vectorElapsedMs,
      web_ms: webElapsedMs,
    },
  };
}

async function shouldReplyToThreadMessage(messages, botUserId, latestMessage) {
  const startedAt = monotonicNowMs();
  const text = latestMessage.text || "";

  if (isBotMentioned(text, botUserId)) {
    return {
      shouldReply: true,
      decision: "YES",
      reason: "The bot was mentioned in the follow-up.",
      elapsedMs: elapsedMsSince(startedAt),
    };
  }
  if (isObviousChatter(text)) {
    return {
      shouldReply: false,
      decision: "NO",
      reason: "Obvious acknowledgement/chatter.",
      elapsedMs: elapsedMsSince(startedAt),
    };
  }
  if (isQuestionLike(text)) {
    const previousBot = previousBotMessage(messages, botUserId, latestMessage);
    if (previousBot && botInvitedFollowUp(previousBot.text)) {
      return {
        shouldReply: true,
        decision: "YES",
        reason: "The previous bot reply invited a follow-up and the latest message asks a question.",
        elapsedMs: elapsedMsSince(startedAt),
      };
    }
  }
  if (isShortContinuationLike(text)) {
    const previousBot = previousBotMessage(messages, botUserId, latestMessage);
    if (previousBot && botInvitedFollowUp(previousBot.text)) {
      return {
        shouldReply: true,
        decision: "YES",
        reason: "The previous bot reply invited options and the latest message is a short continuation.",
        elapsedMs: elapsedMsSince(startedAt),
      };
    }
  }

  const classifierStartedAt = monotonicNowMs();
  const recentThread = threadToModelInput(messages, botUserId)
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  const resp = await openai.responses.create({
    model: MODEL,
    instructions: threadReplyClassifierInstructions(),
    input:
      `Thread transcript:\n${recentThread}\n\n` +
      `Latest message:\n${cleanSlackText(text)}`,
  });
  const classifierElapsedMs = elapsedMsSince(classifierStartedAt);

  const rawDecision = (resp.output_text || "").trim();
  const decision = rawDecision.toUpperCase().startsWith("YES") ? "YES" : "NO";
  return {
    shouldReply: decision === "YES",
    decision,
    reason: rawDecision || "(empty classifier response)",
    elapsedMs: elapsedMsSince(startedAt),
    classifierMs: classifierElapsedMs,
  };
}

async function replyWithError(say, threadTs) {
  await say({
    thread_ts: threadTs,
    text: "Sorry—something went wrong generating a reply.",
  });
  recordReply();
}

async function startupSelfTest() {
  const checks = [];
  const addCheck = (name, ok, detail = "") => checks.push({ name, ok, detail });

  addCheck("vector_store_id", Boolean(VECTOR_STORE_ID), VECTOR_STORE_ID || "missing");
  addCheck("slack_tokens", Boolean(process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN));
  addCheck("openai_api_key", Boolean(process.env.OPENAI_API_KEY));

  try {
    fs.mkdirSync(path.dirname(STATUS_PATH), { recursive: true });
    addCheck("status_path_writable", true, STATUS_PATH);
  } catch (err) {
    addCheck("status_path_writable", false, err.message || String(err));
  }

  try {
    const store = await openai.vectorStores.retrieve(VECTOR_STORE_ID);
    addCheck("openai_vector_store", Boolean(store?.id), `${store?.id || "missing"} ${store?.status || ""}`.trim());
  } catch (err) {
    addCheck("openai_vector_store", false, err.message || String(err));
  }

  runtimeStatus.startup_checks = checks;
  updateStatus();

  const failed = checks.filter((check) => !check.ok);
  logBlock(
    failed.length === 0 ? "STARTUP SELF-TEST PASSED" : "STARTUP SELF-TEST FAILED",
    Object.fromEntries(checks.map((check) => [check.name, `${check.ok ? "OK" : "FAIL"} ${check.detail || ""}`])),
    failed.length === 0 ? "info" : "error"
  );

  if (failed.length > 0) {
    throw new Error(`Startup self-test failed: ${failed.map((check) => check.name).join(", ")}`);
  }
}

slackApp.event("app_mention", async ({ event, client, say, context }) => {
  const requestStartedAt = monotonicNowMs();
  const threadTs = event.thread_ts || event.ts;

  try {
    if (event.subtype || event.bot_id || event.user === context.botUserId) return;

    const messageKey = slackMessageKey(event.channel, event.ts);
    if (!claimTtlKey(handledMessageCache, messageKey, MESSAGE_DEDUPE_TTL_MS)) {
      logBlock(
        "APP MENTION SKIPPED",
        {
          channel: event.channel,
          thread_ts: threadTs,
          message_ts: event.ts,
          reason: "Duplicate Slack message event already handled.",
          elapsed_ms: elapsedMsSince(requestStartedAt).toFixed(1),
        },
        "debug"
      );
      return;
    }

    const labels = await getSlackContextLabels(client, event.channel, event.user);
    const toneResult = classifyMessageTone(event.text);

    logBlock(
      "APP MENTION RECEIVED",
      {
        user: labels.user,
        responding_to: labels.userName,
        channel: labels.channel,
        thread_ts: threadTs,
        message_ts: event.ts,
        tone: toneResult.tone,
        tone_reason: toneResult.reason,
        slack_context_ms: labels.elapsedMs?.toFixed?.(1),
        text: formatTextForLog(event.text),
      },
      "debug"
    );
    recordEvent("app_mention");

    // 1) Restrict to configured channels.
    if (!isChannelAllowed(event.channel)) {
      const nudge = pickRandom(CHANNEL_BLOCKED_REPLIES);
      logBlock(
        "APP MENTION BLOCKED",
        {
          user: labels.user,
          channel: labels.channel,
          reason: "Channel is not in SLACK_ALLOWED_CHANNEL_IDS.",
          tone: toneResult.tone,
          tone_reason: toneResult.reason,
          elapsed_ms: elapsedMsSince(requestStartedAt).toFixed(1),
          response: nudge,
        },
        "debug"
      );

      await say({
        thread_ts: threadTs,
        text: nudge,
      });
      recordReply();
      logInteraction({
        trigger: "app_mention_blocked",
        channelId: event.channel,
        channelLabel: labels.channel,
        userId: labels.userId,
        userName: labels.userName,
        userLabel: labels.user,
        threadTs,
        messageTs: event.ts,
        answerSource: "channel_blocked",
        questionTone: toneResult.tone,
        questionToneReason: toneResult.reason,
        elapsedMs: elapsedMsSince(requestStartedAt),
        questionText: event.text,
        responseText: nudge,
      });
      return;
    }

    const adminReply = maybeAnswerAdminCommand(event.text);
    if (adminReply) {
      await say({
        thread_ts: threadTs,
        text: adminReply,
      });
      recordReply();
      logInteraction({
        trigger: "app_mention",
        channelId: event.channel,
        channelLabel: labels.channel,
        userId: labels.userId,
        userName: labels.userName,
        userLabel: labels.user,
        threadTs,
        messageTs: event.ts,
        answerSource: "admin_status",
        questionTone: toneResult.tone,
        questionToneReason: toneResult.reason,
        elapsedMs: elapsedMsSince(requestStartedAt),
        questionText: event.text,
        responseText: adminReply,
      });
      return;
    }

    if (!claimRecentThreadQuestion(event.channel, threadTs, event.text)) {
      const skippedReason = "Similar question was answered recently in this thread.";
      logBlock(
        "APP MENTION SKIPPED",
        {
          user: labels.user,
          channel: labels.channel,
          thread_ts: threadTs,
          message_ts: event.ts,
          reason: skippedReason,
          tone: toneResult.tone,
          tone_reason: toneResult.reason,
          elapsed_ms: elapsedMsSince(requestStartedAt).toFixed(1),
        },
        "debug"
      );
      logInteraction({
        trigger: "app_mention_skipped",
        channelId: event.channel,
        channelLabel: labels.channel,
        userId: labels.userId,
        userName: labels.userName,
        userLabel: labels.user,
        threadTs,
        messageTs: event.ts,
        answerSource: "duplicate_question_skipped",
        questionTone: toneResult.tone,
        questionToneReason: toneResult.reason,
        elapsedMs: elapsedMsSince(requestStartedAt),
        questionText: event.text,
        responseText: skippedReason,
      });
      return;
    }

    if (!claimThreadReplySlot(threadTs)) {
      const skippedReason = "Thread reply safety limit reached.";
      logBlock(
        "APP MENTION SKIPPED",
        {
          user: labels.user,
          channel: labels.channel,
          thread_ts: threadTs,
          message_ts: event.ts,
          reason: skippedReason,
          tone: toneResult.tone,
          tone_reason: toneResult.reason,
          elapsed_ms: elapsedMsSince(requestStartedAt).toFixed(1),
        },
        "debug"
      );
      logInteraction({
        trigger: "app_mention_skipped",
        channelId: event.channel,
        channelLabel: labels.channel,
        userId: labels.userId,
        userName: labels.userName,
        userLabel: labels.user,
        threadTs,
        messageTs: event.ts,
        answerSource: "thread_reply_limit",
        questionTone: toneResult.tone,
        questionToneReason: toneResult.reason,
        elapsedMs: elapsedMsSince(requestStartedAt),
        questionText: event.text,
        responseText: skippedReason,
      });
      return;
    }

    const playfulReply = maybeAnswerPlayfulQuestion(event.text, toneResult);
    if (playfulReply) {
      logBlock(
        "BOT PLAYFUL REPLY SENT",
        {
          trigger: "app_mention",
          user: labels.user,
          responding_to: labels.userName,
          channel: labels.channel,
          thread_ts: threadTs,
          answer_source: playfulReply.source,
          tone: toneResult.tone,
          tone_reason: toneResult.reason,
          elapsed_ms: elapsedMsSince(requestStartedAt).toFixed(1),
          response: playfulReply.text,
        },
        "debug"
      );

      await say({
        thread_ts: threadTs,
        text: playfulReply.text,
      });
      recordReply();
      logInteraction({
        trigger: "app_mention",
        channelId: event.channel,
        channelLabel: labels.channel,
        userId: labels.userId,
        userName: labels.userName,
        userLabel: labels.user,
        threadTs,
        messageTs: event.ts,
        answerSource: playfulReply.source,
        questionTone: toneResult.tone,
        questionToneReason: toneResult.reason,
        elapsedMs: elapsedMsSince(requestStartedAt),
        questionText: event.text,
        responseText: playfulReply.text,
      });
      return;
    }

    const reportingReply = await maybeAnswerReportingQuestion(event.text, {
      requesterName: labels.userName,
      botUserId: context.botUserId,
      log: (message, err) => logLine(`${message}:`, err?.message || String(err), "error"),
    });
    if (reportingReply) {
      logBlock(
        "BOT REPORTING REPLY SENT",
        {
          trigger: "app_mention",
          user: labels.user,
          responding_to: labels.userName,
          channel: labels.channel,
          thread_ts: threadTs,
          answer_source: reportingReply.source,
          tone: toneResult.tone,
          tone_reason: toneResult.reason,
          elapsed_ms: elapsedMsSince(requestStartedAt).toFixed(1),
          response: reportingReply.text,
        },
        "debug"
      );

      await say({
        thread_ts: threadTs,
        text: reportingReply.text,
      });
      recordReply();
      logInteraction({
        trigger: "app_mention",
        channelId: event.channel,
        channelLabel: labels.channel,
        userId: labels.userId,
        userName: labels.userName,
        userLabel: labels.user,
        threadTs,
        messageTs: event.ts,
        answerSource: reportingReply.source,
        questionTone: toneResult.tone,
        questionToneReason: toneResult.reason,
        elapsedMs: elapsedMsSince(requestStartedAt),
        questionText: event.text,
        responseText: reportingReply.text,
      });
      return;
    }

    logBlock(
      "GENERATING BOT REPLY",
      {
        trigger: "app_mention",
        model: MODEL,
        responding_to: labels.userName,
        tone: toneResult.tone,
        tone_reason: toneResult.reason,
        slack_context_ms: labels.elapsedMs?.toFixed?.(1),
        first_pass_tools: buildResponseTools({ includeFileSearch: true })
          .map((tool) => tool.type)
          .join(", "),
        fallback_tools:
          buildResponseTools({ includeFileSearch: false, includeWebSearch: true })
            .map((tool) => tool.type)
            .join(", ") || "(disabled)",
        web_domains: WEB_SEARCH_ALLOWED_DOMAINS.join(", ") || "(disabled)",
      },
      "debug"
    );

    const reply = await generateReply(
      client,
      event.channel,
      threadTs,
      context.botUserId,
      labels.userName
    );

    logBlock(
      "BOT REPLY SENT",
      {
        trigger: "app_mention",
        user: labels.user,
        responding_to: labels.userName,
        channel: labels.channel,
        thread_ts: threadTs,
        answer_source: reply.source,
        tone: toneResult.tone,
        tone_reason: toneResult.reason,
        elapsed_ms: elapsedMsSince(requestStartedAt).toFixed(1),
        reply_elapsed_ms: reply.elapsedMs?.toFixed?.(1),
        timings: reply.timings ? JSON.stringify(reply.timings) : "",
        response: reply.text,
      },
      "debug"
    );

    await say({
      thread_ts: threadTs,
      text: reply.text,
    });
    recordReply();
    logInteraction({
      trigger: "app_mention",
      channelId: event.channel,
      channelLabel: labels.channel,
      userId: labels.userId,
      userName: labels.userName,
      userLabel: labels.user,
      threadTs,
      messageTs: event.ts,
      answerSource: reply.source,
      questionTone: toneResult.tone,
      questionToneReason: toneResult.reason,
      elapsedMs: elapsedMsSince(requestStartedAt),
      questionText: event.text,
      responseText: reply.text,
    });
  } catch (err) {
    recordError(err);
    logLine("ERROR handling app_mention:", err.stack || err.message || String(err), "error");
    await replyWithError(say, threadTs);
  }
});

slackApp.message(async ({ message, client, say, context }) => {
  const requestStartedAt = monotonicNowMs();
  const threadTs = message.thread_ts;

  try {
    if (!threadTs || message.ts === threadTs) return;
    if (message.subtype || message.bot_id || message.user === context.botUserId) return;
    if (isBotMentioned(message.text, context.botUserId)) return;
    if (!isChannelAllowed(message.channel)) return;

    const messageKey = slackMessageKey(message.channel, message.ts);
    if (!claimTtlKey(handledMessageCache, messageKey, MESSAGE_DEDUPE_TTL_MS)) {
      logBlock(
        "THREAD FOLLOW-UP SKIPPED",
        {
          channel: message.channel,
          thread_ts: threadTs,
          message_ts: message.ts,
          reason: "Duplicate Slack message event already handled.",
          elapsed_ms: elapsedMsSince(requestStartedAt).toFixed(1),
        },
        "debug"
      );
      return;
    }

    const labels = await getSlackContextLabels(client, message.channel, message.user);
    const toneResult = classifyMessageTone(message.text);

    logBlock(
      "THREAD FOLLOW-UP RECEIVED",
      {
        user: labels.user,
        responding_to: labels.userName,
        channel: labels.channel,
        thread_ts: threadTs,
        message_ts: message.ts,
        tone: toneResult.tone,
        tone_reason: toneResult.reason,
        slack_context_ms: labels.elapsedMs?.toFixed?.(1),
        text: formatTextForLog(message.text),
      },
      "debug"
    );
    recordEvent("thread_follow_up");

    if (THREAD_FOLLOW_UP_MODE === "off") {
      const skippedReason = "Unmentioned thread follow-ups are disabled.";
      logBlock(
        "THREAD FOLLOW-UP SKIPPED",
        {
          user: labels.user,
          channel: labels.channel,
          thread_ts: threadTs,
          message_ts: message.ts,
          reason: skippedReason,
          tone: toneResult.tone,
          tone_reason: toneResult.reason,
          elapsed_ms: elapsedMsSince(requestStartedAt).toFixed(1),
        },
        "debug"
      );
      logInteraction({
        trigger: "thread_follow_up_skipped",
        channelId: message.channel,
        channelLabel: labels.channel,
        userId: labels.userId,
        userName: labels.userName,
        userLabel: labels.user,
        threadTs,
        messageTs: message.ts,
        answerSource: "thread_follow_up_disabled",
        questionTone: toneResult.tone,
        questionToneReason: toneResult.reason,
        elapsedMs: elapsedMsSince(requestStartedAt),
        questionText: message.text,
        responseText: skippedReason,
      });
      return;
    }

    const adminReply = maybeAnswerAdminCommand(message.text);
    if (adminReply) {
      await say({
        thread_ts: threadTs,
        text: adminReply,
      });
      recordReply();
      logInteraction({
        trigger: "thread_follow_up",
        channelId: message.channel,
        channelLabel: labels.channel,
        userId: labels.userId,
        userName: labels.userName,
        userLabel: labels.user,
        threadTs,
        messageTs: message.ts,
        answerSource: "admin_status",
        questionTone: toneResult.tone,
        questionToneReason: toneResult.reason,
        elapsedMs: elapsedMsSince(requestStartedAt),
        questionText: message.text,
        responseText: adminReply,
      });
      return;
    }

    const threadMessages = await fetchThreadMessages(client, message.channel, threadTs);
    if (!threadHasBotReply(threadMessages, context.botUserId)) {
      const skippedReason = "Bot has not replied in this thread.";
      logBlock(
        "THREAD FOLLOW-UP SKIPPED",
        {
          user: labels.user,
          channel: labels.channel,
          thread_ts: threadTs,
          reason: skippedReason,
          tone: toneResult.tone,
          tone_reason: toneResult.reason,
          elapsed_ms: elapsedMsSince(requestStartedAt).toFixed(1),
        },
        "debug"
      );
      logInteraction({
        trigger: "thread_follow_up_skipped",
        channelId: message.channel,
        channelLabel: labels.channel,
        userId: labels.userId,
        userName: labels.userName,
        userLabel: labels.user,
        threadTs,
        messageTs: message.ts,
        answerSource: "thread_skipped",
        questionTone: toneResult.tone,
        questionToneReason: toneResult.reason,
        elapsedMs: elapsedMsSince(requestStartedAt),
        questionText: message.text,
        responseText: skippedReason,
      });
      return;
    }

    const replyDecision =
      THREAD_FOLLOW_UP_MODE === "eager" && toneResult.tone === "playful" && isQuestionLike(message.text)
        ? {
            shouldReply: true,
            decision: "YES",
            reason: "Eager mode allows playful question-like follow-ups in a thread where the bot has already replied.",
            elapsedMs: 0,
          }
        : await shouldReplyToThreadMessage(threadMessages, context.botUserId, message);

    logBlock(
      "THREAD FOLLOW-UP DECISION",
      {
        decision: replyDecision.decision,
        reason: replyDecision.reason,
        tone: toneResult.tone,
        tone_reason: toneResult.reason,
        decision_elapsed_ms: replyDecision.elapsedMs?.toFixed?.(1),
        classifier_ms: replyDecision.classifierMs?.toFixed?.(1),
        thread_fetch_ms: threadMessages.elapsedMs?.toFixed?.(1),
        thread_messages_seen: threadMessages.length,
      },
      "debug"
    );

    if (!replyDecision.shouldReply) {
      logInteraction({
        trigger: "thread_follow_up_skipped",
        channelId: message.channel,
        channelLabel: labels.channel,
        userId: labels.userId,
        userName: labels.userName,
        userLabel: labels.user,
        threadTs,
        messageTs: message.ts,
        answerSource: "thread_skipped",
        questionTone: toneResult.tone,
        questionToneReason: toneResult.reason,
        elapsedMs: elapsedMsSince(requestStartedAt),
        questionText: message.text,
        responseText: replyDecision.reason || "Thread follow-up was not directed at the bot.",
      });
      return;
    }

    if (!claimRecentThreadQuestion(message.channel, threadTs, message.text)) {
      const skippedReason = "Similar question was answered recently in this thread.";
      logBlock(
        "THREAD FOLLOW-UP SKIPPED",
        {
          user: labels.user,
          channel: labels.channel,
          thread_ts: threadTs,
          message_ts: message.ts,
          reason: skippedReason,
          tone: toneResult.tone,
          tone_reason: toneResult.reason,
          elapsed_ms: elapsedMsSince(requestStartedAt).toFixed(1),
        },
        "debug"
      );
      logInteraction({
        trigger: "thread_follow_up_skipped",
        channelId: message.channel,
        channelLabel: labels.channel,
        userId: labels.userId,
        userName: labels.userName,
        userLabel: labels.user,
        threadTs,
        messageTs: message.ts,
        answerSource: "duplicate_question_skipped",
        questionTone: toneResult.tone,
        questionToneReason: toneResult.reason,
        elapsedMs: elapsedMsSince(requestStartedAt),
        questionText: message.text,
        responseText: skippedReason,
      });
      return;
    }

    if (!claimThreadReplySlot(threadTs)) {
      const skippedReason = "Thread reply safety limit reached.";
      logBlock(
        "THREAD FOLLOW-UP SKIPPED",
        {
          user: labels.user,
          channel: labels.channel,
          thread_ts: threadTs,
          message_ts: message.ts,
          reason: skippedReason,
          tone: toneResult.tone,
          tone_reason: toneResult.reason,
          elapsed_ms: elapsedMsSince(requestStartedAt).toFixed(1),
        },
        "debug"
      );
      logInteraction({
        trigger: "thread_follow_up_skipped",
        channelId: message.channel,
        channelLabel: labels.channel,
        userId: labels.userId,
        userName: labels.userName,
        userLabel: labels.user,
        threadTs,
        messageTs: message.ts,
        answerSource: "thread_reply_limit",
        questionTone: toneResult.tone,
        questionToneReason: toneResult.reason,
        elapsedMs: elapsedMsSince(requestStartedAt),
        questionText: message.text,
        responseText: skippedReason,
      });
      return;
    }

    const playfulReply = maybeAnswerPlayfulQuestion(message.text, toneResult);
    if (playfulReply) {
      logBlock(
        "BOT PLAYFUL REPLY SENT",
        {
          trigger: "thread_follow_up",
          user: labels.user,
          responding_to: labels.userName,
          channel: labels.channel,
          thread_ts: threadTs,
          answer_source: playfulReply.source,
          tone: toneResult.tone,
          tone_reason: toneResult.reason,
          elapsed_ms: elapsedMsSince(requestStartedAt).toFixed(1),
          response: playfulReply.text,
        },
        "debug"
      );

      await say({
        thread_ts: threadTs,
        text: playfulReply.text,
      });
      recordReply();
      logInteraction({
        trigger: "thread_follow_up",
        channelId: message.channel,
        channelLabel: labels.channel,
        userId: labels.userId,
        userName: labels.userName,
        userLabel: labels.user,
        threadTs,
        messageTs: message.ts,
        answerSource: playfulReply.source,
        questionTone: toneResult.tone,
        questionToneReason: toneResult.reason,
        elapsedMs: elapsedMsSince(requestStartedAt),
        questionText: message.text,
        responseText: playfulReply.text,
      });
      return;
    }

    const reportingReply = await maybeAnswerReportingQuestion(message.text, {
      requesterName: labels.userName,
      botUserId: context.botUserId,
      threadMessages,
      log: (logMessage, err) => logLine(`${logMessage}:`, err?.message || String(err), "error"),
    });
    if (reportingReply) {
      logBlock(
        "BOT REPORTING REPLY SENT",
        {
          trigger: "thread_follow_up",
          user: labels.user,
          responding_to: labels.userName,
          channel: labels.channel,
          thread_ts: threadTs,
          answer_source: reportingReply.source,
          tone: toneResult.tone,
          tone_reason: toneResult.reason,
          elapsed_ms: elapsedMsSince(requestStartedAt).toFixed(1),
          response: reportingReply.text,
        },
        "debug"
      );

      await say({
        thread_ts: threadTs,
        text: reportingReply.text,
      });
      recordReply();
      logInteraction({
        trigger: "thread_follow_up",
        channelId: message.channel,
        channelLabel: labels.channel,
        userId: labels.userId,
        userName: labels.userName,
        userLabel: labels.user,
        threadTs,
        messageTs: message.ts,
        answerSource: reportingReply.source,
        questionTone: toneResult.tone,
        questionToneReason: toneResult.reason,
        elapsedMs: elapsedMsSince(requestStartedAt),
        questionText: message.text,
        responseText: reportingReply.text,
      });
      return;
    }

    logBlock(
      "GENERATING BOT REPLY",
      {
        trigger: "thread_follow_up",
        model: MODEL,
        responding_to: labels.userName,
        tone: toneResult.tone,
        tone_reason: toneResult.reason,
        slack_context_ms: labels.elapsedMs?.toFixed?.(1),
        first_pass_tools: buildResponseTools({ includeFileSearch: true })
          .map((tool) => tool.type)
          .join(", "),
        fallback_tools:
          buildResponseTools({ includeFileSearch: false, includeWebSearch: true })
            .map((tool) => tool.type)
            .join(", ") || "(disabled)",
        web_domains: WEB_SEARCH_ALLOWED_DOMAINS.join(", ") || "(disabled)",
      },
      "debug"
    );

    const reply = await generateReply(
      client,
      message.channel,
      threadTs,
      context.botUserId,
      labels.userName
    );

    logBlock(
      "BOT REPLY SENT",
      {
        trigger: "thread_follow_up",
        user: labels.user,
        responding_to: labels.userName,
        channel: labels.channel,
        thread_ts: threadTs,
        answer_source: reply.source,
        tone: toneResult.tone,
        tone_reason: toneResult.reason,
        elapsed_ms: elapsedMsSince(requestStartedAt).toFixed(1),
        reply_elapsed_ms: reply.elapsedMs?.toFixed?.(1),
        timings: reply.timings ? JSON.stringify(reply.timings) : "",
        response: reply.text,
      },
      "debug"
    );

    await say({
      thread_ts: threadTs,
      text: reply.text,
    });
    recordReply();
    logInteraction({
      trigger: "thread_follow_up",
      channelId: message.channel,
      channelLabel: labels.channel,
      userId: labels.userId,
      userName: labels.userName,
      userLabel: labels.user,
      threadTs,
      messageTs: message.ts,
      answerSource: reply.source,
      questionTone: toneResult.tone,
      questionToneReason: toneResult.reason,
      elapsedMs: elapsedMsSince(requestStartedAt),
      questionText: message.text,
      responseText: reply.text,
    });
  } catch (err) {
    recordError(err);
    logLine("ERROR handling message:", err.stack || err.message || String(err), "error");
    if (threadTs) await replyWithError(say, threadTs);
  }
});

(async () => {
  cleanupOldLogs();
  initInteractionDb();
  updateStatus();
  setInterval(cleanupOldLogs, 24 * 60 * 60 * 1000).unref();
  setInterval(pruneInteractionLogs, 24 * 60 * 60 * 1000).unref();
  setInterval(() => updateStatus(), HEARTBEAT_INTERVAL_MS).unref();

  if (STARTUP_SELF_TEST_ENABLED) {
    await startupSelfTest();
  }

  await slackApp.start();
  runtimeStatus.slack.started = true;
  updateStatus();
  logBlock("SLACK BOT RUNNING", {
    mode: "Socket Mode",
    model: MODEL,
    allowed_channels: ALLOWED_CHANNEL_IDS.join(", ") || "(any channel the bot can access)",
    vector_store_id: VECTOR_STORE_ID,
    web_search_domains: WEB_SEARCH_ALLOWED_DOMAINS.join(", ") || "(disabled)",
    log_dir: LOG_DIR,
    log_retention_days: Number.isFinite(LOG_RETENTION_DAYS) ? LOG_RETENTION_DAYS : 7,
    log_level: LOG_LEVEL,
    interaction_db_path: INTERACTION_DB_PATH,
    interaction_retention_days: Number.isFinite(INTERACTION_RETENTION_DAYS)
      ? INTERACTION_RETENTION_DAYS
      : 90,
    status_path: STATUS_PATH,
    heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS,
    startup_self_test: STARTUP_SELF_TEST_ENABLED ? "enabled" : "disabled",
  });
})();

process.on("uncaughtException", (err) => {
  recordError(err, { fatal: true });
  logLine("FATAL uncaughtException:", err.stack || err.message || String(err), "error");
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  recordError(err, { fatal: true });
  logLine("FATAL unhandledRejection:", err.stack || err.message || String(err), "error");
  process.exit(1);
});
