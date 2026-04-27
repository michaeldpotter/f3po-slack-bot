// Sync F3 Wichita reporting data from BigQuery into a local SQLite database.
//
// Usage:
//   node scripts/sync-reporting-db.js --full
//   node scripts/sync-reporting-db.js
//   node scripts/sync-reporting-db.js --days 3
//
// Auth:
//   Use normal Google Application Default Credentials, or set GOOGLE_APPLICATION_CREDENTIALS.

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { BigQuery } = require("@google-cloud/bigquery");

const DEFAULT_DB_PATH = path.join("export", "google", "f3po-reporting.sqlite");
const DEFAULT_EVENT_TABLE = "analytics.event_info";
const DEFAULT_ATTENDANCE_TABLE = "analytics.attendance_info";
const DEFAULT_REGION_ORG_ID = 36533;
const DEFAULT_INCREMENTAL_DAYS = 2;

function parseArgs(argv) {
  const args = argv.slice(2);
  const valueAfter = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };

  const days = Number.parseInt(
    valueAfter("--days") || process.env.REPORTING_SYNC_DAYS || DEFAULT_INCREMENTAL_DAYS,
    10
  );
  if (!Number.isInteger(days) || days < 1 || days > 3660) {
    throw new Error("--days must be an integer between 1 and 3660.");
  }

  return {
    full: args.includes("--full"),
    dryRun: args.includes("--dry-run"),
    days,
    dbPath: valueAfter("--db") || process.env.REPORTING_DB_PATH || DEFAULT_DB_PATH,
    eventTable: valueAfter("--event-table") || process.env.REPORTING_EVENT_TABLE || DEFAULT_EVENT_TABLE,
    attendanceTable:
      valueAfter("--attendance-table") ||
      process.env.REPORTING_ATTENDANCE_TABLE ||
      DEFAULT_ATTENDANCE_TABLE,
    regionOrgId: Number.parseInt(
      valueAfter("--region-org-id") ||
        process.env.REPORTING_REGION_ORG_ID ||
        DEFAULT_REGION_ORG_ID,
      10
    ),
    projectId: valueAfter("--project") || process.env.GOOGLE_CLOUD_PROJECT,
  };
}

function tableIdentifier(table) {
  const cleaned = table.replace(/^`|`$/g, "");
  if (!/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+){1,2}$/.test(cleaned)) {
    throw new Error("BigQuery table must be dataset.table or project.dataset.table.");
  }
  return `\`${cleaned}\``;
}

