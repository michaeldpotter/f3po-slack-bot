// Human-facing behavior knobs for F3PO.
//
// These are intentionally kept separate from the Slack runtime so the "how chatty
// should the bot be?" and "when should it jump into a thread?" levers are easy to
// find and tune without spelunking through event-handler code.

const REPLY_STYLES = new Set(["brief", "normal", "detailed"]);
const THREAD_FOLLOW_UP_MODES = new Set(["off", "conservative", "eager"]);
const DEFAULT_LOCAL_REGION_NAME = "F3 Wichita";
const DEFAULT_WEB_SEARCH_ALLOWED_DOMAINS = ["f3nation.com", "f3wichita.com"];

// Human replies that should not wake the bot back up in a thread.
const OBVIOUS_CHATTER_PHRASES = [
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
];

// Phrases in the bot's previous message that count as a deliberate invitation
// for the user to ask an unmentioned follow-up.
const BOT_INVITED_FOLLOW_UP_PATTERNS = [
  /\bwhich would you like\b/,
  /\bwant me to\b/,
  /\bi can (also )?(show|give|help|explain|walk|pull|answer)\b/,
];

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseCommaSeparatedList(value = "") {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeReplyStyle(value = "") {
  const normalized = value.trim().toLowerCase();
  return REPLY_STYLES.has(normalized) ? normalized : "brief";
}

function normalizeThreadFollowUpMode(value = "") {
  const normalized = value.trim().toLowerCase().replace(/-/g, "_");
  return THREAD_FOLLOW_UP_MODES.has(normalized) ? normalized : "conservative";
}

function loadBotTuning(env = process.env) {
  return {
    // Controls response length and density.
    //
    // brief: default. Short answers for Slack; expands only when the user clearly
    // asks for a list, walkthrough, summary, or deeper explanation.
    // normal: concise, but less strict about length.
    // detailed: allows fuller answers while still avoiding filler.
    replyStyle: normalizeReplyStyle(env.F3PO_REPLY_STYLE || "brief"),

    // Controls unmentioned replies after the bot has already spoken in a thread.
    //
    // off: never answer follow-up thread messages unless the bot is mentioned.
    // conservative: default. Use guardrails/classifier; reply only when the latest
    // message is directed at the bot or clearly continues the bot-help request.
    // eager: also auto-answer playful question-like follow-ups.
    threadFollowUpMode: normalizeThreadFollowUpMode(
      env.F3PO_THREAD_FOLLOW_UP_MODE || "conservative"
    ),

    // Prevent duplicate Slack deliveries from producing duplicate replies.
    // Usually leave this alone unless Slack retries are being mishandled.
    messageDedupeTtlMs: parsePositiveInt(env.MESSAGE_DEDUPE_TTL_MS, 5 * 60 * 1000),

    // Suppress nearly identical questions in the same thread for a short window.
    // Increase if PAX keep double-tapping the same question; decrease if legitimate
    // quick follow-ups are being skipped.
    questionDedupeTtlMs: parsePositiveInt(env.QUESTION_DEDUPE_TTL_MS, 2 * 60 * 1000),

    // Cap how many times F3PO can answer in one thread during a rolling window.
    // This is the main safety brake for runaway or overly chatty threads.
    threadReplyLimit: parsePositiveInt(env.THREAD_REPLY_LIMIT, 4),
    threadReplyLimitWindowMs: parsePositiveInt(env.THREAD_REPLY_LIMIT_WINDOW_MS, 60 * 1000),

    // Bound how much Slack thread history goes into the model prompt.
    // Larger values can improve context, but also increase cost and can make replies
    // more sprawling.
    maxThreadMessages: parsePositiveInt(env.F3PO_MAX_THREAD_MESSAGES, 20),
    maxCharsPerMessage: parsePositiveInt(env.F3PO_MAX_CHARS_PER_MESSAGE, 2000),

    // Local region assumption for broad questions like "show me the schedule next week".
    // This is intentionally a tuning lever because it affects how much context F3PO
    // assumes when a PAX does not name a region.
    localRegionName: String(env.F3PO_LOCAL_REGION_NAME || DEFAULT_LOCAL_REGION_NAME).trim(),

    // Limits web fallback to approved domains only. Override with a comma-separated
    // WEB_SEARCH_ALLOWED_DOMAINS value; set it to an empty string to disable web search.
    webSearchAllowedDomains:
      env.WEB_SEARCH_ALLOWED_DOMAINS === undefined
        ? DEFAULT_WEB_SEARCH_ALLOWED_DOMAINS
        : parseCommaSeparatedList(env.WEB_SEARCH_ALLOWED_DOMAINS),
  };
}

function replyStyleInstruction(style = "brief") {
  if (style === "detailed") {
    return (
      "Be practical and lightly dry-humored. Give enough detail to fully answer the question, but do not pad the reply. "
    );
  }

  if (style === "normal") {
    return (
      "Be concise, practical, and lightly dry-humored. Prefer a short direct answer with only the necessary context. "
    );
  }

  return (
    "Be brief, practical, and lightly dry-humored. Default to 1-2 short paragraphs or no more than 3 compact bullets. " +
    "Keep most replies under 100 words unless the user clearly asks for a list, walkthrough, summary, or deeper explanation. "
  );
}

function threadReplyClassifierInstructions() {
  return (
    "Decide whether the assistant should reply to the latest Slack thread message. " +
    "Reply YES only when the latest human message is directed at the assistant, asks for clarification of the assistant's prior answer, or clearly continues the bot-help request. " +
    "Reply NO for thanks, acknowledgements, side chatter, or human-to-human discussion. " +
    "Return YES or NO, followed by a short reason."
  );
}

function isObviousChatterText(cleanedText = "") {
  return OBVIOUS_CHATTER_PHRASES.includes(cleanedText);
}

function didBotInviteFollowUp(cleanedText = "") {
  return BOT_INVITED_FOLLOW_UP_PATTERNS.some((pattern) => pattern.test(cleanedText));
}

module.exports = {
  DEFAULT_LOCAL_REGION_NAME,
  DEFAULT_WEB_SEARCH_ALLOWED_DOMAINS,
  didBotInviteFollowUp,
  isObviousChatterText,
  loadBotTuning,
  parseCommaSeparatedList,
  normalizeReplyStyle,
  normalizeThreadFollowUpMode,
  parsePositiveInt,
  replyStyleInstruction,
  threadReplyClassifierInstructions,
};
