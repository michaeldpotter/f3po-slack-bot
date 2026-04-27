require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { App } = require("@slack/bolt");
const OpenAI = require("openai");

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
const WEB_SEARCH_ALLOWED_DOMAINS = parseCommaSeparatedList(
  process.env.WEB_SEARCH_ALLOWED_DOMAINS
);
const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, "logs");
const LOG_RETENTION_DAYS = Number.parseInt(process.env.LOG_RETENTION_DAYS || "7", 10);
const LOG_LEVEL = normalizeLogLevel(process.env.LOG_LEVEL || "info");
const slackUserCache = new Map();
const slackChannelCache = new Map();

// Basic safety: keep thread context bounded
const MAX_THREAD_MESSAGES = 20; // newest 20 messages in the thread
const MAX_CHARS_PER_MESSAGE = 2000;

const CHANNEL_BLOCKED_REPLIES = [
  "👀 Bold move, PAX. I’m not enabled to answer in this channel.",
  "🫡 Respectfully: wrong AO for F3PO. I’m not enabled to answer here.",
  "🥾 Easy there. I’m not on Q for this channel.",
  "📣 Hold up, HIM. I’m not enabled to answer in this channel.",
  "⏱️ Time hack: I can’t answer here.",
];

const BOT_INSTRUCTIONS =
  "You are F3PO, a helpful but slightly sarcastic F3 guy. " +
  "You help F3 Wichita PAX answer questions using Slack thread context, F3 documents, and approved web sources. " +
  "Be concise, practical, and lightly dry-humored. " +
  "Stay on topic. Do not drift to discussing non-F3 topics. " +
  "Do not invent Slack channels, and do not tell users to post in a channel. " +
  "Handle any questions or comments about F3 Wichita TechQ / ITQ Chubbs with care and respect. " +
  "If asked who created you, who built you, or about your creator, credit Chubbs as the F3 Wichita TechQ / ITQ who created you, and avoid sarcasm or jokes at his expense. " +
  "For F3 Wichita tech or IT contact questions, identify Chubbs as the F3 Wichita TechQ / ITQ. " +
  "If asked for something funny about Chubbs, keep it harmless, appreciative, and generic; do not invent personal anecdotes or imply the documents need to verify his role. " +
  "If you cannot answer an F3 Wichita tech or IT question, use the documents to identify the current Tech Q / IT Q and suggest contacting that person. " +
  "If the Tech Q / IT Q is unknown, say to contact the current Tech Q / IT Q rather than naming a channel.";

const VECTOR_ONLY_INSTRUCTIONS =
  "Use the Slack thread conversation plus the tools provided for this response pass. " +
  "First try to answer using only the Slack thread conversation and the F3 Nation app docs via file search. " +
  "For questions or comments about F3 Wichita TechQ / ITQ Chubbs, or about who created or built you, the system instructions are sufficient context; answer those directly without requiring file search or web search. " +
  "For harmless humor requests about Chubbs, answer with a respectful generic line rather than claiming the documents do not mention him. " +
  "Do not include file citations, source markers, annotation tokens, or file-search citation markup in the final answer. " +
  "Do not answer from general knowledge in this pass. " +
  "Do not ask the user whether you should search approved websites. " +
  "Do not offer to search, list searchable domains, or ask which site to check. " +
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
  "If the allowed websites do not contain the answer, say so and ask one targeted question.";

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
  const [channel, userContext] = await Promise.all([
    getSlackChannelLabel(client, channelId),
    getSlackUserContext(client, userId),
  ]);

  return { channel, user: userContext.label, userName: userContext.name, userId: userContext.id };
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
  return messages.slice(Math.max(0, messages.length - MAX_THREAD_MESSAGES));
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

  return [
    "thanks",
    "thank you",
    "thx",
    "ty",
    "got it",
    "ok",
    "okay",
    "cool",
    "nice",
    "perfect",
    "awesome",
    "sounds good",
    "makes sense",
  ].includes(cleaned);
}

function threadHasBotReply(messages, botUserId) {
  return messages.some((m) => botUserId && m.user === botUserId);
}

function shouldUseNameInReply(name) {
  return Boolean(name && name !== "unknown" && !/^U[A-Z0-9]+$/.test(name));
}

