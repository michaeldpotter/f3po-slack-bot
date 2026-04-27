#!/usr/bin/env node
// Run approved aggregate reports against the local F3PO reporting SQLite DB.
//
// This script is intentionally not a SQL shell. It exposes named reports only,
// using parameterized queries, so it can become the safe foundation for Slack
// reporting later.

require("dotenv").config();

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

function printUsage() {
  console.log(`
Usage:
  node scripts/query-reporting-db.js status
  node scripts/query-reporting-db.js health [--max-age-hours 36]
  node scripts/query-reporting-db.js fngs-by-month [--days 365]
  node scripts/query-reporting-db.js workouts-by-month [--days 365]
  node scripts/query-reporting-db.js workouts-by-ao [--days 365]
  node scripts/query-reporting-db.js avg-attendance-by-ao [--ao Flyover] [--days 365]
  node scripts/query-reporting-db.js attendance-by-ao-day --day saturday [--days 365]

Examples:
  npm run reporting:status
  npm run reporting:health
  npm run reporting:query -- avg-attendance-by-ao --ao Flyover --days 365
  npm run reporting:query -- attendance-by-ao-day --day saturday --days 365

Notes:
  - These reports are aggregate AO/workout stats only.
  - This script does not support arbitrary SQL.
`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const report = args[0];
  const valueAfter = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };

  const days = Number.parseInt(valueAfter("--days") || "365", 10);
  if (!Number.isInteger(days) || days < 1 || days > 3660) {
    throw new Error("--days must be an integer between 1 and 3660.");
  }
  const maxAgeHours = Number.parseInt(
    valueAfter("--max-age-hours") || process.env.REPORTING_HEALTH_MAX_AGE_HOURS || "36",
    10
  );
  if (!Number.isInteger(maxAgeHours) || maxAgeHours < 1 || maxAgeHours > 8760) {
    throw new Error("--max-age-hours must be an integer between 1 and 8760.");
  }

  return {
    help: !report || report === "--help" || report === "-h",
    report,
    dbPath: valueAfter("--db") || process.env.REPORTING_DB_PATH || DEFAULT_DB_PATH,
    days,
    start: valueAfter("--start"),
    end: valueAfter("--end"),
    ao: valueAfter("--ao"),
    day: valueAfter("--day"),
    maxAgeHours,
  };
}

