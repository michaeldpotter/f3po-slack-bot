const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { getUpcomingEventInstances, isConfigured: isF3NationApiConfigured } = require("./f3nation-api");
const { loadBotTuning } = require("./bot-tuning");

const DEFAULT_DB_PATH = path.join("export", "google", "f3po-reporting.sqlite");
const BOT_TUNING = loadBotTuning();
const LOCAL_REGION_NAME = BOT_TUNING.localRegionName || "F3 Wichita";
const DAY_NUMBERS = new Map([
  ["sunday", "0"],
  ["sundays", "0"],
  ["sun", "0"],
  ["monday", "1"],
  ["mondays", "1"],
  ["mon", "1"],
  ["tuesday", "2"],
  ["tuesdays", "2"],
  ["tue", "2"],
  ["wednesday", "3"],
  ["wednesdays", "3"],
  ["wed", "3"],
  ["thursday", "4"],
  ["thursdays", "4"],
  ["thu", "4"],
  ["friday", "5"],
  ["fridays", "5"],
  ["fri", "5"],
  ["saturday", "6"],
  ["saturdays", "6"],
  ["satudary", "6"],
  ["satday", "6"],
  ["sat", "6"],
]);
const MONTH_NUMBERS = new Map([
  ["january", "01"],
  ["jan", "01"],
  ["february", "02"],
  ["feb", "02"],
  ["march", "03"],
  ["mar", "03"],
  ["april", "04"],
  ["apr", "04"],
  ["may", "05"],
  ["june", "06"],
  ["jun", "06"],
  ["july", "07"],
  ["jul", "07"],
  ["august", "08"],
  ["aug", "08"],
  ["september", "09"],
  ["sep", "09"],
  ["sept", "09"],
  ["october", "10"],
  ["oct", "10"],
  ["november", "11"],
  ["nov", "11"],
  ["december", "12"],
  ["dec", "12"],
]);
const COUNT_WORDS = new Map([
  ["one", 1],
  ["two", 2],
  ["three", 3],
  ["four", 4],
  ["five", 5],
  ["six", 6],
  ["seven", 7],
  ["eight", 8],
  ["nine", 9],
  ["ten", 10],
]);
const AO_ALIASES = new Map([
  ["ww", "Wild West"],
  ["wild west", "Wild West"],
  ["twt", "Time Will Tell (TWT)"],
]);
// Keep common PAX phrasing together so "beatdown", "workout", "boot camp",
// and ruck/hike-style asks route to the same reporting/schedule logic.
const RUCK_TERM_PATTERN = "ruck(?:s|ing|in)?|hikes?|hiking";
const RUCK_TERM_RE = new RegExp(`\\b(${RUCK_TERM_PATTERN})\\b`);
const WORKOUT_TERM_RE = new RegExp(
  `\\b(work\\s*out|worked\\s*out|workouts?|beat\\s*downs?|boot\\s*camps?|bootcamps?|${RUCK_TERM_PATTERN})\\b`
);
const ATTENDANCE_ACTION_RE = /\b(posts?|posted|attended|attendance|attend|present|there|at\s+ao)\b/;

const BLOCKED_RECENT_PERSON_ATTENDANCE_REPLY =
  "I can’t report recent individual attendance or location patterns. I can help with aggregate AO activity, FNG counts, Q counts, or longer-range non-current trends.";
const BOY_BAND_DEFAULT_DAYS = 90;
const BOY_BAND_MAX_RESULTS = 5;
const PAX_VAULT_URL = "https://pax-vault.f3nation.com/";
const UNSUPPORTED_REPORTING_REPLY =
  `I don’t have that report type wired in yet. You may want to check PAX Vault: ${PAX_VAULT_URL}`;
const SELF_ATTENDANCE_NAME_MISMATCH_REPLY =
  "I can show your own attendance only when your Slack display name closely matches your F3 name. I couldn’t confidently match your Slack name to a PAX record, so I’m not going to guess.";

function reportingDbPath() {
  return process.env.REPORTING_DB_PATH || DEFAULT_DB_PATH;
}

function openReportingDb(dbPath = reportingDbPath()) {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}

