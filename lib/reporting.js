const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const DEFAULT_DB_PATH = path.join("export", "google", "f3po-reporting.sqlite");
const DAY_NUMBERS = new Map([
  ["sunday", "0"],
  ["sun", "0"],
  ["monday", "1"],
  ["mon", "1"],
  ["tuesday", "2"],
  ["tue", "2"],
  ["wednesday", "3"],
  ["wed", "3"],
  ["thursday", "4"],
  ["thu", "4"],
  ["friday", "5"],
  ["fri", "5"],
  ["saturday", "6"],
  ["sat", "6"],
]);

const BLOCKED_RECENT_PERSON_ATTENDANCE_REPLY =
  "I can’t report recent individual attendance or location patterns. I can help with aggregate AO activity, FNG counts, Q counts, or longer-range non-current trends.";
const PAX_VAULT_URL = "https://pax-vault.f3nation.com/";
const UNSUPPORTED_REPORTING_REPLY =
  `I don’t have that report type wired in yet. You may want to check PAX Vault: ${PAX_VAULT_URL}`;

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

function isoDateDaysAgo(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function currentDate() {
  return new Date().toISOString().slice(0, 10);
}

function currentYearStart() {
  return `${new Date().getFullYear()}-01-01`;
}

function dateRangeFromText(text = "") {
  const normalized = normalizeText(text);
  if (/\bthis year\b/.test(normalized)) {
    return { start: currentYearStart(), end: currentDate(), label: "this year" };
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

function matchAoName(db, text) {
  const normalized = normalizeText(text);
  const aos = getDistinctAoNames(db);
  const matches = aos
    .map((name) => ({ name, normalizedName: normalizeText(name) }))
    .filter(({ normalizedName }) => normalizedName && normalized.includes(normalizedName))
    .sort((a, b) => b.normalizedName.length - a.normalizedName.length);

  return matches[0]?.name || "";
}

function weekdayFromText(text = "") {
  const normalized = normalizeText(text);
  for (const [name, number] of DAY_NUMBERS.entries()) {
    if (new RegExp(`\\b${name}\\b`).test(normalized)) return { name, number };
  }
  return null;
}

function isBlockedPersonAttendanceQuestion(text = "") {
  const normalized = normalizeText(text);
  const asksAttendance =
    /\b(where|when|show|list|was|did|has)\b/.test(normalized) &&
    /\b(work out|worked out|workout|attended|attendance|post|posted|at ao|where did|last time|last 5)\b/.test(
      normalized
    );
  const asksRoster = /\b(who was|who attended|show everyone|attendance roster|full roster)\b/.test(
    normalized
  );
  const selfQuestion = /\b(i|me|my|mine)\b/.test(normalized);
  const aggregateQuestion =
    /\b(average|avg|count|counts|total|totals|how many|by month|by ao|all aos|fngs)\b/.test(
      normalized
    );

  if (asksRoster) return true;
  return asksAttendance && !selfQuestion && !aggregateQuestion;
}

function isUnsupportedReportingStatsQuestion(text = "") {
  const normalized = normalizeText(text);
  const reportingTerms =
    /\b(stats?|statistics|report|reports|numbers?|metrics?|trend|trends|attendance|attend|pax|posts?|posted|q count|qs|fngs?|kotter|average|avg|count|counts|total|totals|how many)\b/.test(
      normalized
    );
  const f3Terms =
    /\b(ao|aos|workout|workouts|beatdown|beatdowns|pax|fng|fngs|q|qs|post|posts|attendance|attend|region|kotter|kotters|wichita)\b/.test(
      normalized
    );

  return reportingTerms && f3Terms;
}

function classifyReportRequest(text = "", db) {
  const normalized = normalizeText(text);
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

  if (/\b(workouts?|beatdowns?)\b/.test(normalized) && /\b(month|monthly|by month)\b/.test(normalized)) {
    return { type: "workouts_by_month", range: dateRangeFromText(text) };
  }

  if (/\b(workouts?|beatdowns?|activity)\b/.test(normalized) && /\b(ao|aos|by ao)\b/.test(normalized)) {
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

  return null;
}

function formatNumber(value) {
  if (value === null || value === undefined) return "0";
  return String(value);
}

function rowsToBullets(rows, formatter, limit = 20) {
  return rows.slice(0, limit).map(formatter).join("\n");
}

function runReport(db, intent) {
  if (intent.blocked) {
    return { text: intent.response, source: "reporting_policy_block" };
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
        `${row.ao} averaged ${row.avg_pax} PAX over ${row.workouts} workout(s) during ${intent.range.label}. ` +
        `Range: ${row.min_pax}-${row.max_pax}; total PAX counted: ${row.total_pax}.`,
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
        `Attendance by AO on ${intent.weekday.name} for ${intent.range.label}:\n` +
        rowsToBullets(
          rows,
          (row) =>
            `- ${row.ao}: ${row.avg_pax} avg PAX across ${row.workouts} workout(s), ${row.total_pax} total PAX`
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
        `FNGs by month for ${intent.range.label}:\n` +
        rowsToBullets(rows, (row) => `- ${row.month}: ${formatNumber(row.fngs)}`) +
        `\nTotal: ${total}`,
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
        `Workouts by month for ${intent.range.label}:\n` +
        rowsToBullets(rows, (row) => `- ${row.month}: ${row.workouts} workout(s), ${row.avg_pax} avg PAX`),
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
        `Workouts by AO for ${intent.range.label}:\n` +
        rowsToBullets(rows, (row) => `- ${row.ao}: ${row.workouts} workout(s), ${row.avg_pax} avg PAX`),
      source: "reporting_db",
    };
  }

  return null;
}

function maybeAnswerReportingQuestion(text, dbPath = reportingDbPath()) {
  const db = openReportingDb(dbPath);
  try {
    const intent = classifyReportRequest(text, db);
    if (!intent) return null;
    return runReport(db, intent);
  } finally {
    db.close();
  }
}

module.exports = {
  BLOCKED_RECENT_PERSON_ATTENDANCE_REPLY,
  PAX_VAULT_URL,
  UNSUPPORTED_REPORTING_REPLY,
  classifyReportRequest,
  isUnsupportedReportingStatsQuestion,
  maybeAnswerReportingQuestion,
  normalizeText,
  openReportingDb,
  runReport,
};