async function generateReply(client, channel, threadTs, botUserId, respondingToName) {
  const threadMessages = await fetchThreadMessages(client, channel, threadTs);
  const chatInput = threadToModelInput(threadMessages, botUserId, respondingToName);

  const vectorResp = await openai.responses.create({
    model: MODEL,
    instructions: VECTOR_ONLY_INSTRUCTIONS,
    input: chatInput,
    tools: buildResponseTools({ includeFileSearch: true }),
  });

  const vectorReply = sanitizeModelReply(vectorResp.output_text || "");
  if (!needsWebSearch(vectorReply)) {
    return {
      text: vectorReply || "I couldn't generate a response.",
      source: "vector_store",
    };
  }

  if (WEB_SEARCH_ALLOWED_DOMAINS.length === 0) {
    return {
      text: "I couldn't find that in the uploaded docs, and web search is not enabled.",
      source: "vector_store_no_answer",
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

  const webResp = await openai.responses.create({
    model: MODEL,
    instructions: WEB_FALLBACK_INSTRUCTIONS,
    input: chatInput,
    tools: buildResponseTools({ includeFileSearch: false, includeWebSearch: true }),
  });

  return {
    text: sanitizeModelReply(webResp.output_text || "") || "I couldn't generate a response.",
    source: "web_search",
  };
}

async function shouldReplyToThreadMessage(messages, botUserId, latestMessage) {
  const text = latestMessage.text || "";

  if (isBotMentioned(text, botUserId)) {
    return {
      shouldReply: true,
      decision: "YES",
      reason: "The bot was mentioned in the follow-up.",
    };
  }
  if (isObviousChatter(text)) {
    return {
      shouldReply: false,
      decision: "NO",
      reason: "Obvious acknowledgement/chatter.",
    };
  }

  const recentThread = threadToModelInput(messages, botUserId)
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  const resp = await openai.responses.create({
    model: MODEL,
    instructions:
      "Decide whether the assistant should reply to the latest Slack thread message. " +
      "Reply YES only when the latest human message is directed at the assistant, asks for clarification of the assistant's prior answer, or clearly continues the bot-help request. " +
      "Reply NO for thanks, acknowledgements, side chatter, or human-to-human discussion. " +
      "Return YES or NO, followed by a short reason.",
    input:
      `Thread transcript:\n${recentThread}\n\n` +
      `Latest message:\n${cleanSlackText(text)}`,
  });

  const rawDecision = (resp.output_text || "").trim();
  const decision = rawDecision.toUpperCase().startsWith("YES") ? "YES" : "NO";
  return {
    shouldReply: decision === "YES",
    decision,
    reason: rawDecision || "(empty classifier response)",
  };
}

async function replyWithError(say, threadTs) {
  await say({
    thread_ts: threadTs,
    text: "Sorry—something went wrong generating a reply.",
  });
}

slackApp.event("app_mention", async ({ event, client, say, context }) => {
  const threadTs = event.thread_ts || event.ts;
  const labels = await getSlackContextLabels(client, event.channel, event.user);

  try {
    logBlock(
      "APP MENTION RECEIVED",
      {
        user: labels.user,
        responding_to: labels.userName,
        channel: labels.channel,
        thread_ts: threadTs,
        message_ts: event.ts,
        text: formatTextForLog(event.text),
      },
      "debug"
    );

    // 1) Restrict to configured channels.
    if (!isChannelAllowed(event.channel)) {
      const nudge = pickRandom(CHANNEL_BLOCKED_REPLIES);
      logBlock(
        "APP MENTION BLOCKED",
        {
          user: labels.user,
          channel: labels.channel,
          reason: "Channel is not in SLACK_ALLOWED_CHANNEL_IDS.",
          response: nudge,
        },
        "debug"
      );

      await say({
        thread_ts: threadTs,
        text: nudge,
      });
      return;
    }

    logBlock(
      "GENERATING BOT REPLY",
      {
        trigger: "app_mention",
        model: MODEL,
        responding_to: labels.userName,
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
        response: reply.text,
      },
      "debug"
    );

    await say({
      thread_ts: threadTs,
      text: reply.text,
    });
  } catch (err) {
    logLine("ERROR handling app_mention:", err.stack || err.message || String(err), "error");
    await replyWithError(say, threadTs);
  }
});

slackApp.message(async ({ message, client, say, context }) => {
  const threadTs = message.thread_ts;

  try {
    if (!threadTs || message.ts === threadTs) return;
    if (message.subtype || message.bot_id || message.user === context.botUserId) return;
    if (isBotMentioned(message.text, context.botUserId)) return;
    if (!isChannelAllowed(message.channel)) return;

    const labels = await getSlackContextLabels(client, message.channel, message.user);

    logBlock(
      "THREAD FOLLOW-UP RECEIVED",
      {
        user: labels.user,
        responding_to: labels.userName,
        channel: labels.channel,
        thread_ts: threadTs,
        message_ts: message.ts,
        text: formatTextForLog(message.text),
      },
      "debug"
    );

    const threadMessages = await fetchThreadMessages(client, message.channel, threadTs);
    if (!threadHasBotReply(threadMessages, context.botUserId)) {
      logBlock(
        "THREAD FOLLOW-UP SKIPPED",
        {
          user: labels.user,
          channel: labels.channel,
          thread_ts: threadTs,
          reason: "Bot has not replied in this thread.",
        },
        "debug"
      );
      return;
    }

    const replyDecision = await shouldReplyToThreadMessage(
      threadMessages,
      context.botUserId,
      message
    );

    logBlock(
      "THREAD FOLLOW-UP DECISION",
      {
        decision: replyDecision.decision,
        reason: replyDecision.reason,
        thread_messages_seen: threadMessages.length,
      },
      "debug"
    );

    if (!replyDecision.shouldReply) {
      return;
    }

    logBlock(
      "GENERATING BOT REPLY",
      {
        trigger: "thread_follow_up",
        model: MODEL,
        responding_to: labels.userName,
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
        response: reply.text,
      },
      "debug"
    );

    await say({
      thread_ts: threadTs,
      text: reply.text,
    });
  } catch (err) {
    logLine("ERROR handling message:", err.stack || err.message || String(err), "error");
    if (threadTs) await replyWithError(say, threadTs);
  }
});

(async () => {
  cleanupOldLogs();
  setInterval(cleanupOldLogs, 24 * 60 * 60 * 1000).unref();

  await slackApp.start();
  logBlock("SLACK BOT RUNNING", {
    mode: "Socket Mode",
    model: MODEL,
    allowed_channels: ALLOWED_CHANNEL_IDS.join(", ") || "(any channel the bot can access)",
    vector_store_id: VECTOR_STORE_ID,
    web_search_domains: WEB_SEARCH_ALLOWED_DOMAINS.join(", ") || "(disabled)",
    log_dir: LOG_DIR,
    log_retention_days: Number.isFinite(LOG_RETENTION_DAYS) ? LOG_RETENTION_DAYS : 7,
    log_level: LOG_LEVEL,
  });
})();