function isoDateDaysAgo(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function dateRange(args) {
  return {
    start: args.start || isoDateDaysAgo(args.days),
    end: args.end || new Date().toISOString().slice(0, 10),
  };
}

function openDb(dbPath) {
  return new DatabaseSync(dbPath);
}

function table(rows) {
  if (!rows || rows.length === 0) {
    console.log("No rows found.");
    return;
  }

  const columns = Object.keys(rows[0]);
  const widths = columns.map((column) =>
    Math.max(column.length, ...rows.map((row) => String(row[column] ?? "").length))
  );
  const line = columns.map((column, index) => column.padEnd(widths[index])).join("  ");
  const divider = widths.map((width) => "-".repeat(width)).join("  ");

  console.log(line);
  console.log(divider);
  for (const row of rows) {
    console.log(columns.map((column, index) => String(row[column] ?? "").padEnd(widths[index])).join("  "));
  }
}

function status(db) {
  const events = db.prepare("SELECT COUNT(*) AS count FROM events").get().count;
  const attendance = db.prepare("SELECT COUNT(*) AS count FROM attendance").get().count;
  const range = db.prepare("SELECT MIN(start_date) AS first_date, MAX(start_date) AS last_date FROM events").get();
  const syncState = db.prepare("SELECT key, value FROM sync_state ORDER BY key").all();
  const lastRun = db
    .prepare(
      `SELECT id, started_at, finished_at, status, mode, fetched_events, fetched_attendance,
              added_events, updated_events, added_attendance, updated_attendance
       FROM sync_runs
       ORDER BY id DESC
       LIMIT 1`
    )
    .get();

  console.log("Reporting DB status");
  table([
    {
      events,
      attendance,
      first_date: range.first_date || "n/a",
      last_date: range.last_date || "n/a",
    },
  ]);
  console.log("");
  console.log("Sync state");
  table(syncState.length > 0 ? syncState : [{ key: "n/a", value: "n/a" }]);
  console.log("");
  console.log("Last sync run");
  table(lastRun ? [lastRun] : [{ status: "n/a" }]);
}

function health(db, args) {
  const problems = [];
  const now = Date.now();
  const eventCount = db.prepare("SELECT COUNT(*) AS count FROM events").get().count;
  const attendanceCount = db.prepare("SELECT COUNT(*) AS count FROM attendance").get().count;
  const lastSuccessAt = db
    .prepare("SELECT value FROM sync_state WHERE key = 'last_success_at'")
    .get()?.value;
  const lastRun = db
    .prepare("SELECT id, status, mode, started_at, finished_at FROM sync_runs ORDER BY id DESC LIMIT 1")
    .get();

  if (eventCount < 1) problems.push("events table is empty");
  if (attendanceCount < 1) problems.push("attendance table is empty");
  if (!lastRun) problems.push("no sync_runs records found");
  else if (lastRun.status !== "completed") problems.push(`last sync run status is ${lastRun.status}`);

  let ageHours = null;
  if (!lastSuccessAt) {
    problems.push("last_success_at is missing");
  } else {
    const lastSuccessMs = new Date(lastSuccessAt).getTime();
    if (Number.isNaN(lastSuccessMs)) {
      problems.push(`last_success_at is invalid: ${lastSuccessAt}`);
    } else {
      ageHours = (now - lastSuccessMs) / (60 * 60 * 1000);
      if (ageHours > args.maxAgeHours) {
        problems.push(
          `last successful sync is ${ageHours.toFixed(1)} hours old, max is ${args.maxAgeHours}`
        );
      }
    }
  }

  const summary = {
    status: problems.length === 0 ? "ok" : "fail",
    events: eventCount,
    attendance: attendanceCount,
    last_success_at: lastSuccessAt || "n/a",
    age_hours: ageHours === null ? "n/a" : ageHours.toFixed(2),
    max_age_hours: args.maxAgeHours,
    last_run_status: lastRun?.status || "n/a",
    last_run_mode: lastRun?.mode || "n/a",
  };

  console.log("Reporting DB health");
  table([summary]);

  if (problems.length > 0) {
    console.error("");
    console.error("Health check failed:");
    for (const problem of problems) console.error(`- ${problem}`);
    process.exitCode = 1;
  }
}

function fngsByMonth(db, args) {
  const { start, end } = dateRange(args);
  const rows = db
    .prepare(
      `SELECT strftime('%Y-%m', start_date) AS month,
              SUM(fng_count) AS fngs,
              COUNT(*) AS workouts
       FROM events
       WHERE start_date BETWEEN ? AND ?
       GROUP BY month
       ORDER BY month`
    )
    .all(start, end);

  console.log(`FNGs by month (${start} to ${end})`);
  table(rows);
}

function workoutsByMonth(db, args) {
  const { start, end } = dateRange(args);
  const rows = db
    .prepare(
      `SELECT strftime('%Y-%m', start_date) AS month,
              COUNT(*) AS workouts,
              SUM(pax_count) AS total_pax,
              ROUND(AVG(pax_count), 1) AS avg_pax
       FROM events
       WHERE start_date BETWEEN ? AND ?
       GROUP BY month
       ORDER BY month`
    )
    .all(start, end);

  console.log(`Workouts by month (${start} to ${end})`);
  table(rows);
}

function workoutsByAo(db, args) {
  const { start, end } = dateRange(args);
  const rows = db
    .prepare(
      `SELECT COALESCE(NULLIF(ao_name, ''), '(unknown)') AS ao,
              COUNT(*) AS workouts,
              SUM(pax_count) AS total_pax,
              ROUND(AVG(pax_count), 1) AS avg_pax
       FROM events
       WHERE start_date BETWEEN ? AND ?
       GROUP BY ao
       ORDER BY workouts DESC, ao ASC`
    )
    .all(start, end);

  console.log(`Workouts by AO (${start} to ${end})`);
  table(rows);
}

function avgAttendanceByAo(db, args) {
  const { start, end } = dateRange(args);
  const rows = args.ao
    ? db
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
           GROUP BY ao
           ORDER BY ao ASC`
        )
        .all(start, end, args.ao)
    : db
        .prepare(
          `SELECT COALESCE(NULLIF(ao_name, ''), '(unknown)') AS ao,
                  COUNT(*) AS workouts,
                  ROUND(AVG(pax_count), 1) AS avg_pax,
                  MIN(pax_count) AS min_pax,
                  MAX(pax_count) AS max_pax,
                  SUM(pax_count) AS total_pax
           FROM events
           WHERE start_date BETWEEN ? AND ?
           GROUP BY ao
           ORDER BY avg_pax DESC, workouts DESC, ao ASC`
        )
        .all(start, end);

  console.log(
    `Average attendance by AO${args.ao ? ` for ${args.ao}` : ""} (${start} to ${end})`
  );
  table(rows);
}

function attendanceByAoDay(db, args) {
  const { start, end } = dateRange(args);
  if (!args.day) throw new Error("--day is required for attendance-by-ao-day.");

  const dayNumber = DAY_NUMBERS.get(args.day.toLowerCase());
  if (dayNumber === undefined) {
    throw new Error("--day must be a weekday name such as saturday.");
  }

  const rows = db
    .prepare(
      `SELECT COALESCE(NULLIF(ao_name, ''), '(unknown)') AS ao,
              COUNT(*) AS workouts,
              ROUND(AVG(pax_count), 1) AS avg_pax,
              SUM(pax_count) AS total_pax,
              MIN(start_date) AS first_workout,
              MAX(start_date) AS last_workout
       FROM events
       WHERE start_date BETWEEN ? AND ?
         AND strftime('%w', start_date) = ?
       GROUP BY ao
       ORDER BY ao ASC`
    )
    .all(start, end, dayNumber);

  console.log(`Attendance by AO on ${args.day} (${start} to ${end})`);
  table(rows);
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printUsage();
    return;
  }

  const db = openDb(args.dbPath);
  try {
    if (args.report === "status") status(db);
    else if (args.report === "health") health(db, args);
    else if (args.report === "fngs-by-month") fngsByMonth(db, args);
    else if (args.report === "workouts-by-month") workoutsByMonth(db, args);
    else if (args.report === "workouts-by-ao") workoutsByAo(db, args);
    else if (args.report === "avg-attendance-by-ao") avgAttendanceByAo(db, args);
    else if (args.report === "attendance-by-ao-day") attendanceByAoDay(db, args);
    else throw new Error(`Unknown approved report: ${args.report}`);
  } finally {
    db.close();
  }
}

try {
  main();
} catch (err) {
  console.error(err.message || String(err));
  process.exit(1);
}
