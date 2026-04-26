require("dotenv").config();

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

// Basic safety: keep thread context bounded
const MAX_THREAD_MESSAGES = 20; // newest 20 messages in the thread
const MAX_CHARS_PER_MESSAGE = 2000;

const SNARKY_REPLIES = [
  "👀 PAX, take this to #tech-help. That’s the designated AO for questions like this.",
  "🫡 Respectfully: wrong channel. Bring it to #tech-help so we can stay on mission.",
  "🥾 Let’s not mumblechatter in here—post it in #tech-help and tag me there.",
  "📣 Hold up, HIM. I only operate in #tech-help. Re-post there and we’ll get after it.",
  "⏱️ Time hack: ask me in #tech-help. That’s where the tech PAX are congregating.",
];

const BOT_INSTRUCTIONS =
  "You are the designated Q for #tech-help—here to keep PAX off the injury list (and out of the wrong menu). " +
  "Answer using (1) the Slack thread conversation and (2) the F3 Nation app docs via file search. " +
  "Be concise, practical, and lightly dry-humored. " +
  "If the docs don’t contain the answer, say so and ask one targeted question. " +
  "Stay on topic. Do not drift to discussing non-F3 topics.";

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function parseAllowedChannelIds(value = "") {
  return value
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

function isChannelAllowed(channel) {
  return ALLOWED_CHANNEL_IDS.length === 0 || ALLOWED_CHANNEL_IDS.includes(channel);
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

function threadToModelInput(messages, botUserId) {
  // Convert Slack thread into a simple chat-like transcript
  return messages.map((m) => {
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

async function generateReply(client, channel, threadTs, botUserId) {
  const threadMessages = await fetchThreadMessages(client, channel, threadTs);
  const chatInput = threadToModelInput(threadMessages, botUserId);

  const resp = await openai.responses.create({
    model: MODEL,
    instructions: BOT_INSTRUCTIONS,
    input: chatInput,
    tools: [
      {
        type: "file_search",
        vector_store_ids: [VECTOR_STORE_ID],
      },
    ],
  });

  return (resp.output_text || "").trim() || "I couldn't generate a response.";
}

async function shouldReplyToThreadMessage(messages, botUserId, latestMessage) {
  const text = latestMessage.text || "";

  if (isBotMentioned(text, botUserId)) {
    console.log("Thread follow-up: replying because the bot was mentioned.");
    return true;
  }
  if (isObviousChatter(text)) {
    console.log("Thread follow-up: skipping obvious chatter.");
    return false;
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
      "Return only YES or NO.",
    input:
      `Thread transcript:\n${recentThread}\n\n` +
      `Latest message:\n${cleanSlackText(text)}`,
  });

  const decision = (resp.output_text || "").trim().toUpperCase();
  console.log(`Thread follow-up classifier decision: ${decision || "(empty)"}`);
  return decision.startsWith("YES");
}

async function replyWithError(say, threadTs) {
  await say({
    thread_ts: threadTs,
    text: "Sorry—something went wrong generating a reply.",
  });
}

slackApp.event("app_mention", async ({ event, client, say, context }) => {
  const threadTs = event.thread_ts || event.ts;

  try {
    // 1) Restrict to #tech-help (but reply elsewhere with a nudge)
    if (!isChannelAllowed(event.channel)) {
      await say({
        thread_ts: threadTs,
        text: pickRandom(SNARKY_REPLIES),
      });
      return;
    }

    const reply = await generateReply(client, event.channel, threadTs, context.botUserId);

    await say({
      thread_ts: threadTs,
      text: reply,
    });
  } catch (err) {
    console.error(err);
    await replyWithError(say, threadTs);
  }
});

slackApp.message(async ({ message, client, say, context }) => {
  const threadTs = message.thread_ts;

  try {
    if (!threadTs || message.ts === threadTs) return;
    if (message.subtype || message.bot_id || message.user === context.botUserId) return;
    if (!isChannelAllowed(message.channel)) return;

    console.log(
      `Thread follow-up received: channel=${message.channel} thread_ts=${threadTs} user=${message.user}`
    );

    const threadMessages = await fetchThreadMessages(client, message.channel, threadTs);
    if (!threadHasBotReply(threadMessages, context.botUserId)) {
      console.log("Thread follow-up: skipping because bot has not replied in this thread.");
      return;
    }

    const shouldReply = await shouldReplyToThreadMessage(
      threadMessages,
      context.botUserId,
      message
    );
    if (!shouldReply) {
      console.log("Thread follow-up: classifier chose not to reply.");
      return;
    }

    const reply = await generateReply(client, message.channel, threadTs, context.botUserId);

    await say({
      thread_ts: threadTs,
      text: reply,
    });
  } catch (err) {
    console.error(err);
    if (threadTs) await replyWithError(say, threadTs);
  }
});

(async () => {
  await slackApp.start();
  console.log("⚡️ Slack bot running (Socket Mode).");
})();