function normalizeText(value = "") {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/<@[\w]+>/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasWorkoutTerm(normalized = "") {
  return WORKOUT_TERM_RE.test(normalized);
}

function hasWorkoutOrAttendanceTerm(normalized = "") {
  return hasWorkoutTerm(normalized) || ATTENDANCE_ACTION_RE.test(normalized);
}

function requestedWorkoutKind(normalized = "") {
  return RUCK_TERM_RE.test(normalized) ? "ruck" : "";
}

function rowMatchesWorkoutKind(row = {}, workoutKind = "") {
  if (!workoutKind) return true;
  const haystack = normalizeText(`${row.ao || ""} ${row.aoName || ""} ${row.name || ""} ${row.description || ""}`);
  if (workoutKind === "ruck") return RUCK_TERM_RE.test(haystack);
  return true;
}

function workoutKindSqlClause(workoutKind = "", eventAlias = "e") {
  if (workoutKind !== "ruck") return "";
  const prefix = eventAlias ? `${eventAlias}.` : "";
  return `AND (
            LOWER(COALESCE(${prefix}name, '')) LIKE '%ruck%'
            OR LOWER(COALESCE(${prefix}description, '')) LIKE '%ruck%'
            OR LOWER(COALESCE(${prefix}name, '')) LIKE '%hike%'
            OR LOWER(COALESCE(${prefix}description, '')) LIKE '%hike%'
          )`;
}

function localRegionScheduleTitle(range, workoutKind = "") {
  return `${LOCAL_REGION_NAME} ${workoutKind === "ruck" ? "Ruck Schedule" : "Schedule"} — ${range.label}`;
}

function isoDateDaysAgo(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function currentDate() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function weekRangeFromText(text = "") {
  const normalized = normalizeText(text);
  if (!/\b(this|current|next|upcoming)\s+week\b/.test(normalized)) return null;

  const today = new Date(`${currentDate()}T00:00:00.000Z`);
  const dayOfWeek = today.getUTCDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const startOfThisWeek = addDays(today, mondayOffset);

  if (/\bnext\s+week\b/.test(normalized)) {
    const start = addDays(startOfThisWeek, 7);
    return { start: isoDate(start), end: isoDate(addDays(start, 6)), label: "next week" };
  }

  return {
    start: isoDate(startOfThisWeek),
    end: isoDate(addDays(startOfThisWeek, 6)),
    label: "this week",
  };
}

function rollingDaysRangeFromText(text = "") {
  const normalized = normalizeText(text);
  const match = normalized.match(/\b(?:next|upcoming)\s+(\d{1,2})\s+days?\b/);
  if (!match) return null;

  const days = Number.parseInt(match[1], 10);
  if (!Number.isFinite(days) || days < 1 || days > 45) return null;

  const today = new Date(`${currentDate()}T00:00:00.000Z`);
  return {
    start: currentDate(),
    end: isoDate(addDays(today, days)),
    label: `next ${days} days`,
  };
}

function upcomingWeekRange() {
  const today = new Date(`${currentDate()}T00:00:00.000Z`);
  return { start: currentDate(), end: isoDate(addDays(today, 7)), label: "upcoming week" };
}

function nextWeekdayRangeFromText(text = "") {
  const weekday = weekdayFromText(text);
  if (!weekday) return null;

  const today = new Date(`${currentDate()}T00:00:00.000Z`);
  const todayNumber = today.getUTCDay();
  const targetNumber = Number(weekday.number);
  const daysUntil = (targetNumber - todayNumber + 7) % 7;
  const target = isoDate(addDays(today, daysUntil));
  return { start: target, end: target, label: weekday.label || weekday.name };
}

function tomorrowRangeFromText(text = "") {
  if (!/\btomorrow\b/.test(normalizeText(text))) return null;
  const tomorrow = isoDate(addDays(new Date(`${currentDate()}T00:00:00.000Z`), 1));
  return { start: tomorrow, end: tomorrow, label: "tomorrow" };
}

function monthEndForDate(isoDateValue) {
  const [year, month] = String(isoDateValue || "").split("-").map((part) => Number(part));
  if (!year || !month) return currentDate();
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function restOfMonthRangeFromContextDate(startDate) {
  if (!startDate) return null;
  const start = isoDate(addDays(new Date(`${startDate}T00:00:00.000Z`), 1));
  const end = monthEndForDate(startDate);
  if (start > end) return null;
  return { start, end, label: "rest of the month" };
}

function restOfNamedMonthRangeFromText(text = "", contextStartDate = "") {
  if (!/\b(rest|remainder|remaining)\b/.test(normalizeText(text))) return null;
  const range = monthRangeFromText(text);
  if (!range) return null;

  const contextNextDay =
    contextStartDate && contextStartDate.slice(0, 7) === range.start.slice(0, 7)
      ? isoDate(addDays(new Date(`${contextStartDate}T00:00:00.000Z`), 1))
      : "";
  return {
    start: contextNextDay && contextNextDay > range.start ? contextNextDay : range.start,
    end: range.end,
    label: `rest of ${range.label}`,
  };
}

function scheduleRangeFromText(text = "") {
  return explicitScheduleRangeFromText(text) || upcomingWeekRange();
}

function explicitScheduleRangeFromText(text = "") {
  return (
    rollingDaysRangeFromText(text) ||
    weekRangeFromText(text) ||
    weekendRangeFromText(text) ||
    todayRangeFromText(text) ||
    tomorrowRangeFromText(text) ||
    nextWeekdayRangeFromText(text) ||
    monthRangeFromText(text)
  );
}

function todayRangeFromText(text = "") {
  if (!/\btoday\b/.test(normalizeText(text))) return null;
  return { start: currentDate(), end: currentDate(), label: "today" };
}

function weekendRangeFromText(text = "") {
  const normalized = normalizeText(text);
  if (!/\b(this|current|next|upcoming)?\s*weekend\b/.test(normalized)) return null;

  const today = new Date(`${currentDate()}T00:00:00.000Z`);
  const todayNumber = today.getUTCDay();
  const daysUntilSaturday = (6 - todayNumber + 7) % 7;
  const explicitNext = /\bnext\s+weekend\b/.test(normalized);
  const saturdayOffset = daysUntilSaturday + (explicitNext ? 7 : 0);
  const saturday = addDays(today, saturdayOffset);
  const sunday = addDays(saturday, 1);

  if (!explicitNext && todayNumber === 0) {
    return { start: currentDate(), end: currentDate(), label: "this weekend" };
  }

  return {
    start: isoDate(saturday),
    end: isoDate(sunday),
    label: explicitNext ? "next weekend" : "this weekend",
  };
}

function asksRegionWorkoutSchedule(normalized = "") {
  const asksForSchedule =
    (/\b(schedule|calendar|events?)\b/.test(normalized) || hasWorkoutTerm(normalized)) &&
    /\b(show|list|pull|give|get|display|what|whats|what s|where|when)\b/.test(normalized);
  const hasRange =
    /\b(next|this|current|upcoming|tomorrow|today|sun|sunday|mon|monday|tue|tuesday|wed|wednesday|thu|thursday|fri|friday|sat|saturday|satudary|week|month)\b/.test(
      normalized
    );
  const asksForQOnly =
    /\b(q|qs|qing|q ing|scheduled to q|leading|leader|leaders)\b/.test(normalized) &&
    !hasWorkoutTerm(normalized) &&
    !/\bevents?\b/.test(normalized);

  return asksForSchedule && hasRange && !asksForQOnly;
}

function asksRegionScheduledQ(normalized = "") {
  const asksForQSchedule = asksScheduledQ(normalized);
  const hasRegionScope =
    /\b(all\s+aos?|every\s+ao|aos?|region|wichita|open\s+q\s+slots?)\b/.test(normalized) ||
    /\ball\b/.test(normalized) && hasWorkoutTerm(normalized);
  const hasRange =
    /\b(next|tomorrow|today|weekend|week|month|days?|sun|sunday|mon|monday|tue|tuesday|wed|wednesday|thu|thursday|fri|friday|sat|saturday|satudary)\b/.test(
      normalized
    );

  return asksForQSchedule && hasRegionScope && hasRange;
}

function asksAoWorkoutSchedule(normalized = "") {
  const asksForSchedule =
    /\b(schedule|calendar|events?)\b/.test(normalized) ||
    hasWorkoutTerm(normalized) ||
    /\b(when|where|what time|time|meet|meets|meeting|is there)\b/.test(normalized);
  const hasRange =
    /\b(next|this|current|upcoming|tomorrow|today|weekend|sun|sunday|mon|monday|tue|tuesday|wed|wednesday|thu|thursday|fri|friday|sat|saturday|satudary|week|month|days?)\b/.test(
      normalized
    );

  return asksForSchedule && hasRange;
}

function asksHardestBeatdowns(normalized = "") {
  const asksHard =
    /\b(hardest|hard|toughest|brutal|brutalist|nastiest|meanest|worst|suckfest|smoker|smoked|destroyed|murder|painful|pain)\b/.test(
      normalized
    );
  const asksWorkout =
    hasWorkoutTerm(normalized) || /\b(bd|bds|q|qs|qing|led|lead|leader|who|which)\b/.test(normalized);

  return asksHard && asksWorkout;
}

function hardBeatdownRangeFromText(text = "") {
  const normalized = normalizeText(text);
  if (/\b(ever|all time|all recorded|history|historical)\b/.test(normalized)) {
    return { start: "1900-01-01", end: currentDate(), label: "all recorded time" };
  }
  return dateRangeFromText(text);
}

function currentYearStart() {
  return `${new Date().getFullYear()}-01-01`;
}

function dateRangeFromText(text = "") {
  const normalized = normalizeText(text);
  if (/\bthis year\b/.test(normalized)) {
    return { start: currentYearStart(), end: currentDate(), label: "this year" };
  }
  if (/\blast\s+month\b/.test(normalized)) {
    const today = new Date(`${currentDate()}T00:00:00.000Z`);
    const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
    const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));
    return { start: isoDate(start), end: isoDate(end), label: "last month" };
  }
  if (/\blast\s+30\s+days\b/.test(normalized)) {
    return { start: isoDateDaysAgo(30), end: currentDate(), label: "last 30 days" };
  }
  if (/\blast\s+90\s+days\b/.test(normalized)) {
    return { start: isoDateDaysAgo(90), end: currentDate(), label: "last 90 days" };
  }
  if (/\blast\s+(year|12\s+months)\b/.test(normalized)) {
    return { start: isoDateDaysAgo(365), end: currentDate(), label: "last year" };
  }
  return { start: isoDateDaysAgo(365), end: currentDate(), label: "last year" };
}

function explicitYearRangeFromText(text = "") {
  const year = normalizeText(text).match(/\b(20\d{2})\b/)?.[1];
  if (!year) return null;
  return { start: `${year}-01-01`, end: `${year}-12-31`, label: year };
}

function monthRangeFromText(text = "") {
  const normalized = normalizeText(text);
  for (const [name, month] of MONTH_NUMBERS.entries()) {
    if (!new RegExp(`\\b${name}\\b`).test(normalized)) continue;

    const explicitYear = normalized.match(/\b(20\d{2})\b/)?.[1];
    const currentYear = new Date().getFullYear();
    const year = explicitYear || String(/\blast\b/.test(normalized) ? currentYear - 1 : currentYear);
    const start = `${year}-${month}-01`;
    const endDate = new Date(Date.UTC(Number(year), Number(month), 0));
    const end = endDate.toISOString().slice(0, 10);
    const label = `${name.length <= 4 ? name.toUpperCase() : name.charAt(0).toUpperCase() + name.slice(1)} ${year}`;
    return { start, end, label };
  }

  return null;
}

function explicitDateFromText(text = "") {
  const normalized = normalizeText(text);
  const isoMatch = normalized.match(/\b(20\d{2})\s+(\d{1,2})\s+(\d{1,2})\b/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  const currentYear = new Date().getFullYear();
  for (const [name, month] of MONTH_NUMBERS.entries()) {
    const match = normalized.match(new RegExp(`\\b${name}\\s+(\\d{1,2})(?:\\s+(20\\d{2}))?\\b`));
    if (!match) continue;
    const day = Number.parseInt(match[1], 10);
    if (!Number.isInteger(day) || day < 1 || day > 31) return "";
    return `${match[2] || currentYear}-${month}-${String(day).padStart(2, "0")}`;
  }

  return "";
}

function defaultBoyBandRange() {
  return {
    start: isoDateDaysAgo(BOY_BAND_DEFAULT_DAYS),
    end: currentDate(),
    label: `last ${BOY_BAND_DEFAULT_DAYS} days`,
  };
}

function boyBandRangeFromText(text = "") {
  const explicitDate = explicitDateFromText(text);
  if (explicitDate) return { start: explicitDate, end: explicitDate, label: explicitDate };

  const normalized = normalizeText(text);
  const weekday = weekdayFromText(text);
  if (weekday && /\b(last|past|recent|latest|most recent|previous|this)\b/.test(normalized)) {
    const date = recentWeekdayDates(weekday.number, 1)[0];
    return { start: date, end: date, label: `${weekday.label} ${date}` };
  }

  if (monthRangeFromText(text)) return monthRangeFromText(text);
  if (/\b(this year|last month|last 30 days|last 90 days|last year|last 12 months)\b/.test(normalized)) {
    return dateRangeFromText(text);
  }
  return defaultBoyBandRange();
}

function asksBoyBandPhoto(normalized = "") {
  return (
    /\b(boy\s*band|boyband|group\s+photo|group\s+picture|backblast\s+(photo|picture|image)|photo|picture|pic|image)\b/.test(
      normalized
    ) &&
    /\b(show|send|link|find|get|give|pull|where|who|was|were|is|are|have|has|photo|picture|pic|image|boy\s*band|boyband)\b/.test(
      normalized
    )
  );
}

function classifySelfPaxReport(text = "", normalized = "") {
  const selfScoped = /\b(i|my|mine|myself)\b/.test(normalized) || /\b(of|for|with)\s+me\b/.test(normalized);
  if (!selfScoped) return null;
  const range = monthRangeFromText(text) || explicitYearRangeFromText(text);
  const workoutKind = requestedWorkoutKind(normalized);
  const postNoun = workoutKind === "ruck" ? "Ruck" : "Post";
  const qNoun = workoutKind === "ruck" ? "Ruck Q" : "Q";

  const qTerms = /\b(q|qs|qed|qd|qing|q ing|led|lead|leading)\b/.test(normalized);
  const postTerms = hasWorkoutOrAttendanceTerm(normalized);
  const countTerms = /\b(how many|count|counts|number|total|times)\b/.test(normalized);
  const firstTerms = /\b(first|oldest|earliest)\b/.test(normalized);
  const lastTerms = /\b(last|latest|most recent|recent)\b/.test(normalized);
  const aoTerms = /\b(where|which ao|what ao|aos|places|locations)\b/.test(normalized);
  const historyTerms = /\b(history|list|show|pull|give|get)\b/.test(normalized);

  if (qTerms) {
    if (countTerms) return { type: "self_q_count", range, workoutKind };
    if (aoTerms) return { type: "self_q_aos" };
    if (firstTerms) return { type: "self_q_events", order: "asc", limit: 1, label: `First ${qNoun}`, range, workoutKind };
    if (lastTerms) return { type: "self_q_events", order: "desc", limit: 1, label: `Most Recent ${qNoun}`, range, workoutKind };
    if (historyTerms) return { type: "self_q_events", order: "desc", limit: 10, label: `${qNoun} History`, range, workoutKind };
  }

  if (postTerms) {
    if (countTerms) return { type: "self_post_count", range, workoutKind };
    if (firstTerms) return { type: "self_post_events", order: "asc", limit: 1, label: `First ${postNoun}`, range, workoutKind };
    if (lastTerms) return { type: "self_post_events", order: "desc", limit: 1, label: `Most Recent ${postNoun}`, range, workoutKind };
    if (historyTerms && /\b(my|mine)\b/.test(normalized)) {
      return { type: "self_post_events", order: "desc", limit: 10, label: `${postNoun} History`, range, workoutKind };
    }
  }

  return null;
}

function classifyNamedPaxQReport(db, text = "", normalized = "") {
  const selfScoped = /\b(i|my|mine|myself)\b/.test(normalized) || /\b(of|for|with)\s+me\b/.test(normalized);
  if (selfScoped) return null;

  const paxName = matchPaxName(db, text);
  if (!paxName) return null;

  const qTerms = /\b(q|qs|qed|qd|qing|q ing|led|lead|leading)\b/.test(normalized);
  if (!qTerms) return null;

  const countTerms = /\b(how many|count|counts|number|total|times)\b/.test(normalized);
  const firstTerms = /\b(first|oldest|earliest)\b/.test(normalized);
  const lastTerms = /\b(last|latest|most recent|recent)\b/.test(normalized);
  const aoTerms = /\b(where|which ao|what ao|aos|places|locations)\b/.test(normalized);
  const historyTerms = /\b(history|list|show|pull|give|get)\b/.test(normalized);

  if (countTerms) return { type: "pax_q_count", paxName };
  if (aoTerms) return { type: "pax_q_aos", paxName };
  if (firstTerms) return { type: "pax_q_events", paxName, order: "asc", limit: 1, label: "First Q" };
  if (lastTerms) return { type: "pax_q_events", paxName, order: "desc", limit: 1, label: "Most Recent Q" };
  if (historyTerms) return { type: "pax_q_events", paxName, order: "desc", limit: 10, label: "Q History" };

  return null;
}

function getDistinctAoNames(db) {
  return db
    .prepare(
      `SELECT DISTINCT ao_name AS name
       FROM events
       WHERE ao_name IS NOT NULL AND ao_name != ''
       ORDER BY ao_name`
    )
    .all()
    .map((row) => row.name)
    .filter(Boolean);
}

function hasTableColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

function matchAoName(db, text) {
  const normalized = normalizeText(text);
  const aos = getDistinctAoNames(db);
  for (const [alias, aoName] of AO_ALIASES.entries()) {
    if (new RegExp(`\\b${escapeRegExp(alias)}\\b`).test(normalized)) {
      const knownAo = aos.find(
        (name) => name.localeCompare(aoName, undefined, { sensitivity: "accent" }) === 0
      );
      if (knownAo) return knownAo;
    }
  }

  const matches = aos
    .map((name) => ({ name, normalizedName: normalizeText(name) }))
    .filter(({ normalizedName }) => normalizedName && normalized.includes(normalizedName))
    .sort((a, b) => b.normalizedName.length - a.normalizedName.length);

  if (matches[0]) return matches[0].name;

  const words = normalized.split(/\s+/).filter((word) => word.length >= 4);
  const fuzzyMatches = [];
  for (const name of aos) {
    const normalizedName = normalizeText(name);
    if (!normalizedName || normalizedName.length < 4) continue;
    for (const word of words) {
      const score = similarity(word, normalizedName);
      if (score >= 0.78 || (normalizedName.length >= 6 && score >= 0.72)) {
        fuzzyMatches.push({ name, score, word });
      }
    }
  }

  fuzzyMatches.sort((a, b) => b.score - a.score || b.word.length - a.word.length);
  if (fuzzyMatches.length === 0) return "";
  if (fuzzyMatches.length > 1 && fuzzyMatches[0].score === fuzzyMatches[1].score) return "";
  return fuzzyMatches[0].name;
}

function getAoOrgId(db, aoName) {
  const row = db
    .prepare(
      `SELECT ao_org_id
       FROM events
       WHERE ao_name = ? COLLATE NOCASE
         AND ao_org_id IS NOT NULL
       ORDER BY start_date DESC, id DESC
       LIMIT 1`
    )
    .get(aoName);
  return row?.ao_org_id || null;
}

function getDistinctPaxNames(db) {
  return db
    .prepare(
      `SELECT DISTINCT f3_name AS name
       FROM attendance
       WHERE f3_name IS NOT NULL AND f3_name != ''
       ORDER BY f3_name`
    )
    .all()
    .map((row) => row.name)
    .filter(Boolean);
}

function matchPaxName(db, text = "") {
  const normalized = normalizeText(text);
  const paxNames = getDistinctPaxNames(db);
  const exactMatches = paxNames
    .map((name) => ({ name, normalizedName: normalizeText(name.replace(/\([^)]*\)/g, " ")) }))
    .filter(({ normalizedName }) => normalizedName && normalized.includes(normalizedName))
    .sort((a, b) => b.normalizedName.length - a.normalizedName.length);

  if (exactMatches[0]) return exactMatches[0].name;

  const words = normalized.split(/\s+/).filter((word) => word.length >= 4);
  const fuzzyMatches = [];
  for (const name of paxNames) {
    const normalizedName = normalizeText(name.replace(/\([^)]*\)/g, " "));
    if (!normalizedName || normalizedName.length < 4) continue;
    for (const word of words) {
      const score = similarity(word, normalizedName);
      if (score >= 0.82 || (normalizedName.length >= 6 && score >= 0.76)) {
        fuzzyMatches.push({ name, score, word });
      }
    }
  }

  fuzzyMatches.sort((a, b) => b.score - a.score || b.word.length - a.word.length);
  if (fuzzyMatches.length === 0) return "";
  if (fuzzyMatches.length > 1 && fuzzyMatches[0].score === fuzzyMatches[1].score) return "";
  return fuzzyMatches[0].name;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;

  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = Array.from({ length: b.length + 1 }, () => 0);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j += 1) previous[j] = current[j];
  }

  return previous[b.length];
}

