require("dotenv").config();

const { App } = require("@slack/bolt");
const OpenAI = require("openai");

const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const ALLOWED_CHANNEL_ID = process.env.SLACK_ALLOWED_CHANNEL_ID;

// Basic safety: keep thread context bounded
const MAX_THREAD_MESSAGES = 20; // newest 20 messages in the thread
const MAX_CHARS_PER_MESSAGE = 2000;

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

slackApp.event("app_mention", async ({ event, client, say, context }) => {
  try {
    const SNARKY_REPLIES = [
      "👀 PAX, take this to #tech-help. That’s the designated AO for questions like this.",
      "🫡 Respectfully: wrong channel. Bring it to #tech-help so we can stay on mission.",
      "🥾 Let’s not mumblechatter in here—post it in #tech-help and tag me there.",
      "📣 Hold up, HIM. I only operate in #tech-help. Re-post there and we’ll get after it.",
      "⏱️ Time hack: ask me in #tech-help. That’s where the tech PAX are congregating.",
    ];

    function pickRandom(arr) {
      return arr[Math.floor(Math.random() * arr.length)];
    }

    // 1) Restrict to #tech-help (but reply elsewhere with a nudge)
    if (ALLOWED_CHANNEL_ID && event.channel !== ALLOWED_CHANNEL_ID) {
      await say({
        thread_ts: event.thread_ts || event.ts,
        text: pickRandom(SNARKY_REPLIES),
      });
      return;
    }

    // 2) Determine thread timestamp
    // If mention is in a thread, use thread_ts; else start a new thread at this message
    const threadTs = event.thread_ts || event.ts;

    // 3) Fetch thread history to build context
    const botUserId = context.botUserId; // provided by Bolt
    const threadMessages = await fetchThreadMessages(client, event.channel, threadTs);
    const chatInput = threadToModelInput(threadMessages, botUserId);

    // 4) Call OpenAI with thread context
    const resp = await openai.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-5-mini",
      instructions:
        "You are the designated Q for #tech-help—here to keep PAX off the injury list (and out of the wrong menu). " +
        "Answer using (1) the Slack thread conversation and (2) the F3 Nation app docs via file search. " +
        "Be concise, practical, and lightly dry-humored." +
        "If the docs don’t contain the answer, say so and ask one targeted question." +
        "Stay on topic. Do not drift to discussing non-F3 topics.",

      // Slack thread context (messages from the thread)
      input: chatInput,

      // RAG: enable file search against your vector store
      tools: [
        {
          type: "file_search",
          vector_store_ids: [process.env.VECTOR_STORE_ID],
        },
      ],
    });

    const reply = (resp.output_text || "").trim() || "I couldn't generate a response.";

    // 5) Reply in the thread
    await say({
      thread_ts: threadTs,
      text: reply,
    });
  } catch (err) {
    console.error(err);
    // Reply in-thread if possible
    await say({
      thread_ts: event.thread_ts || event.ts,
      text: "Sorry—something went wrong generating a reply.",
    });
  }
});

(async () => {
  await slackApp.start();
  console.log("⚡️ Slack bot running (Socket Mode).");
})();