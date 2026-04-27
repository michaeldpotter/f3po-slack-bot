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
    /\b(average|avg|count|counts|total|totals|how many|by month|by ao|all aos|fngs|highest|max|maximum|record|ever|most highly|largest|biggest)\b/.test(
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

function isEventQFollowUp(text = "") {
  const normalized = normalizeText(text);
  return (
    /\bwho\b/.test(normalized) &&
    /\b(q\s+(ed|d)|qed|qd)\b/.test(normalized) &&
    /\b(that|it|this)\b/.test(normalized)
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

function classifyReportRequest(text = "", db, context = {}) {
  const normalized = normalizeText(text);
  if (
    /\b(last|recent|latest)\b/.test(normalized) &&
    /\b(5|five)\b/.test(normalized) &&
    /\b(i|me|my|mine)\b/.test(normalized) &&
    /\b(work out|worked out|workouts?|beatdowns?|attended|attendance|posted|posts?)\b/.test(normalized)
  ) {
    return { type: "self_last_workouts", limit: 5 };
  }

  if (
    /\b(last time|when)\b/.test(normalized) &&
    /\b(i|me|my|mine)\b/.test(normalized) &&
    /\b(worked out|workout|beatdown|attended|posted)\b/.test(normalized)
  ) {
    return { type: "self_last_workouts", limit: 1 };
  }

  if (isEventQFollowUp(text)) {
    const event = extractReferencedEventFromContext(context);
    if (event) {
      return { type: "event_q_followup", event };
    }
  }

  if (
    /\b(highest|max|maximum|record|most highly|largest|biggest)\b/.test(normalized) &&
    /\b(attendance|attended|pax|beatdowns?|workouts?)\b/.test(normalized)
  ) {
    const ao = matchAoName(db, text);
    if (ao) {
      return { type: "max_attendance_by_ao", ao };
    }
    return { type: "max_attendance_overall" };
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

function runReport(db, intent, context = {}) {
  if (intent.blocked) {
    return { text: intent.response, source: "reporting_policy_block" };
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
        `${match.name}, here ${rows.length === 1 ? "is your last recorded workout" : `are your last ${rows.length} recorded workouts`}:\n` +
        rowsToBullets(rows, (row) => {
          const role = row.q_ind ? " Q" : row.coq_ind ? " Co-Q" : "";
          return `- ${row.start_date}: ${row.ao} - ${row.name} (${row.pax_count} PAX${role})`;
        }, intent.limit),
      source: "reporting_db_self",
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
        `${top.ao}'s highest recorded attendance is ${top.pax_count} PAX on ${top.start_date} for ${top.name}.\n` +
        `Top records:\n` +
        rowsToBullets(rows, (row) => `- ${row.start_date}: ${row.pax_count} PAX - ${row.name}`, 5),
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
        `The highest recorded F3 Wichita attendance I have is ${top.pax_count} PAX on ${top.start_date} for ${top.name}.\n` +
        `AO: ${top.ao}\n` +
        `Location: ${top.location}\n` +
        `${formatQLabels(qLabels)}\n` +
        `Top records:\n` +
        rowsToBullets(
          rows,
          (row) => `- ${row.start_date}: ${row.pax_count} PAX - ${row.ao} - ${row.name}`,
          5
        ),
      source: "reporting_db",
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
        `${event.name} at ${event.ao} on ${event.start_date} had ${event.pax_count} PAX.\n` +
        formatQLabels(qLabels),
      source: "reporting_db_followup",
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

function maybeAnswerReportingQuestion(text, options = {}) {
  const dbPath = typeof options === "string" ? options : options.dbPath || reportingDbPath();
  const context = typeof options === "string" ? {} : options;
  const db = openReportingDb(dbPath);
  try {
    const intent = classifyReportRequest(text, db, context);
    if (!intent) return null;
    return runReport(db, intent, context);
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
  isUnsupportedReportingStatsQuestion,
  isEventQFollowUp,
  matchSlackNameToPax,
  maybeAnswerReportingQuestion,
  normalizeText,
  openReportingDb,
  runReport,
};