function similarity(a, b) {
  const maxLength = Math.max(a.length, b.length);
  if (maxLength === 0) return 1;
  return 1 - levenshtein(a, b) / maxLength;
}

function matchSlackNameToPax(db, slackName = "") {
  const normalizedSlackName = normalizeText(slackName);
  if (!normalizedSlackName) return null;

  const matches = getDistinctPaxNames(db)
    .map((name) => {
      const normalizedPaxName = normalizeText(name.replace(/\([^)]*\)/g, " "));
      const score =
        normalizedSlackName === normalizedPaxName
          ? 1
          : Math.max(
              similarity(normalizedSlackName, normalizedPaxName),
              normalizedPaxName.includes(normalizedSlackName) ? 0.94 : 0,
              normalizedSlackName.includes(normalizedPaxName) ? 0.94 : 0
            );

      return { name, normalizedPaxName, score };
    })
    .filter((match) => match.score >= 0.92)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  if (matches.length === 0) return null;
  if (matches.length > 1 && matches[0].score === matches[1].score) return null;
  return matches[0];
}

function weekdayFromText(text = "") {
  const normalized = normalizeText(text);
  for (const [name, number] of DAY_NUMBERS.entries()) {
    if (new RegExp(`\\b${name}\\b`).test(normalized)) {
      const label = [...DAY_NUMBERS.entries()].find(
        ([candidate, candidateNumber]) => candidateNumber === number && candidate.length > 3
      )?.[0] || name;
      return { name, number, label };
    }
  }
  return null;
}

function isSelfReference(normalizedText = "", context = {}) {
  if (/\b(i|me|my|mine|myself)\b/.test(normalizedText)) return true;

  const requesterName = normalizeText(context.requesterName || "");
  return Boolean(
    requesterName &&
      requesterName.length >= 2 &&
      new RegExp(`\\b${escapeRegExp(requesterName)}\\b`).test(
        normalizedText
      )
  );
}

function countFromText(text = "", fallback = 4) {
  const normalized = normalizeText(text);
  const digitMatch = normalized.match(/\b([1-9]|10)\b/);
  if (digitMatch) return Number(digitMatch[1]);

  for (const [word, count] of COUNT_WORDS.entries()) {
    if (new RegExp(`\\b${word}\\b`).test(normalized)) return count;
  }

  return fallback;
}

function recentWeekdayDates(weekdayNumber, count) {
  const dates = [];
  const today = new Date(`${currentDate()}T00:00:00.000Z`);
  const todayNumber = today.getUTCDay();
  const targetNumber = Number(weekdayNumber);
  const daysSinceTarget = (todayNumber - targetNumber + 7) % 7;
  let cursor = addDays(today, -daysSinceTarget);

  for (let index = 0; index < count; index += 1) {
    dates.push(isoDate(cursor));
    cursor = addDays(cursor, -7);
  }

  return dates;
}

function isBlockedPersonAttendanceQuestion(text = "") {
  const normalized = normalizeText(text);
  const asksAttendance =
    /\b(where|when|show|list|was|did|has)\b/.test(normalized) &&
    (hasWorkoutOrAttendanceTerm(normalized) || /\b(where did|last time|last 5)\b/.test(normalized));
  const asksRoster =
    /\b(who attended|show everyone|attendance roster|full roster)\b/.test(normalized) ||
    (/\bwho was\b/.test(normalized) &&
      (hasWorkoutOrAttendanceTerm(normalized) || /\b(at|ao)\b/.test(normalized)));
  const selfQuestion = /\b(i|me|my|mine)\b/.test(normalized);
  const aggregateQuestion =
    /\b(average|avg|count|counts|total|totals|how many|by month|by ao|all aos|fngs|highest|max|maximum|record|ever|most highly|largest|biggest)\b/.test(
      normalized
    );

  if (asksRoster) return true;
  return asksAttendance && !selfQuestion && !aggregateQuestion;
}

function hasNonBotSlackMention(text = "", botUserId = "") {
  const mentions = [...String(text).matchAll(/<@([A-Z0-9]+)(?:\|[^>]+)?>/g)].map(
    (match) => match[1]
  );
  return mentions.some((id) => id && id !== botUserId);
}

function isThirdPartyAttendanceRequest(text = "", context = {}) {
  const normalized = normalizeText(text);
  const selfReference = isSelfReference(normalized, context);
  const asksRecentAttendance =
    /\b(last|recent|latest)\b/.test(normalized) &&
    hasWorkoutOrAttendanceTerm(normalized);
  const asksSameForOther =
    /\b(that|same)\b/.test(normalized) &&
    /\bfor\b/.test(normalized) &&
    !selfReference &&
    !/\bfor\s+(me|myself)\b/.test(normalized);
  const namesOtherPerson =
    !selfReference &&
    (/\blast\b.*\b(work\s*out|worked\s*out|workouts?|beat\s*downs?|boot\s*camps?|bootcamps?|rucks?|rucking|hikes?|hiking|posts?)\b.*\bthat\b.*\b(was|were|attended|posted)\b/.test(
      normalized
    ) ||
      /\bfor\b\s+(?!me\b|myself\b)[a-z0-9]/.test(normalized));

  if (hasNonBotSlackMention(text, context.botUserId || "")) {
    return asksRecentAttendance || asksSameForOther || /\b(last\s+5|last\s+five)\b/.test(normalized);
  }

  return (asksRecentAttendance && namesOtherPerson) || asksSameForOther;
}

function isUnsupportedReportingStatsQuestion(text = "") {
  const normalized = normalizeText(text);
  const localRegionMentioned = normalizeText(LOCAL_REGION_NAME)
    .split(/\s+/)
    .some((term) => term.length >= 4 && normalized.includes(term));
  const reportingTerms =
    /\b(stats?|statistics|report|reports|numbers?|metrics?|trend|trends|attendance|attend|posts?|posted|q count|qs|fngs?|kotter|average|avg|count|counts|total|totals|how many)\b/.test(
      normalized
    );
  const f3Terms =
    /\b(ao|aos|pax|fng|fngs|q|qs|post|posts|attendance|attend|region|kotter|kotters|wichita)\b/.test(normalized) ||
    hasWorkoutTerm(normalized) ||
    localRegionMentioned;

  return reportingTerms && f3Terms;
}

function isLikelyReportingDbQuestion(db, text = "") {
  const normalized = normalizeText(text);
  if (/\b(q\s*source|qsource|q\s*school|qschool|lesson|lessons|class|classes|training)\b/.test(normalized)) {
    return false;
  }

  const reportingTerms =
    /\b(report|reports|reporting|stats?|statistics|history|record|records|first|last|latest|recent|oldest|earliest|highest|max|most|least|count|counts|total|average|avg|schedule|calendar|open q|q slots?)\b/.test(
      normalized
    );
  const eventTerms =
    /\b(q|qs|qed|qd|qing|q ing|pax|attendance|attended|post|posted|posts|backblast|backblasts|boy\s*band|boyband|photo|picture|ao|aos|fng|fngs)\b/.test(
      normalized
    ) || hasWorkoutTerm(normalized);
  const hasKnownEntity = Boolean(matchAoName(db, text) || matchPaxName(db, text));

  return reportingTerms && (eventTerms || hasKnownEntity);
}

function isEventQFollowUp(text = "") {
  const normalized = normalizeText(text);
  return (
    /\bwho\b/.test(normalized) &&
    /\b(q\s+(ed|d)|qed|qd)\b/.test(normalized) &&
    /\b(that|it|this)\b/.test(normalized)
  );
}

function isEventDetailFollowUp(text = "") {
  const normalized = normalizeText(text);
  return (
    /\b(show|send|pull|get|give|display|see|read)\b/.test(normalized) &&
    /\b(that|it|this)\b/.test(normalized) &&
    (hasWorkoutTerm(normalized) || /\b(backblast|event|thang|thing)\b/.test(normalized))
  );
}

function asksScheduledQ(normalized = "") {
  return (
    /\b(qing|q ing|scheduled to q|signed up to q|leading|q spots?|q assignments?)\b/.test(
      normalized
    ) ||
    /\b(who|which|show|list|tell|has|have|whos|who s)\b.*\b(q|qs)\b/.test(normalized) ||
    /\b(q|qs)\b.*\b(schedule|calendar|for|at|on|slots?)\b/.test(normalized) ||
    /\bq\b.*\b(sun|sunday|mon|monday|tue|tuesday|wed|wednesday|thu|thursday|fri|friday|sat|saturday|tomorrow)\b/.test(normalized) ||
    /\b(on q|has the q|have the q)\b/.test(normalized)
  );
}

function normalizeEventTitle(value = "") {
  return String(value)
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.]+$/g, "")
    .trim();
}