function normalizeDate(value) {
  if (!value) return "";
  if (typeof value === "string") return value.slice(0, 10);
  if (value.value) return String(value.value).slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function normalizeTimestamp(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (value.value) return String(value.value);
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function jsonString(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}

function initDb(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  region_org_id INTEGER NOT NULL,
  start_date TEXT,
  end_date TEXT,
  start_time TEXT,
  end_time TEXT,
  name TEXT,
  description TEXT,
  pax_count INTEGER,
  fng_count INTEGER,
  series_id INTEGER,
  series_name TEXT,
  ao_org_id INTEGER,
  ao_name TEXT,
  area_org_id INTEGER,
  area_name TEXT,
  sector_org_id INTEGER,
  sector_name TEXT,
  location_id INTEGER,
  location_name TEXT,
  location_latitude REAL,
  location_longitude REAL,
  bootcamp_ind INTEGER,
  run_ind INTEGER,
  ruck_ind INTEGER,
  first_f_ind INTEGER,
  second_f_ind INTEGER,
  third_f_ind INTEGER,
  pre_workout_ind INTEGER,
  off_the_books_ind INTEGER,
  vq_ind INTEGER,
  convergence_ind INTEGER,
  all_types_json TEXT,
  all_tags_json TEXT,
  created TEXT,
  updated TEXT,
  synced_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY,
  event_instance_id INTEGER NOT NULL,
  user_id INTEGER,
  f3_name TEXT,
  q_ind INTEGER,
  coq_ind INTEGER,
  home_region_id INTEGER,
  home_region_name TEXT,
  user_status TEXT,
  start_date TEXT,
  attendance_meta_json TEXT,
  created TEXT,
  updated TEXT,
  synced_at TEXT NOT NULL,
  FOREIGN KEY(event_instance_id) REFERENCES events(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_start_date ON events(start_date);
CREATE INDEX IF NOT EXISTS idx_events_updated ON events(updated);
CREATE INDEX IF NOT EXISTS idx_events_ao ON events(ao_name);
CREATE INDEX IF NOT EXISTS idx_attendance_event ON attendance(event_instance_id);
CREATE INDEX IF NOT EXISTS idx_attendance_updated ON attendance(updated);
CREATE INDEX IF NOT EXISTS idx_attendance_f3_name ON attendance(f3_name);
`);
}

function getSyncState(db, key) {
  return db.prepare("SELECT value FROM sync_state WHERE key = ?").get(key)?.value || "";
}

function setSyncState(db, key, value) {
  db.prepare(
    "INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).run(key, value, new Date().toISOString());
}

function incrementalCutoff(db, days) {
  const lastSuccess = getSyncState(db, "last_success_at");
  const fallback = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const fromLastSuccess = lastSuccess ? new Date(lastSuccess) : fallback;
  const cutoff = Number.isNaN(fromLastSuccess.getTime()) ? fallback : fromLastSuccess;
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  return cutoff.toISOString();
}

async function fetchEvents(bigquery, args, cutoff) {
  const where = args.full ? "" : "AND updated >= TIMESTAMP(@cutoff)";
  const query = `
SELECT
  id, region_org_id, start_date, end_date, start_time, end_time, name, description,
  pax_count, fng_count, series_id, series_name, ao_org_id, ao_name, area_org_id,
  area_name, sector_org_id, sector_name, location_id, location_name, location_latitude,
  location_longitude, bootcamp_ind, run_ind, ruck_ind, first_f_ind, second_f_ind,
  third_f_ind, pre_workout_ind, off_the_books_ind, vq_ind, convergence_ind,
  all_types, all_tags, created, updated
FROM ${tableIdentifier(args.eventTable)}
WHERE region_org_id = @regionOrgId
  ${where}
ORDER BY updated ASC, id ASC
`;

  const [rows] = await bigquery.query({
    query,
    params: {
      regionOrgId: args.regionOrgId,
      ...(args.full ? {} : { cutoff }),
    },
  });
  return rows;
}

async function fetchAttendance(bigquery, args, cutoff) {
  const where = args.full ? "" : "AND a.updated >= TIMESTAMP(@cutoff)";
  const query = `
SELECT
  a.id, a.user_id, a.event_instance_id, a.attendance_meta, a.created, a.updated,
  a.q_ind, a.coq_ind, a.f3_name, a.home_region_id, a.home_region_name,
  a.user_statusa, a.start_date
FROM ${tableIdentifier(args.attendanceTable)} a
JOIN ${tableIdentifier(args.eventTable)} e
  ON e.id = a.event_instance_id
WHERE e.region_org_id = @regionOrgId
  ${where}
ORDER BY a.updated ASC, a.id ASC
`;

  const [rows] = await bigquery.query({
    query,
    params: {
      regionOrgId: args.regionOrgId,
      ...(args.full ? {} : { cutoff }),
    },
  });
  return rows;
}

function upsertEvents(db, rows, syncedAt) {
  const stmt = db.prepare(`
INSERT INTO events (
  id, region_org_id, start_date, end_date, start_time, end_time, name, description,
  pax_count, fng_count, series_id, series_name, ao_org_id, ao_name, area_org_id,
  area_name, sector_org_id, sector_name, location_id, location_name, location_latitude,
  location_longitude, bootcamp_ind, run_ind, ruck_ind, first_f_ind, second_f_ind,
  third_f_ind, pre_workout_ind, off_the_books_ind, vq_ind, convergence_ind,
  all_types_json, all_tags_json, created, updated, synced_at
) VALUES (
  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
)
ON CONFLICT(id) DO UPDATE SET
  region_org_id = excluded.region_org_id,
  start_date = excluded.start_date,
  end_date = excluded.end_date,
  start_time = excluded.start_time,
  end_time = excluded.end_time,
  name = excluded.name,
  description = excluded.description,
  pax_count = excluded.pax_count,
  fng_count = excluded.fng_count,
  series_id = excluded.series_id,
  series_name = excluded.series_name,
  ao_org_id = excluded.ao_org_id,
  ao_name = excluded.ao_name,
  area_org_id = excluded.area_org_id,
  area_name = excluded.area_name,
  sector_org_id = excluded.sector_org_id,
  sector_name = excluded.sector_name,
  location_id = excluded.location_id,
  location_name = excluded.location_name,
  location_latitude = excluded.location_latitude,
  location_longitude = excluded.location_longitude,
  bootcamp_ind = excluded.bootcamp_ind,
  run_ind = excluded.run_ind,
  ruck_ind = excluded.ruck_ind,
  first_f_ind = excluded.first_f_ind,
  second_f_ind = excluded.second_f_ind,
  third_f_ind = excluded.third_f_ind,
  pre_workout_ind = excluded.pre_workout_ind,
  off_the_books_ind = excluded.off_the_books_ind,
  vq_ind = excluded.vq_ind,
  convergence_ind = excluded.convergence_ind,
  all_types_json = excluded.all_types_json,
  all_tags_json = excluded.all_tags_json,
  created = excluded.created,
  updated = excluded.updated,
  synced_at = excluded.synced_at
`);

  db.exec("BEGIN");
  try {
    for (const row of rows) {
      stmt.run(
        row.id,
        row.region_org_id,
        normalizeDate(row.start_date),
        normalizeDate(row.end_date),
        row.start_time || "",
        row.end_time || "",
        row.name || "",
        row.description || "",
        row.pax_count ?? 0,
        row.fng_count ?? 0,
        row.series_id,
        row.series_name || "",
        row.ao_org_id,
        row.ao_name || "",
        row.area_org_id,
        row.area_name || "",
        row.sector_org_id,
        row.sector_name || "",
        row.location_id,
        row.location_name || "",
        row.location_latitude,
        row.location_longitude,
        row.bootcamp_ind ?? 0,
        row.run_ind ?? 0,
        row.ruck_ind ?? 0,
        row.first_f_ind ?? 0,
        row.second_f_ind ?? 0,
        row.third_f_ind ?? 0,
        row.pre_workout_ind ?? 0,
        row.off_the_books_ind ?? 0,
        row.vq_ind ?? 0,
        row.convergence_ind ?? 0,
        jsonString(row.all_types),
        jsonString(row.all_tags),
        normalizeTimestamp(row.created),
        normalizeTimestamp(row.updated),
        syncedAt
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function upsertAttendance(db, rows, syncedAt) {
  const stmt = db.prepare(`
INSERT INTO attendance (
  id, user_id, event_instance_id, attendance_meta_json, created, updated,
  q_ind, coq_ind, f3_name, home_region_id, home_region_name, user_status,
  start_date, synced_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  user_id = excluded.user_id,
  event_instance_id = excluded.event_instance_id,
  attendance_meta_json = excluded.attendance_meta_json,
  created = excluded.created,
  updated = excluded.updated,
  q_ind = excluded.q_ind,
  coq_ind = excluded.coq_ind,
  f3_name = excluded.f3_name,
  home_region_id = excluded.home_region_id,
  home_region_name = excluded.home_region_name,
  user_status = excluded.user_status,
  start_date = excluded.start_date,
  synced_at = excluded.synced_at
`);

  db.exec("BEGIN");
  try {
    for (const row of rows) {
      stmt.run(
        row.id,
        row.user_id,
        row.event_instance_id,
        jsonString(row.attendance_meta),
        normalizeTimestamp(row.created),
        normalizeTimestamp(row.updated),
        row.q_ind ?? 0,
        row.coq_ind ?? 0,
        row.f3_name || "",
        row.home_region_id,
        row.home_region_name || "",
        row.user_statusa || "",
        normalizeDate(row.start_date),
        syncedAt
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function printSummary(db) {
  const eventCount = db.prepare("SELECT COUNT(*) AS count FROM events").get().count;
  const attendanceCount = db.prepare("SELECT COUNT(*) AS count FROM attendance").get().count;
  const firstEvent = db.prepare("SELECT MIN(start_date) AS value FROM events").get().value;
  const lastEvent = db.prepare("SELECT MAX(start_date) AS value FROM events").get().value;
  console.log(`SQLite events: ${eventCount}`);
  console.log(`SQLite attendance rows: ${attendanceCount}`);
  console.log(`Event date range: ${firstEvent || "n/a"} to ${lastEvent || "n/a"}`);
}

async function main() {
  const args = parseArgs(process.argv);
  const db = openDb(args.dbPath);
  initDb(db);

  const cutoff = args.full ? "" : incrementalCutoff(db, args.days);
  const syncedAt = new Date().toISOString();
  const bigquery = new BigQuery(args.projectId ? { projectId: args.projectId } : undefined);

  console.log(`Mode: ${args.full ? "full" : "incremental"}`);
  console.log(`SQLite DB: ${args.dbPath}`);
  console.log(`Region org ID: ${args.regionOrgId}`);
  if (!args.full) console.log(`Incremental cutoff: ${cutoff}`);

  const [events, attendance] = await Promise.all([
    fetchEvents(bigquery, args, cutoff),
    fetchAttendance(bigquery, args, cutoff),
  ]);

  console.log(`Fetched events: ${events.length}`);
  console.log(`Fetched attendance rows: ${attendance.length}`);

  if (args.dryRun) {
    printSummary(db);
    db.close();
    return;
  }

  upsertEvents(db, events, syncedAt);
  upsertAttendance(db, attendance, syncedAt);
  setSyncState(db, "last_success_at", syncedAt);
  setSyncState(db, "last_mode", args.full ? "full" : "incremental");
  setSyncState(db, "last_cutoff", cutoff || "");

  printSummary(db);
  db.close();
  console.log("Reporting database sync complete.");
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