function extractReferencedEventFromContext(context = {}) {
  const messages = Array.isArray(context.threadMessages) ? context.threadMessages : [];
  const texts = messages
    .map((message) => message?.text || "")
    .filter(Boolean)
    .reverse();

  for (const text of texts) {
    const bulletMatch = text.match(
      /•\s+\*(20\d{2}-\d{2}-\d{2})\*\s+[—-]\s+(.+?):\s+(.+?)\s+\(\d+\s+PAX(?:,\s+[^)]*)?\)/i
    );
    if (bulletMatch) {
      return {
        startDate: bulletMatch[1],
        ao: normalizeEventTitle(bulletMatch[2]),
        name: normalizeEventTitle(bulletMatch[3]),
      };
    }

    const match = text.match(
      /([\w\s'!-]+?)'s highest recorded attendance is\s+\d+\s+PAX\s+on\s+(\d{4}-\d{2}-\d{2})\s+for\s+([^\n]+?)(?:\.\s*$|\n|$)/i
    );
    if (match) {
      return {
        ao: normalizeEventTitle(match[1]),
        startDate: match[2],
        name: normalizeEventTitle(match[3]),
      };
    }
  }

  return null;
}

function extractQLeaderboardContext(context = {}) {
  const messages = Array.isArray(context.threadMessages) ? context.threadMessages : [];
  const texts = messages
    .map((message) => message?.text || "")
    .filter(Boolean)
    .reverse();

  for (const text of texts) {
    const match = text.match(
      /Q['’]?d the most at\s+(.+?)\s+during\s+([A-Za-z]+)\s+(20\d{2})\s*:\s+\d+\s+time/i
    );
    if (match) {
      return {
        ao: normalizeEventTitle(match[1]),
        monthName: match[2],
        year: match[3],
      };
    }
  }

  return null;
}

function extractScheduleFollowupContext(db, context = {}) {
  const messages = Array.isArray(context.threadMessages) ? context.threadMessages : [];
  const texts = messages
    .map((message) => message?.text || "")
    .filter(Boolean)
    .reverse();

  for (const text of texts) {
    if (new RegExp(`${escapeRegExp(LOCAL_REGION_NAME)} Schedule\\s+[—-]`, "i").test(text)) {
      continue;
    }

    const scheduleHeader = text.match(/\*?(.+?)\s+Q Schedule\s+[—-]\s+(.+?)\*?(?:\n|$)/i);
    if (scheduleHeader) {
      const ao = matchAoName(db, scheduleHeader[1]);
      const firstDate = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/)?.[1] || "";
      if (ao) return { ao, range: upcomingWeekRange(), startDate: firstDate };
    }

    if (!asksScheduledQ(normalizeText(text))) continue;
    const ao = matchAoName(db, text);
    if (!ao) continue;

    return {
      ao,
      range: weekRangeFromText(text) || upcomingWeekRange(),
      startDate: nextWeekdayRangeFromText(text)?.start || "",
    };
  }

  return null;
}

function extractRegionScheduleFollowupContext(context = {}) {
  const messages = Array.isArray(context.threadMessages) ? context.threadMessages : [];
  const texts = messages
    .map((message) => message?.text || "")
    .filter(Boolean)
    .reverse();

  for (const text of texts) {
    const normalized = normalizeText(text);
    const header = text.match(
      new RegExp(`${escapeRegExp(LOCAL_REGION_NAME)} Schedule\\s+[—-]\\s+(.+?)(?:\\*|\\n|$)`, "i")
    );
    if (header) {
      return { range: scheduleRangeFromText(header[1]), workoutKind: requestedWorkoutKind(normalized) };
    }

    if (asksRegionWorkoutSchedule(normalized) && !/\b(q|qs|qing|q ing)\b/.test(normalized)) {
      return { range: scheduleRangeFromText(text), workoutKind: requestedWorkoutKind(normalized) };
    }
  }

  return null;
}

function asksToAddQsToPreviousSchedule(normalized = "") {
  return (
    /\b(q|qs|qing|q ing|scheduled to q|leading|leader|leaders)\b/.test(normalized) &&
    /\b(that|it|same|with|include|add|show|can you|could you)\b/.test(normalized)
  );
}

function asksScheduleRangeFollowup(normalized = "") {
  return (
    /\b(show|list|pull|give|get|display|what|whats|what s|can you|could you|just|only)\b/.test(normalized) &&
    /\b(next|this|current|upcoming|tomorrow|today|weekend|week|month|days?|sun|sunday|mon|monday|tue|tuesday|wed|wednesday|thu|thursday|fri|friday|sat|saturday|satudary)\b/.test(
      normalized
    )
  );
}

function asksToFilterPreviousSchedule(normalized = "") {
  return /\b(just|only|filter|narrow|for|at|show|list|pull|get|what about|how about)\b/.test(normalized);
}

function classifyReportRequest(text = "", db, context = {}) {
  const normalized = normalizeText(text);
  if (isThirdPartyAttendanceRequest(text, context)) {
    return {
      type: "blocked_recent_person_attendance",
      blocked: true,
      response: BLOCKED_RECENT_PERSON_ATTENDANCE_REPLY,
    };
  }

  if (asksBoyBandPhoto(normalized)) {
    const ao = matchAoName(db, text);
    const pax = matchPaxName(db, text);
    return {
      type: "boy_band_images",
      ao,
      pax,
      self: !pax && !ao && (/\b(i|my|mine|myself)\b/.test(normalized) || /\b(of|with|for)\s+me\b/.test(normalized)),
      range: boyBandRangeFromText(text),
      limit: BOY_BAND_MAX_RESULTS,
      broad: /\b(all|every|each|archive|history|historical)\b/.test(normalized),
    };
  }

  const selfQuestion = isSelfReference(normalized, context);
  const selfWeekday = weekdayFromText(text);
  if (
    selfQuestion &&
    selfWeekday &&
    /\b(last|past|recent|latest|most recent|previous)\b/.test(normalized) &&
    (/\b(where|show|list|was|were|did)\b/.test(normalized) || hasWorkoutOrAttendanceTerm(normalized))
  ) {
    const count = Math.min(countFromText(text, 4), 10);
    return {
      type: "self_recent_weekday_attendance",
      weekday: selfWeekday,
      count,
      dates: recentWeekdayDates(selfWeekday.number, count),
    };
  }

  if (
    /\b(last|recent|latest)\b/.test(normalized) &&
    /\b(5|five)\b/.test(normalized) &&
    /\b(i|me|my|mine)\b/.test(normalized) &&
    hasWorkoutOrAttendanceTerm(normalized)
  ) {
    return { type: "self_last_workouts", limit: 5 };
  }

  if (selfQuestion) {
    const selfReport = classifySelfPaxReport(text, normalized);
    if (selfReport) return selfReport;
  }

  if (
    /\b(last time|when)\b/.test(normalized) &&
    /\b(i|me|my|mine)\b/.test(normalized) &&
    hasWorkoutOrAttendanceTerm(normalized)
  ) {
    return { type: "self_last_workouts", limit: 1 };
  }

  const namedPaxQReport = classifyNamedPaxQReport(db, text, normalized);
  if (namedPaxQReport) return namedPaxQReport;

  if (isEventQFollowUp(text)) {
    const event = extractReferencedEventFromContext(context);
    if (event) {
      return { type: "event_q_followup", event };
    }
  }

  if (isEventDetailFollowUp(text)) {
    const event = extractReferencedEventFromContext(context);
    if (event) {
      return { type: "event_detail_followup", event };
    }
  }

  if (asksToAddQsToPreviousSchedule(normalized)) {
    const previousRegionSchedule = extractRegionScheduleFollowupContext(context);
    if (previousRegionSchedule) {
      return {
        type: "scheduled_workouts_by_region",
        range: previousRegionSchedule.range,
        workoutKind: previousRegionSchedule.workoutKind || "",
      };
    }
  }

  if (asksScheduleRangeFollowup(normalized)) {
    const previousRegionSchedule = extractRegionScheduleFollowupContext(context);
    const explicitAo = matchAoName(db, text);
    if (previousRegionSchedule && !explicitAo) {
      return {
        type: "scheduled_workouts_by_region",
        range: scheduleRangeFromText(text),
        workoutKind: requestedWorkoutKind(normalized) || previousRegionSchedule.workoutKind || "",
      };
    }
  }

  if (asksToFilterPreviousSchedule(normalized)) {
    const previousRegionSchedule = extractRegionScheduleFollowupContext(context);
    const explicitAo = matchAoName(db, text);
    if (previousRegionSchedule && explicitAo) {
      return {
        type: "scheduled_q_by_ao",
        ao: explicitAo,
        range: explicitScheduleRangeFromText(text) || previousRegionSchedule.range,
      };
    }
  }

  if (/^(yes|yep|yeah|sure|please|do it|check)$/i.test(normalized)) {
    const previousSchedule = extractScheduleFollowupContext(db, context);
    if (previousSchedule) {
      return {
        type: "scheduled_q_by_ao",
        ao: previousSchedule.ao,
        range: previousSchedule.range,
      };
    }
  }

  if (
    (/\b(rest|remainder|remaining)\b/.test(normalized) && /\b(month|mo|may|june|jun|july|jul|august|aug|september|sep|october|oct|november|nov|december|dec|january|jan|february|feb|march|mar|april|apr)\b/.test(normalized)) ||
    /\bwhat about\b/.test(normalized) ||
    (/\b(show|list|pull|give|get|display)\b/.test(normalized) &&
      /\b(next|this|current|upcoming|tomorrow|sun|sunday|mon|monday|tue|tuesday|wed|wednesday|thu|thursday|fri|friday|sat|saturday|satudary|week|month)\b/.test(normalized))
  ) {
    const previousSchedule = extractScheduleFollowupContext(db, context);
    const explicitAo = matchAoName(db, text);
    const range =
      restOfNamedMonthRangeFromText(text, previousSchedule?.startDate || "") ||
      (/\b(rest|remainder|remaining)\b/.test(normalized)
        ? restOfMonthRangeFromContextDate(previousSchedule?.startDate || currentDate())
        : scheduleRangeFromText(text));
    if (previousSchedule && range) {
      return {
        type: "scheduled_q_by_ao",
        ao: explicitAo || previousSchedule.ao,
        range,
      };
    }
  }

  if (/\bwhat about\b/.test(normalized) && /\b(april|apr|last)\b/.test(normalized)) {
    const previous = extractQLeaderboardContext(context);
    const range = monthRangeFromText(text);
    if (previous && range) {
      return { type: "q_leaderboard_by_ao", ao: previous.ao, range };
    }
  }

  if (
    (/\b(who|which|show|list|tell|has|have|whos|who s)\b/.test(normalized) ||
      /\b(schedule|calendar|slots?)\b/.test(normalized) ||
      /\b(q|qs)\b/.test(normalized)) &&
    asksScheduledQ(normalized) &&
    !/\b(most|top|leader|leaderboard|count|counts)\b/.test(normalized)
  ) {
    const ao = matchAoName(db, text);
    if (ao) {
      return {
        type: "scheduled_q_by_ao",
        ao,
        range: scheduleRangeFromText(text),
      };
    }
  }

  if (asksAoWorkoutSchedule(normalized)) {
    const ao = matchAoName(db, text);
    if (ao) {
      return {
        type: "scheduled_q_by_ao",
        ao,
        range: scheduleRangeFromText(text),
      };
    }
  }

  if (asksRegionScheduledQ(normalized) && !matchAoName(db, text)) {
    return {
      type: "scheduled_workouts_by_region",
      range: scheduleRangeFromText(text),
      workoutKind: requestedWorkoutKind(normalized),
    };
  }

  if (asksRegionWorkoutSchedule(normalized) && !matchAoName(db, text)) {
    return {
      type: "scheduled_workouts_by_region",
      range: scheduleRangeFromText(text),
      workoutKind: requestedWorkoutKind(normalized),
    };
  }

  if (
    /\b(who|leader|leaderboard|most|top)\b/.test(normalized) &&
    /\b(q|qs|qed|qd)\b/.test(normalized) &&
    /\b(most|top|leader|leaderboard)\b/.test(normalized)
  ) {
    const ao = matchAoName(db, text);
    const range = monthRangeFromText(text) || dateRangeFromText(text);
    if (ao) {
      return { type: "q_leaderboard_by_ao", ao, range };
    }
  }

  if (
    /\b(highest|max|maximum|record|most highly|largest|biggest)\b/.test(normalized) &&
    (/\b(attendance|attended|pax)\b/.test(normalized) || hasWorkoutTerm(normalized))
  ) {
    const ao = matchAoName(db, text);
    if (ao) {
      return { type: "max_attendance_by_ao", ao };
    }
    return { type: "max_attendance_overall" };
  }

  if (asksHardestBeatdowns(normalized)) {
    return { type: "hardest_beatdowns_fun", range: hardBeatdownRangeFromText(text) };
  }

  if (isBlockedPersonAttendanceQuestion(text)) {
    return {
      type: "blocked_recent_person_attendance",
      blocked: true,
      response: BLOCKED_RECENT_PERSON_ATTENDANCE_REPLY,
    };
  }

  if (/\b(fng|fngs)\b/.test(normalized) && /\b(month|monthly|by month)\b/.test(normalized)) {
    return { type: "fngs_by_month", range: dateRangeFromText(text) };
  }

  if (hasWorkoutTerm(normalized) && /\b(month|monthly|by month)\b/.test(normalized)) {
    return { type: "workouts_by_month", range: dateRangeFromText(text) };
  }

  if ((hasWorkoutTerm(normalized) || /\bactivity\b/.test(normalized)) && /\b(ao|aos|by ao)\b/.test(normalized)) {
    return { type: "workouts_by_ao", range: dateRangeFromText(text) };
  }

  const weekday = weekdayFromText(text);
  if (
    weekday &&
    /\b(attendance|attend|pax|average|avg)\b/.test(normalized) &&
    /\b(ao|aos|all aos)\b/.test(normalized)
  ) {
    return {
      type: "attendance_by_ao_day",
      weekday,
      range: dateRangeFromText(text),
    };
  }

  if (
    /\b(average|avg)\b/.test(normalized) &&
    /\b(attendance|attend|pax)\b/.test(normalized)
  ) {
    const ao = matchAoName(db, text);
    if (ao) {
      return { type: "avg_attendance_by_ao", ao, range: dateRangeFromText(text) };
    }
  }

  if (isUnsupportedReportingStatsQuestion(text)) {
    return {
      type: "unsupported_reporting_stats",
      blocked: true,
      response: UNSUPPORTED_REPORTING_REPLY,
    };
  }

  if (isLikelyReportingDbQuestion(db, text)) {
    return {
      type: "unsupported_reporting_stats",
      blocked: true,
      response: UNSUPPORTED_REPORTING_REPLY,
    };
  }

  return null;
}

function formatNumber(value) {
  if (value === null || value === undefined) return "0";
  return String(value);
}

function capitalize(value = "") {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : "";
}

function formatEventTime(startTime = "", endTime = "") {
  const formatOne = (value) => {
    if (!String(value || "").trim()) return "";
    const digits = String(value || "").replace(/\D/g, "").padStart(4, "0");
    const hours24 = Number(digits.slice(0, 2));
    const minutes = digits.slice(2, 4);
    if (!Number.isFinite(hours24)) return String(value || "");
    const suffix = hours24 >= 12 ? "PM" : "AM";
    const hours12 = hours24 % 12 || 12;
    return `${hours12}:${minutes} ${suffix}`;
  };

  const start = formatOne(startTime);
  const end = formatOne(endTime);
  if (start && end) return `${start}-${end}`;
  return start || end || "time not listed";
}

function rowsToBullets(rows, formatter, limit = 20) {
  return rows.slice(0, limit).map(formatter).join("\n");
}

function rowsToBulletsWithLimitNote(rows, formatter, limit = 20) {
  const visibleRows = rows.slice(0, limit);
  const text = visibleRows.map(formatter).join("\n");
  if (rows.length <= limit) return text;
  const remaining = rows.length - limit;
  return `${text}\n\n_Showing ${limit} of ${rows.length}; ${remaining} more omitted._`;
}

function formatDateHeading(dateValue = "") {
  const iso = String(dateValue || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || "unknown date";

  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${iso}T00:00:00.000Z`));
}

function rowsToDayGroupsWithLimitNote(rows, dateGetter, formatter, limit = 100) {
  const visibleRows = rows.slice(0, limit);
  const lines = [];
  let currentDate = "";

  for (const row of visibleRows) {
    const rowDate = dateGetter(row) || "unknown date";
    if (rowDate !== currentDate) {
      if (lines.length > 0) lines.push("");
      lines.push(`*${formatDateHeading(rowDate)}*`);
      currentDate = rowDate;
    }
    lines.push(formatter(row));
  }

  const text = lines.join("\n");
  if (rows.length <= limit) return text;
  const remaining = rows.length - limit;
  return `${text}\n\n_Showing ${limit} of ${rows.length}; ${remaining} more omitted._`;
}

function numberedRows(rows, formatter, limit = 10) {
  return rows
    .slice(0, limit)
    .map((row, index) => `${index + 1}. ${formatter(row)}`)
    .join("\n");
}

function getEventQLabels(db, eventId) {
  const qRows = db
    .prepare(
      `SELECT f3_name,
              q_ind,
              coq_ind
       FROM attendance
       WHERE event_instance_id = ?
         AND (q_ind = 1 OR coq_ind = 1)
         AND f3_name IS NOT NULL
         AND f3_name != ''
       ORDER BY q_ind DESC, coq_ind DESC, f3_name COLLATE NOCASE ASC`
    )
    .all(eventId);

  return {
    qs: qRows.filter((row) => row.q_ind).map((row) => row.f3_name),
    coqs: qRows.filter((row) => row.coq_ind && !row.q_ind).map((row) => row.f3_name),
  };
}

function formatQLabels(labels) {
  const qText = labels.qs.length > 0 ? `Q: ${labels.qs.join(", ")}` : "";
  const coqText = labels.coqs.length > 0 ? `Co-Q: ${labels.coqs.join(", ")}` : "";
  return [qText, coqText].filter(Boolean).join("\n") || "Q: not marked in the local reporting DB";
}

function formatQLabelsForSlack(labels) {
  return formatQLabels(labels)
    .split("\n")
    .map((line) => `*${line.replace(":", ":*")}`)
    .join("\n");
}

function isFutureOrCurrentRange(range) {
  return Boolean(range?.end && range.end >= currentDate());
}

function formatApiQLabels(event) {
  const labels = {
    qs: Array.isArray(event.qs) ? event.qs : [],
    coqs: Array.isArray(event.coqs) ? event.coqs : [],
  };
  return formatQLabels(labels).replace(/\n/g, "; ").replace("local reporting DB", "F3 Nation calendar");
}

function scoreHardBeatdown(row) {
  const text = normalizeText(`${row.name || ""} ${row.description || ""}`);
  const signals = [];
  let score = Math.min(5, Math.floor(Number(row.pax_count || 0) / 15));
  const terms = [
    ["murph", 8, "Murph"],
    ["50k", 8, "50K"],
    ["ironpax", 7, "IronPAX"],
    ["ipc", 7, "IPC"],
    ["suckfest", 7, "suckfest"],
    ["brutal", 6, "brutal"],
    ["pain", 5, "pain"],
    ["hiit", 5, "HIIT"],
    ["hitt", 5, "HIIT"],
    ["burpee", 5, "burpees"],
    ["ruck", 4, "ruck"],
    ["coupon", 4, "coupons"],
    ["bear crawl", 4, "bear crawls"],
    ["crawl", 3, "crawls"],
    ["dora", 3, "DORA"],
    ["challenge", 3, "challenge"],
    ["convergence", 3, "convergence"],
    ["hill", 3, "hill work"],
    ["blackops", 2, "Black Ops"],
    ["birthday", 2, "birthday Q"],
  ];

  for (const [term, weight, label] of terms) {
    if (new RegExp(`\\b${escapeRegExp(term)}\\b`).test(text)) {
      score += weight;
      signals.push(label);
    }
  }

  return {
    score,
    signals: [...new Set(signals)].slice(0, 4),
  };
}

function parseJsonArray(value = "") {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function getEventPaxNames(db, eventId) {
  return db
    .prepare(
      `SELECT DISTINCT f3_name
       FROM attendance
       WHERE event_instance_id = ?
         AND f3_name IS NOT NULL
         AND f3_name != ''
       ORDER BY f3_name COLLATE NOCASE ASC`
    )
    .all(eventId)
    .map((row) => row.f3_name)
    .filter(Boolean);
}

function formatBoyBandEvent(db, row, includePax = true) {
  const urls = parseJsonArray(row.image_urls_json);
  const primaryUrl = urls[0] || "";
  const extraCount = Math.max(0, urls.length - 1);
  const pax = includePax ? getEventPaxNames(db, row.id) : [];
  const paxText =
    includePax && pax.length > 0
      ? `\n  Likely pictured from backblast/attendance roster: ${pax.join(", ")}`
      : "";
  const extraText = extraCount > 0 ? ` (+${extraCount} more image link${extraCount === 1 ? "" : "s"})` : "";
  return `• *${row.start_date}* — ${row.ao}: ${row.name}${extraText}\n  ${primaryUrl}${paxText}`;
}

function truncateForSlack(text = "", limit = 2800) {
  const value = String(text || "").trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit).trim()}\n\n_Trimmed for Slack; ask for a narrower detail if you need more._`;
}

function resolveSelfPaxOrReply(db, context = {}) {
  const match = matchSlackNameToPax(db, context.requesterName || "");
  if (!match) {
    return { error: { text: SELF_ATTENDANCE_NAME_MISMATCH_REPLY, source: "reporting_policy_block" } };
  }
  return { name: match.name };
}

async function tryRunLiveScheduleReport(db, intent) {
  if (!["scheduled_q_by_ao", "scheduled_workouts_by_region"].includes(intent.type)) return null;
  if (!isFutureOrCurrentRange(intent.range)) return null;
  if (!isF3NationApiConfigured()) return null;

  const aoOrgId = intent.ao ? getAoOrgId(db, intent.ao) : null;
  const rowLimit = intent.type === "scheduled_workouts_by_region" ? 100 : 20;
  const schedule = await getUpcomingEventInstances({
    aoOrgId,
    startDate: intent.range.start,
    limit: rowLimit,
  });
  if (!schedule.configured) return null;

  const events = schedule.events
    .filter((event) => {
      if (!event.startDate || event.startDate < intent.range.start || event.startDate > intent.range.end) {
        return false;
      }
      if (!rowMatchesWorkoutKind(event, intent.workoutKind || "")) return false;
      if (intent.type === "scheduled_workouts_by_region") return true;
      if (aoOrgId) return true;
      return event.aoName && event.aoName.localeCompare(intent.ao, undefined, { sensitivity: "accent" }) === 0;
    })
    .sort(
      (a, b) =>
        a.startDate.localeCompare(b.startDate) ||
        String(a.startTime || "").localeCompare(String(b.startTime || "")) ||
        String(a.id || "").localeCompare(String(b.id || ""))
    );

  if (events.length === 0) {
    const title =
      intent.type === "scheduled_workouts_by_region"
        ? localRegionScheduleTitle(intent.range, intent.workoutKind || "")
        : `${intent.ao} Q Schedule — ${intent.range.label}`;
    return {
      text:
        `📅 *${title}*\n\n` +
        `I don’t see upcoming F3 Nation calendar events during ${intent.range.label}.`,
      source: "f3nation_api",
    };
  }

  const title =
    intent.type === "scheduled_workouts_by_region"
      ? localRegionScheduleTitle(intent.range, intent.workoutKind || "")
      : `${intent.ao} Q Schedule — ${intent.range.label}`;
  const scheduleText =
    intent.type === "scheduled_workouts_by_region"
      ? rowsToDayGroupsWithLimitNote(
          events,
          (event) => event.startDate,
          (event) => {
            const aoName = event.aoName || "";
            const eventName = event.name || "(unnamed workout)";
            const eventLabel =
              aoName && aoName.localeCompare(eventName, undefined, { sensitivity: "accent" }) !== 0
                ? `${aoName}: ${eventName}`
                : eventName;
            return `• ${formatEventTime(event.startTime, event.endTime)} — ${eventLabel}: ${formatApiQLabels(event)}`;
          },
          rowLimit
        )
      : rowsToBulletsWithLimitNote(
          events,
          (event) => {
            const eventName = event.name || "(unnamed workout)";
            return `• *${event.startDate}* ${formatEventTime(event.startTime, event.endTime)} — ${eventName}: ${formatApiQLabels(event)}`;
          },
          rowLimit
        );

  return {
    text: `📅 *${title}*\n\n${scheduleText}`,
    source: "f3nation_api",
  };
}

function runReport(db, intent, context = {}) {
  if (intent.blocked) {
    return { text: intent.response, source: "reporting_policy_block" };
  }

  if (intent.type === "self_recent_weekday_attendance") {
    const match = matchSlackNameToPax(db, context.requesterName || "");
    if (!match) {
      return { text: SELF_ATTENDANCE_NAME_MISMATCH_REPLY, source: "reporting_policy_block" };
    }

    const placeholders = intent.dates.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT e.start_date,
                e.start_time,
                COALESCE(NULLIF(e.ao_name, ''), '(unknown)') AS ao,
                COALESCE(NULLIF(e.name, ''), '(unnamed workout)') AS name,
                e.pax_count,
                a.q_ind,
                a.coq_ind
         FROM attendance a
         JOIN events e ON e.id = a.event_instance_id
         WHERE a.f3_name = ? COLLATE NOCASE
           AND e.start_date IN (${placeholders})
         ORDER BY e.start_date DESC, e.start_time DESC, e.id DESC`
      )
      .all(match.name, ...intent.dates);

    const rowsByDate = new Map();
    for (const row of rows) {
      if (!rowsByDate.has(row.start_date)) rowsByDate.set(row.start_date, []);
      rowsByDate.get(row.start_date).push(row);
    }

    return {
      text:
        `🧾 *${match.name}'s Most Recent ${intent.count} ${capitalize(intent.weekday.label)}s*\n\n` +
        intent.dates
          .map((date) => {
            const dateRows = rowsByDate.get(date) || [];
            if (dateRows.length === 0) return `• *${date}* — no attendance row found`;
            return dateRows
              .map((row) => {
                const role = row.q_ind ? " Q" : row.coq_ind ? " Co-Q" : "";
                return `• *${row.start_date}* — ${row.ao}: ${row.name} (${row.pax_count} PAX${role})`;
              })
              .join("\n");
          })
          .join("\n"),
      source: "reporting_db_self",
    };
  }

  if (intent.type === "self_last_workouts") {
    const match = matchSlackNameToPax(db, context.requesterName || "");
    if (!match) {
      return { text: SELF_ATTENDANCE_NAME_MISMATCH_REPLY, source: "reporting_policy_block" };
    }

    const rows = db
      .prepare(
        `SELECT e.start_date,
                e.start_time,
                COALESCE(NULLIF(e.ao_name, ''), '(unknown)') AS ao,
                COALESCE(NULLIF(e.name, ''), '(unnamed workout)') AS name,
                e.pax_count,
                a.q_ind,
                a.coq_ind
         FROM attendance a
         JOIN events e ON e.id = a.event_instance_id
         WHERE a.f3_name = ? COLLATE NOCASE
         ORDER BY e.start_date DESC, e.start_time DESC, e.id DESC
         LIMIT ?`
      )
      .all(match.name, intent.limit);

    if (rows.length === 0) {
      return {
        text: `I matched you to ${match.name}, but I don’t see attendance rows for you in the local reporting DB.`,
        source: "reporting_db",
      };
    }

    return {
      text:
        `🧾 *${match.name}'s Last ${rows.length === 1 ? "Workout" : `${rows.length} Workouts`}*\n\n` +
        rowsToBullets(rows, (row) => {
          const role = row.q_ind ? " Q" : row.coq_ind ? " Co-Q" : "";
          return `• *${row.start_date}* — ${row.ao}: ${row.name} (${row.pax_count} PAX${role})`;
        }, intent.limit),
      source: "reporting_db_self",
    };
  }

  if (intent.type === "self_q_events") {
    const resolved = resolveSelfPaxOrReply(db, context);
    if (resolved.error) return resolved.error;
    const direction = intent.order === "asc" ? "ASC" : "DESC";
    const rangeClause = intent.range ? "AND e.start_date BETWEEN ? AND ?" : "";
    const kindClause = workoutKindSqlClause(intent.workoutKind || "", "e");
    const params = intent.range
      ? [resolved.name, intent.range.start, intent.range.end, intent.limit]
      : [resolved.name, intent.limit];
    const rows = db
      .prepare(
        `SELECT e.start_date,
                e.start_time,
                COALESCE(NULLIF(e.ao_name, ''), '(unknown)') AS ao,
                COALESCE(NULLIF(e.name, ''), '(unnamed workout)') AS name,
                e.pax_count,
                a.q_ind,
                a.coq_ind
         FROM attendance a
         JOIN events e ON e.id = a.event_instance_id
         WHERE a.f3_name = ? COLLATE NOCASE
           AND (a.q_ind = 1 OR a.coq_ind = 1)
           ${rangeClause}
           ${kindClause}
         ORDER BY e.start_date ${direction}, e.start_time ${direction}, e.id ${direction}
         LIMIT ?`
      )
      .all(...params);

    if (rows.length === 0) {
      return {
        text: `I matched you to ${resolved.name}, but I don’t see Q-marked rows for you in the local reporting DB.`,
        source: "reporting_db_self",
      };
    }

    return {
      text:
        `🧾 *${resolved.name}'s ${intent.label}${intent.range ? ` — ${intent.range.label}` : ""}*\n\n` +
        rowsToBullets(
          rows,
          (row) => {
            const role = row.q_ind ? "Q" : "Co-Q";
            return `• *${row.start_date}* — ${row.ao}: ${row.name} (${row.pax_count} PAX, ${role})`;
          },
          intent.limit
        ),
      source: "reporting_db_self",
    };
  }

  if (intent.type === "self_q_count") {
    const resolved = resolveSelfPaxOrReply(db, context);
    if (resolved.error) return resolved.error;
    const rangeClause = intent.range ? "AND e.start_date BETWEEN ? AND ?" : "";
    const kindClause = workoutKindSqlClause(intent.workoutKind || "", "e");
    const params = intent.range ? [resolved.name, intent.range.start, intent.range.end] : [resolved.name];
    const row = db
      .prepare(
        `SELECT SUM(CASE WHEN q_ind = 1 THEN 1 ELSE 0 END) AS q_count,
                SUM(CASE WHEN coq_ind = 1 AND q_ind != 1 THEN 1 ELSE 0 END) AS coq_count
         FROM attendance a
         JOIN events e ON e.id = a.event_instance_id
         WHERE a.f3_name = ? COLLATE NOCASE
           AND (q_ind = 1 OR coq_ind = 1)
           ${rangeClause}
           ${kindClause}`
      )
      .get(...params);
    const qCount = Number(row?.q_count || 0);
    const coqCount = Number(row?.coq_count || 0);
    return {
      text:
        `🧾 *${resolved.name}'s Q Count${intent.range ? ` — ${intent.range.label}` : ""}*\n\n` +
        `• Q: *${qCount}*\n` +
        `• Co-Q: *${coqCount}*\n` +
        `• Total Q/Co-Q rows: *${qCount + coqCount}*`,
      source: "reporting_db_self",
    };
  }

  if (intent.type === "self_q_aos") {
    const resolved = resolveSelfPaxOrReply(db, context);
    if (resolved.error) return resolved.error;
    const rows = db
      .prepare(
        `SELECT COALESCE(NULLIF(e.ao_name, ''), '(unknown)') AS ao,
                COUNT(*) AS q_count,
                MAX(e.start_date) AS last_q
         FROM attendance a
         JOIN events e ON e.id = a.event_instance_id
         WHERE a.f3_name = ? COLLATE NOCASE
           AND (a.q_ind = 1 OR a.coq_ind = 1)
         GROUP BY ao
         ORDER BY q_count DESC, ao COLLATE NOCASE ASC
         LIMIT 20`
      )
      .all(resolved.name);

    if (rows.length === 0) {
      return {
        text: `I matched you to ${resolved.name}, but I don’t see Q-marked rows for you in the local reporting DB.`,
        source: "reporting_db_self",
      };
    }

    return {
      text:
        `📍 *AOs ${resolved.name} Has Q'd*\n\n` +
        rowsToBullets(rows, (row) => `• *${row.ao}:* ${row.q_count} Q/Co-Q row(s), last ${row.last_q}`, 20),
      source: "reporting_db_self",
    };
  }

  if (intent.type === "pax_q_events") {
    const direction = intent.order === "asc" ? "ASC" : "DESC";
    const rows = db
      .prepare(
        `SELECT e.start_date,
                e.start_time,
                COALESCE(NULLIF(e.ao_name, ''), '(unknown)') AS ao,
                COALESCE(NULLIF(e.name, ''), '(unnamed workout)') AS name,
                e.pax_count,
                a.q_ind,
                a.coq_ind
         FROM attendance a
         JOIN events e ON e.id = a.event_instance_id
         WHERE a.f3_name = ? COLLATE NOCASE
           AND (a.q_ind = 1 OR a.coq_ind = 1)
         ORDER BY e.start_date ${direction}, e.start_time ${direction}, e.id ${direction}
         LIMIT ?`
      )
      .all(intent.paxName, intent.limit);

    if (rows.length === 0) {
      return {
        text: `I matched ${intent.paxName}, but I don’t see Q-marked rows for him in the local reporting DB.`,
        source: "reporting_db_pax",
      };
    }

    return {
      text:
        `🧾 *${intent.paxName}'s ${intent.label}*\n\n` +
        rowsToBullets(
          rows,
          (row) => {
            const role = row.q_ind ? "Q" : "Co-Q";
            return `• *${row.start_date}* — ${row.ao}: ${row.name} (${row.pax_count} PAX, ${role})`;
          },
          intent.limit
        ),
      source: "reporting_db_pax",
    };
  }

  if (intent.type === "pax_q_count") {
    const row = db
      .prepare(
        `SELECT SUM(CASE WHEN q_ind = 1 THEN 1 ELSE 0 END) AS q_count,
                SUM(CASE WHEN coq_ind = 1 AND q_ind != 1 THEN 1 ELSE 0 END) AS coq_count
         FROM attendance
         WHERE f3_name = ? COLLATE NOCASE
           AND (q_ind = 1 OR coq_ind = 1)`
      )
      .get(intent.paxName);
    const qCount = Number(row?.q_count || 0);
    const coqCount = Number(row?.coq_count || 0);
    return {
      text:
        `🧾 *${intent.paxName}'s Q Count*\n\n` +
        `• Q: *${qCount}*\n` +
        `• Co-Q: *${coqCount}*\n` +
        `• Total Q/Co-Q rows: *${qCount + coqCount}*`,
      source: "reporting_db_pax",
    };
  }

  if (intent.type === "pax_q_aos") {
    const rows = db
      .prepare(
        `SELECT COALESCE(NULLIF(e.ao_name, ''), '(unknown)') AS ao,
                COUNT(*) AS q_count,
                MAX(e.start_date) AS last_q
         FROM attendance a
         JOIN events e ON e.id = a.event_instance_id
         WHERE a.f3_name = ? COLLATE NOCASE
           AND (a.q_ind = 1 OR a.coq_ind = 1)
         GROUP BY ao
         ORDER BY q_count DESC, ao COLLATE NOCASE ASC
         LIMIT 20`
      )
      .all(intent.paxName);

    if (rows.length === 0) {
      return {
        text: `I matched ${intent.paxName}, but I don’t see Q-marked rows for him in the local reporting DB.`,
        source: "reporting_db_pax",
      };
    }

    return {
      text:
        `📍 *AOs ${intent.paxName} Has Q'd*\n\n` +
        rowsToBullets(rows, (row) => `• *${row.ao}:* ${row.q_count} Q/Co-Q row(s), last ${row.last_q}`, 20),
      source: "reporting_db_pax",
    };
  }

  if (intent.type === "self_post_events") {
    const resolved = resolveSelfPaxOrReply(db, context);
    if (resolved.error) return resolved.error;
    const direction = intent.order === "asc" ? "ASC" : "DESC";
    const rangeClause = intent.range ? "AND e.start_date BETWEEN ? AND ?" : "";
    const kindClause = workoutKindSqlClause(intent.workoutKind || "", "e");
    const params = intent.range
      ? [resolved.name, intent.range.start, intent.range.end, intent.limit]
      : [resolved.name, intent.limit];
    const rows = db
      .prepare(
        `SELECT e.start_date,
                e.start_time,
                COALESCE(NULLIF(e.ao_name, ''), '(unknown)') AS ao,
                COALESCE(NULLIF(e.name, ''), '(unnamed workout)') AS name,
                e.pax_count,
                a.q_ind,
                a.coq_ind
         FROM attendance a
         JOIN events e ON e.id = a.event_instance_id
         WHERE a.f3_name = ? COLLATE NOCASE
           ${rangeClause}
           ${kindClause}
         ORDER BY e.start_date ${direction}, e.start_time ${direction}, e.id ${direction}
         LIMIT ?`
      )
      .all(...params);

    if (rows.length === 0) {
      return {
        text: `I matched you to ${resolved.name}, but I don’t see attendance rows for you in the local reporting DB.`,
        source: "reporting_db_self",
      };
    }

    return {
      text:
        `🧾 *${resolved.name}'s ${intent.label}${intent.range ? ` — ${intent.range.label}` : ""}*\n\n` +
        rowsToBullets(
          rows,
          (row) => {
            const role = row.q_ind ? ", Q" : row.coq_ind ? ", Co-Q" : "";
            return `• *${row.start_date}* — ${row.ao}: ${row.name} (${row.pax_count} PAX${role})`;
          },
          intent.limit
        ),
      source: "reporting_db_self",
    };
  }

  if (intent.type === "self_post_count") {
    const resolved = resolveSelfPaxOrReply(db, context);
    if (resolved.error) return resolved.error;
    const rangeClause = intent.range ? "AND e.start_date BETWEEN ? AND ?" : "";
    const kindClause = workoutKindSqlClause(intent.workoutKind || "", "e");
    const params = intent.range ? [resolved.name, intent.range.start, intent.range.end] : [resolved.name];
    const row = db
      .prepare(
        `SELECT COUNT(*) AS post_count,
                COUNT(DISTINCT e.ao_name) AS ao_count,
                MIN(e.start_date) AS first_post,
                MAX(e.start_date) AS last_post
         FROM attendance a
         JOIN events e ON e.id = a.event_instance_id
         WHERE a.f3_name = ? COLLATE NOCASE
           ${rangeClause}
           ${kindClause}`
      )
      .get(...params);
    return {
      text:
        `🧾 *${resolved.name}'s Post Count${intent.range ? ` — ${intent.range.label}` : ""}*\n\n` +
        `• Posts: *${row?.post_count || 0}*\n` +
        `• AOs: ${row?.ao_count || 0}\n` +
        `• First post: ${row?.first_post || "n/a"}\n` +
        `• Most recent post: ${row?.last_post || "n/a"}`,
      source: "reporting_db_self",
    };
  }

  if (intent.type === "boy_band_images") {
    if (!hasTableColumn(db, "events", "image_urls_json")) {
      return {
        text:
          "I don’t see image-link metadata in this local reporting DB yet. Run `npm run reporting:sync` to migrate/fill the boy-band image columns.",
        source: "reporting_db_images",
      };
    }

    let paxName = intent.pax || "";
    if (intent.self) {
      const match = matchSlackNameToPax(db, context.requesterName || "");
      if (!match) {
        return { text: SELF_ATTENDANCE_NAME_MISMATCH_REPLY, source: "reporting_policy_block" };
      }
      paxName = match.name;
    }

    const where = [
      "e.start_date BETWEEN ? AND ?",
      "COALESCE(e.image_urls_json, '[]') NOT IN ('', '[]')",
    ];
    const params = [intent.range.start, intent.range.end];
    let join = "";

    if (intent.ao) {
      where.push("e.ao_name = ? COLLATE NOCASE");
      params.push(intent.ao);
    }

    if (paxName) {
      join = "JOIN attendance a ON a.event_instance_id = e.id";
      where.push("a.f3_name = ? COLLATE NOCASE");
      params.push(paxName);
    }

    const rows = db
      .prepare(
        `SELECT DISTINCT e.id,
                e.start_date,
                e.start_time,
                COALESCE(NULLIF(e.ao_name, ''), '(unknown AO)') AS ao,
                COALESCE(NULLIF(e.name, ''), '(unnamed workout)') AS name,
                e.image_urls_json
         FROM events e
         ${join}
         WHERE ${where.join(" AND ")}
         ORDER BY e.start_date DESC, e.start_time DESC, e.id DESC
         LIMIT ?`
      )
      .all(...params, intent.limit);

    const scope = [paxName && `for ${paxName}`, intent.ao && `at ${intent.ao}`, intent.range.label]
      .filter(Boolean)
      .join(" ");

    if (rows.length === 0) {
      return {
        text: `I don’t see boy-band/backblast image links ${scope ? `${scope} ` : ""}in the local reporting DB.`,
        source: "reporting_db_images",
      };
    }

    const limitNote =
      intent.broad || rows.length === intent.limit
        ? `\n\n_Limited to ${intent.limit} recent result${intent.limit === 1 ? "" : "s"} to avoid dumping the photo archive._`
        : "";

    return {
      text:
        `📸 *Boy-Band Links${scope ? ` — ${scope}` : ""}*\n\n` +
        "Using the backblast/attendance roster as the likely photo roster; I’m not doing image recognition.\n\n" +
        rowsToBullets(rows, (row) => formatBoyBandEvent(db, row, true), intent.limit) +
        limitNote,
      source: "reporting_db_images",
    };
  }

  if (intent.type === "max_attendance_by_ao") {
    const rows = db
      .prepare(
        `SELECT start_date,
                start_time,
                COALESCE(NULLIF(ao_name, ''), '(unknown)') AS ao,
                COALESCE(NULLIF(name, ''), '(unnamed workout)') AS name,
                pax_count
         FROM events
         WHERE ao_name = ? COLLATE NOCASE
         ORDER BY pax_count DESC, start_date DESC, start_time DESC, id DESC
         LIMIT 5`
      )
      .all(intent.ao);
    if (rows.length === 0) {
      return {
        text: `I don’t have attendance rows for ${intent.ao}.`,
        source: "reporting_db",
      };
    }

    const top = rows[0];
    return {
      text:
        `📊 *${top.ao} Attendance Record*\n\n` +
        `*Record:* ${top.pax_count} PAX on ${top.start_date}\n` +
        `*Workout:* ${top.name}\n\n` +
        `*Top records*\n` +
        numberedRows(rows, (row) => `${row.start_date} — ${row.pax_count} PAX — ${row.name}`, 5),
      source: "reporting_db",
    };
  }

  if (intent.type === "max_attendance_overall") {
    const rows = db
      .prepare(
        `SELECT id,
                start_date,
                start_time,
                COALESCE(NULLIF(ao_name, ''), '(unknown AO)') AS ao,
                COALESCE(NULLIF(location_name, ''), '(unknown location)') AS location,
                COALESCE(NULLIF(name, ''), '(unnamed workout)') AS name,
                pax_count
         FROM events
         ORDER BY pax_count DESC, start_date DESC, start_time DESC, id DESC
         LIMIT 5`
      )
      .all();

    if (rows.length === 0) {
      return {
        text: "I don’t have any attendance rows in the local reporting DB yet.",
        source: "reporting_db",
      };
    }

    const top = rows[0];
    const qLabels = getEventQLabels(db, top.id);
    return {
      text:
        `📊 *${LOCAL_REGION_NAME} Attendance Record*\n\n` +
        `*Record:* ${top.pax_count} PAX on ${top.start_date}\n` +
        `*Workout:* ${top.name}\n` +
        `*AO:* ${top.ao}\n` +
        `*Location:* ${top.location}\n` +
        `${formatQLabelsForSlack(qLabels)}\n\n` +
        `*Top records*\n` +
        rowsToBullets(
          rows,
          (row) => `• ${row.start_date} — ${row.pax_count} PAX — ${row.ao}: ${row.name}`,
          5
        ),
      source: "reporting_db",
    };
  }

  if (intent.type === "q_leaderboard_by_ao") {
    const rows = db
      .prepare(
        `SELECT a.f3_name,
                COUNT(*) AS q_count
         FROM attendance a
         JOIN events e ON e.id = a.event_instance_id
         WHERE e.start_date BETWEEN ? AND ?
           AND e.ao_name = ? COLLATE NOCASE
           AND a.q_ind = 1
           AND a.f3_name IS NOT NULL
           AND a.f3_name != ''
         GROUP BY a.f3_name
         ORDER BY q_count DESC, a.f3_name COLLATE NOCASE ASC
         LIMIT 10`
      )
      .all(intent.range.start, intent.range.end, intent.ao);

    if (rows.length === 0) {
      return {
        text: `I don’t have any marked Qs for ${intent.ao} during ${intent.range.label}.`,
        source: "reporting_db",
      };
    }

    const topCount = rows[0].q_count;
    const leaders = rows.filter((row) => row.q_count === topCount).map((row) => row.f3_name);
    return {
      text:
        `🏆 *${intent.ao} Q Leaderboard — ${intent.range.label}*\n\n` +
        `*Leader${leaders.length === 1 ? "" : "s"}:* ${leaders.join(", ")} (${topCount} Q${topCount === 1 ? "" : "s"})\n\n` +
        `*Top Qs*\n` +
        numberedRows(rows, (row) => `${row.f3_name} — ${row.q_count}`, 10),
      source: "reporting_db",
    };
  }

  if (intent.type === "hardest_beatdowns_fun") {
    const rows = db
      .prepare(
        `SELECT id,
                start_date,
                COALESCE(NULLIF(ao_name, ''), '(unknown AO)') AS ao,
                COALESCE(NULLIF(name, ''), '(unnamed workout)') AS name,
                COALESCE(description, '') AS description,
                pax_count
         FROM events
         WHERE start_date BETWEEN ? AND ?
           AND (
             COALESCE(name, '') != ''
             OR COALESCE(description, '') != ''
             OR pax_count >= 20
           )
         ORDER BY start_date DESC, id DESC
         LIMIT 1000`
      )
      .all(intent.range.start, intent.range.end);

    const qScores = new Map();
    for (const row of rows) {
      const scored = scoreHardBeatdown(row);
      if (scored.score < 5) continue;

      const labels = getEventQLabels(db, row.id);
      const qs = [...labels.qs, ...labels.coqs];
      if (qs.length === 0) continue;

      for (const q of qs) {
        const current = qScores.get(q) || { q, score: 0, examples: [] };
        current.score += scored.score;
        current.examples.push({
          ...row,
          score: scored.score,
          signals: scored.signals,
        });
        qScores.set(q, current);
      }
    }

    const leaders = [...qScores.values()]
      .map((entry) => ({
        ...entry,
        examples: entry.examples.sort((a, b) => b.score - a.score || b.start_date.localeCompare(a.start_date)),
      }))
      .sort((a, b) => b.score - a.score || a.q.localeCompare(b.q))
      .slice(0, 5);

    if (leaders.length === 0) {
      return {
        text:
          `🔥 *Unofficial Misery Index — ${intent.range.label}*\n\n` +
          "I don’t have enough Q-marked event/backblast text in the local reporting DB to make even a joking call on hardest beatdowns.",
        source: "reporting_db_fun",
      };
    }

    return {
      text:
        `🔥 *Unofficial Misery Index — ${intent.range.label}*\n\n` +
        "Not an official title belt. I scored Q-marked local event/backblast text for pain signals like Murph, HIIT, ruck, coupons, burpees, hills, and big PAX counts.\n\n" +
        numberedRows(
          leaders,
          (entry) => {
            const example = entry.examples[0];
            const signals = example.signals.length > 0 ? `; signals: ${example.signals.join(", ")}` : "";
            return `*${entry.q}* — ${example.start_date} at ${example.ao}: ${example.name}${signals}`;
          },
          5
        ) +
        "\n\nTranslation: these guys have paperwork suggesting they distribute discomfort. Coffeeteria lawyers may appeal.",
      source: "reporting_db_fun",
    };
  }

  if (intent.type === "event_q_followup") {
    const eventRows = db
      .prepare(
        `SELECT id,
                start_date,
                COALESCE(NULLIF(ao_name, ''), '(unknown)') AS ao,
                COALESCE(NULLIF(name, ''), '(unnamed workout)') AS name,
                pax_count
         FROM events
         WHERE start_date = ?
           AND ao_name = ? COLLATE NOCASE
           AND name = ? COLLATE NOCASE
         ORDER BY pax_count DESC, id DESC
         LIMIT 1`
      )
      .all(intent.event.startDate, intent.event.ao, intent.event.name);

    const fallbackRows =
      eventRows.length > 0
        ? eventRows
        : db
            .prepare(
              `SELECT id,
                      start_date,
                      COALESCE(NULLIF(ao_name, ''), '(unknown)') AS ao,
                      COALESCE(NULLIF(name, ''), '(unnamed workout)') AS name,
                      pax_count
               FROM events
               WHERE start_date = ?
                 AND ao_name = ? COLLATE NOCASE
               ORDER BY pax_count DESC, id DESC
               LIMIT 1`
            )
            .all(intent.event.startDate, intent.event.ao);

    if (fallbackRows.length === 0) {
      return {
        text: `I couldn’t match that prior event in the local reporting DB.`,
        source: "reporting_db",
      };
    }

    const event = fallbackRows[0];
    const qLabels = getEventQLabels(db, event.id);

    if (qLabels.qs.length === 0 && qLabels.coqs.length === 0) {
      return {
        text: `I found ${event.name} at ${event.ao} on ${event.start_date}, but the local reporting DB doesn’t have a Q marked for that event.`,
        source: "reporting_db",
      };
    }

    return {
      text:
        `🧾 *Event Q*\n\n` +
        `*Workout:* ${event.name}\n` +
        `*AO:* ${event.ao}\n` +
        `*Date:* ${event.start_date}\n` +
        `*PAX:* ${event.pax_count}\n` +
        formatQLabelsForSlack(qLabels),
      source: "reporting_db_followup",
    };
  }

  if (intent.type === "event_detail_followup") {
    const hasBackblast = hasTableColumn(db, "events", "backblast");
    const hasImages = hasTableColumn(db, "events", "image_urls_json");
    const eventRows = db
      .prepare(
        `SELECT id,
                start_date,
                COALESCE(NULLIF(ao_name, ''), '(unknown)') AS ao,
                COALESCE(NULLIF(name, ''), '(unnamed workout)') AS name,
                pax_count,
                COALESCE(${hasBackblast ? "NULLIF(backblast, '')" : "NULL"}, NULLIF(description, ''), '') AS detail
                ${hasImages ? ", image_urls_json" : ""}
         FROM events
         WHERE start_date = ?
           AND ao_name = ? COLLATE NOCASE
           AND name = ? COLLATE NOCASE
         ORDER BY pax_count DESC, id DESC
         LIMIT 1`
      )
      .all(intent.event.startDate, intent.event.ao, intent.event.name);

    const fallbackRows =
      eventRows.length > 0
        ? eventRows
        : db
            .prepare(
              `SELECT id,
                      start_date,
                      COALESCE(NULLIF(ao_name, ''), '(unknown)') AS ao,
                      COALESCE(NULLIF(name, ''), '(unnamed workout)') AS name,
                      pax_count,
                      COALESCE(${hasBackblast ? "NULLIF(backblast, '')" : "NULL"}, NULLIF(description, ''), '') AS detail
                      ${hasImages ? ", image_urls_json" : ""}
               FROM events
               WHERE start_date = ?
                 AND ao_name = ? COLLATE NOCASE
               ORDER BY pax_count DESC, id DESC
               LIMIT 1`
            )
            .all(intent.event.startDate, intent.event.ao);

    if (fallbackRows.length === 0) {
      return {
        text: "I couldn’t match that prior event in the local reporting DB.",
        source: "reporting_db_followup",
      };
    }

    const event = fallbackRows[0];
    const qLabels = getEventQLabels(db, event.id);
    const imageUrls = hasImages ? parseJsonArray(event.image_urls_json) : [];
    const imageText = imageUrls.length > 0 ? `\n*Boy-band link:* ${imageUrls[0]}\n` : "";
    const detail = event.detail
      ? truncateForSlack(event.detail)
      : "I found the event, but this local reporting DB does not have backblast text for it.";

    return {
      text:
        `🧾 *${event.name}*\n\n` +
        `*AO:* ${event.ao}\n` +
        `*Date:* ${event.start_date}\n` +
        `*PAX:* ${event.pax_count}\n` +
        `${formatQLabelsForSlack(qLabels)}${imageText}\n` +
        `*Backblast*\n${detail}`,
      source: "reporting_db_followup",
    };
  }

  if (intent.type === "scheduled_q_by_ao") {
    const rows = db
      .prepare(
        `SELECT id,
                start_date,
                start_time,
                end_time,
                COALESCE(NULLIF(ao_name, ''), '(unknown)') AS ao,
                COALESCE(NULLIF(name, ''), '(unnamed workout)') AS name,
                COALESCE(description, '') AS description,
                pax_count
         FROM events
         WHERE start_date BETWEEN ? AND ?
           AND ao_name = ? COLLATE NOCASE
         ORDER BY start_date ASC, start_time ASC, id ASC`
      )
      .all(intent.range.start, intent.range.end, intent.ao);

    const checkCalendarText =
      "I can’t confirm the scheduled Q from the available reporting data.";

    if (rows.length === 0) {
      return {
        text:
          `📅 *${intent.ao} Q Schedule — ${intent.range.label}*\n\n` +
          `I don’t have event/Q rows in the local reporting DB for ${intent.ao} during ${intent.range.label}.\n\n` +
          checkCalendarText,
        source: "reporting_db",
      };
    }

    const lines = rows.map((row) => {
      const labels = getEventQLabels(db, row.id);
      const qText =
        labels.qs.length > 0 || labels.coqs.length > 0
          ? formatQLabels(labels).replace(/\n/g, "; ")
          : "Q not marked in the local reporting DB";
      return `• *${row.start_date}* ${formatEventTime(row.start_time, row.end_time)} — ${row.name}: ${qText}`;
    });

    const hasUnmarkedQs = rows.some((row) => {
      const labels = getEventQLabels(db, row.id);
      return labels.qs.length === 0 && labels.coqs.length === 0;
    });

    return {
      text:
        `📅 *${intent.ao} Q Schedule — ${intent.range.label}*\n\n` +
        lines.join("\n") +
        (hasUnmarkedQs ? `\n\n${checkCalendarText}` : ""),
      source: "reporting_db",
    };
  }

  if (intent.type === "scheduled_workouts_by_region") {
    const rows = db
      .prepare(
        `SELECT id,
                start_date,
                start_time,
                end_time,
                COALESCE(NULLIF(ao_name, ''), '(unknown)') AS ao,
                COALESCE(NULLIF(name, ''), '(unnamed workout)') AS name,
                COALESCE(description, '') AS description,
                pax_count
         FROM events
         WHERE start_date BETWEEN ? AND ?
         ORDER BY start_date ASC, start_time ASC, ao COLLATE NOCASE ASC, id ASC`
      )
      .all(intent.range.start, intent.range.end)
      .filter((row) => rowMatchesWorkoutKind(row, intent.workoutKind || ""));

    if (rows.length === 0) {
      return {
        text:
          `📅 *${localRegionScheduleTitle(intent.range, intent.workoutKind || "")}*\n\n` +
          `I don’t have event rows in the local reporting DB during ${intent.range.label}.`,
        source: "reporting_db_region",
      };
    }

    return {
      text:
        `📅 *${localRegionScheduleTitle(intent.range, intent.workoutKind || "")}*\n\n` +
        rowsToDayGroupsWithLimitNote(
          rows,
          (row) => row.start_date,
          (row) => {
            const labels = getEventQLabels(db, row.id);
            const qText =
              labels.qs.length > 0 || labels.coqs.length > 0
                ? `; ${formatQLabels(labels).replace(/\n/g, "; ")}`
                : "";
            return `• ${formatEventTime(row.start_time, row.end_time)} — ${row.ao}: ${row.name}${qText}`;
          },
          100
        ),
      source: "reporting_db_region",
    };
  }

  if (intent.type === "avg_attendance_by_ao") {
    const rows = db
      .prepare(
        `SELECT COALESCE(NULLIF(ao_name, ''), '(unknown)') AS ao,
                COUNT(*) AS workouts,
                ROUND(AVG(pax_count), 1) AS avg_pax,
                MIN(pax_count) AS min_pax,
                MAX(pax_count) AS max_pax,
                SUM(pax_count) AS total_pax
         FROM events
         WHERE start_date BETWEEN ? AND ?
           AND ao_name = ? COLLATE NOCASE
         GROUP BY ao`
      )
      .all(intent.range.start, intent.range.end, intent.ao);
    if (rows.length === 0) {
      return {
        text: `I don’t have attendance rows for ${intent.ao} during ${intent.range.label}.`,
        source: "reporting_db",
      };
    }
    const row = rows[0];
    return {
      text:
        `📈 *${row.ao} Attendance — ${intent.range.label}*\n\n` +
        `• Average: *${row.avg_pax} PAX*\n` +
        `• Workouts: ${row.workouts}\n` +
        `• Range: ${row.min_pax}-${row.max_pax}\n` +
        `• Total PAX counted: ${row.total_pax}`,
      source: "reporting_db",
    };
  }

  if (intent.type === "attendance_by_ao_day") {
    const rows = db
      .prepare(
        `SELECT COALESCE(NULLIF(ao_name, ''), '(unknown)') AS ao,
                COUNT(*) AS workouts,
                ROUND(AVG(pax_count), 1) AS avg_pax,
                SUM(pax_count) AS total_pax
         FROM events
         WHERE start_date BETWEEN ? AND ?
           AND strftime('%w', start_date) = ?
         GROUP BY ao
         ORDER BY ao ASC`
      )
      .all(intent.range.start, intent.range.end, intent.weekday.number);
    return {
      text:
        `📊 *Attendance by AO — ${intent.weekday.name}, ${intent.range.label}*\n\n` +
        rowsToBullets(
          rows,
          (row) =>
            `• *${row.ao}:* ${row.avg_pax} avg PAX across ${row.workouts} workout(s), ${row.total_pax} total PAX`
        ),
      source: "reporting_db",
    };
  }

  if (intent.type === "fngs_by_month") {
    const rows = db
      .prepare(
        `SELECT strftime('%Y-%m', start_date) AS month,
                SUM(fng_count) AS fngs
         FROM events
         WHERE start_date BETWEEN ? AND ?
         GROUP BY month
         ORDER BY month`
      )
      .all(intent.range.start, intent.range.end);
    const total = rows.reduce((sum, row) => sum + Number(row.fngs || 0), 0);
    return {
      text:
        `🌱 *FNGs by Month — ${intent.range.label}*\n\n` +
        rowsToBullets(rows, (row) => `• ${row.month}: ${formatNumber(row.fngs)}`) +
        `\n\n*Total:* ${total}`,
      source: "reporting_db",
    };
  }

  if (intent.type === "workouts_by_month") {
    const rows = db
      .prepare(
        `SELECT strftime('%Y-%m', start_date) AS month,
                COUNT(*) AS workouts,
                ROUND(AVG(pax_count), 1) AS avg_pax
         FROM events
         WHERE start_date BETWEEN ? AND ?
         GROUP BY month
         ORDER BY month`
      )
      .all(intent.range.start, intent.range.end);
    return {
      text:
        `📅 *Workouts by Month — ${intent.range.label}*\n\n` +
        rowsToBullets(rows, (row) => `• ${row.month}: ${row.workouts} workout(s), ${row.avg_pax} avg PAX`),
      source: "reporting_db",
    };
  }

  if (intent.type === "workouts_by_ao") {
    const rows = db
      .prepare(
        `SELECT COALESCE(NULLIF(ao_name, ''), '(unknown)') AS ao,
                COUNT(*) AS workouts,
                ROUND(AVG(pax_count), 1) AS avg_pax
         FROM events
         WHERE start_date BETWEEN ? AND ?
         GROUP BY ao
         ORDER BY workouts DESC, ao ASC`
      )
      .all(intent.range.start, intent.range.end);
    return {
      text:
        `📍 *Workouts by AO — ${intent.range.label}*\n\n` +
        rowsToBullets(rows, (row) => `• *${row.ao}:* ${row.workouts} workout(s), ${row.avg_pax} avg PAX`),
      source: "reporting_db",
    };
  }

  return null;
}

async function runReportWithLiveSources(db, intent, context = {}) {
  if (!intent || intent.blocked) return runReport(db, intent, context);

  try {
    const liveReport = await tryRunLiveScheduleReport(db, intent);
    if (liveReport) return liveReport;
  } catch (err) {
    if (context.log) context.log("F3 Nation API schedule lookup failed", err);
  }

  return runReport(db, intent, context);
}

async function maybeAnswerReportingQuestion(text, options = {}) {
  const dbPath = typeof options === "string" ? options : options.dbPath || reportingDbPath();
  const context = typeof options === "string" ? {} : options;
  const db = openReportingDb(dbPath);
  try {
    const intent = classifyReportRequest(text, db, context);
    if (!intent) return null;
    return await runReportWithLiveSources(db, intent, context);
  } finally {
    db.close();
  }
}

module.exports = {
  BLOCKED_RECENT_PERSON_ATTENDANCE_REPLY,
  PAX_VAULT_URL,
  SELF_ATTENDANCE_NAME_MISMATCH_REPLY,
  UNSUPPORTED_REPORTING_REPLY,
  classifyReportRequest,
  extractReferencedEventFromContext,
  extractQLeaderboardContext,
  hasNonBotSlackMention,
  isUnsupportedReportingStatsQuestion,
  isEventQFollowUp,
  isThirdPartyAttendanceRequest,
  matchSlackNameToPax,
  maybeAnswerReportingQuestion,
  monthRangeFromText,
  normalizeText,
  openReportingDb,
  runReport,
  runReportWithLiveSources,
};
