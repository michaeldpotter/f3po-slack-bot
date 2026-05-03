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
const DEFAULT_SYNC_LOG_RETENTION_DAYS = 90;

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
  const logRetentionDays = Number.parseInt(
    valueAfter("--log-retention-days") ||
      process.env.REPORTING_SYNC_LOG_RETENTION_DAYS ||
      DEFAULT_SYNC_LOG_RETENTION_DAYS,
    10
  );
  if (!Number.isInteger(logRetentionDays) || logRetentionDays < 1 || logRetentionDays > 3660) {
    throw new Error("--log-retention-days must be an integer between 1 and 3660.");
  }

  return {
    full: args.includes("--full"),
    dryRun: args.includes("--dry-run"),
    days,
    logRetentionDays,
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

function parseJsonMaybe(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function arrayFromMeta(meta, key) {
  const parsed = parseJsonMaybe(meta);
  const value = parsed?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim());
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
  preblast TEXT,
  backblast TEXT,
  event_meta_json TEXT,
  image_urls_json TEXT,
  file_ids_json TEXT,
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

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  mode TEXT NOT NULL,
  cutoff TEXT,
  status TEXT NOT NULL,
  fetched_events INTEGER NOT NULL DEFAULT 0,
  fetched_attendance INTEGER NOT NULL DEFAULT 0,
  added_events INTEGER NOT NULL DEFAULT 0,
  updated_events INTEGER NOT NULL DEFAULT 0,
  added_attendance INTEGER NOT NULL DEFAULT 0,
  updated_attendance INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

CREATE TABLE IF NOT EXISTS sync_record_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  logged_at TEXT NOT NULL,
  table_name TEXT NOT NULL,
  record_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  record_date TEXT,
  display_name TEXT,
  details_json TEXT,
  FOREIGN KEY(run_id) REFERENCES sync_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_events_start_date ON events(start_date);
CREATE INDEX IF NOT EXISTS idx_events_updated ON events(updated);
CREATE INDEX IF NOT EXISTS idx_events_ao ON events(ao_name);
CREATE INDEX IF NOT EXISTS idx_attendance_event ON attendance(event_instance_id);
CREATE INDEX IF NOT EXISTS idx_attendance_updated ON attendance(updated);
CREATE INDEX IF NOT EXISTS idx_attendance_f3_name ON attendance(f3_name);
CREATE INDEX IF NOT EXISTS idx_sync_runs_started ON sync_runs(started_at);
CREATE INDEX IF NOT EXISTS idx_sync_record_log_run ON sync_record_log(run_id);
CREATE INDEX IF NOT EXISTS idx_sync_record_log_logged ON sync_record_log(logged_at);
`);

  ensureColumn(db, "events", "preblast", "TEXT");
  ensureColumn(db, "events", "backblast", "TEXT");
  ensureColumn(db, "events", "event_meta_json", "TEXT");
  ensureColumn(db, "events", "image_urls_json", "TEXT");
  ensureColumn(db, "events", "file_ids_json", "TEXT");
}

function ensureColumn(db, table, column, type) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
  if (columns.includes(column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

function getSyncState(db, key) {
  return db.prepare("SELECT value FROM sync_state WHERE key = ?").get(key)?.value || "";
}

function setSyncState(db, key, value) {
  db.prepare(
    "INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).run(key, value, new Date().toISOString());
}

function startSyncRun(db, { mode, cutoff, startedAt }) {
  const result = db
    .prepare("INSERT INTO sync_runs (started_at, mode, cutoff, status) VALUES (?, ?, ?, ?)")
    .run(startedAt, mode, cutoff || "", "started");
  return Number(result.lastInsertRowid);
}

function finishSyncRun(db, runId, stats, error = "") {
  db.prepare(
    `UPDATE sync_runs
     SET finished_at = ?,
         status = ?,
         fetched_events = ?,
         fetched_attendance = ?,
         added_events = ?,
         updated_events = ?,
         added_attendance = ?,
         updated_attendance = ?,
         error = ?
     WHERE id = ?`
  ).run(
    new Date().toISOString(),
    error ? "failed" : "completed",
    stats.fetchedEvents || 0,
    stats.fetchedAttendance || 0,
    stats.addedEvents || 0,
    stats.updatedEvents || 0,
    stats.addedAttendance || 0,
    stats.updatedAttendance || 0,
    error,
    runId
  );
}

function pruneSyncLogs(db, retentionDays) {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const recordResult = db
    .prepare("DELETE FROM sync_record_log WHERE logged_at < ?")
    .run(cutoff);
  const runResult = db
    .prepare("DELETE FROM sync_runs WHERE started_at < ?")
    .run(cutoff);
  return {
    cutoff,
    deletedRecordLogs: recordResult.changes || 0,
    deletedRuns: runResult.changes || 0,
  };
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
  all_types, all_tags, preblast, backblast, meta, created, updated
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

function upsertEvents(db, rows, syncedAt, runId) {
  const stmt = db.prepare(`
INSERT INTO events (
  id, region_org_id, start_date, end_date, start_time, end_time, name, description,
  pax_count, fng_count, series_id, series_name, ao_org_id, ao_name, area_org_id,
  area_name, sector_org_id, sector_name, location_id, location_name, location_latitude,
  location_longitude, bootcamp_ind, run_ind, ruck_ind, first_f_ind, second_f_ind,
  third_f_ind, pre_workout_ind, off_the_books_ind, vq_ind, convergence_ind,
  all_types_json, all_tags_json, preblast, backblast, event_meta_json, image_urls_json,
  file_ids_json, created, updated, synced_at
) VALUES (
  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
  preblast = excluded.preblast,
  backblast = excluded.backblast,
  event_meta_json = excluded.event_meta_json,
  image_urls_json = excluded.image_urls_json,
  file_ids_json = excluded.file_ids_json,
  created = excluded.created,
  updated = excluded.updated,
  synced_at = excluded.synced_at
`);
  const existsStmt = db.prepare("SELECT 1 FROM events WHERE id = ?");
  const logStmt = db.prepare(`
INSERT INTO sync_record_log (
  run_id, logged_at, table_name, record_id, action, record_date, display_name, details_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
  const stats = { added: 0, updated: 0 };

  db.exec("BEGIN");
  try {
    for (const row of rows) {
      const action = existsStmt.get(row.id) ? "updated" : "added";
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
        row.preblast || "",
        row.backblast || "",
        jsonString(row.meta),
        JSON.stringify(arrayFromMeta(row.meta, "files")),
        JSON.stringify(arrayFromMeta(row.meta, "file_ids")),
        normalizeTimestamp(row.created),
        normalizeTimestamp(row.updated),
        syncedAt
      );
      if (action === "added") stats.added += 1;
      else stats.updated += 1;
      logStmt.run(
        runId,
        syncedAt,
        "events",
        row.id,
        action,
        normalizeDate(row.start_date),
        [row.start_date && normalizeDate(row.start_date), row.ao_name, row.name]
          .filter(Boolean)
          .join(" - "),
        jsonString({
          ao_name: row.ao_name || "",
          name: row.name || "",
          start_date: normalizeDate(row.start_date),
          updated: normalizeTimestamp(row.updated),
          pax_count: row.pax_count ?? 0,
          fng_count: row.fng_count ?? 0,
          image_count: arrayFromMeta(row.meta, "files").length,
        })
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return stats;
}

function upsertAttendance(db, rows, syncedAt, runId) {
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
  const existsStmt = db.prepare("SELECT 1 FROM attendance WHERE id = ?");
  const logStmt = db.prepare(`
INSERT INTO sync_record_log (
  run_id, logged_at, table_name, record_id, action, record_date, display_name, details_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
  const stats = { added: 0, updated: 0 };

  db.exec("BEGIN");
  try {
    for (const row of rows) {
      const action = existsStmt.get(row.id) ? "updated" : "added";
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
      if (action === "added") stats.added += 1;
      else stats.updated += 1;
      logStmt.run(
        runId,
        syncedAt,
        "attendance",
        row.id,
        action,
        normalizeDate(row.start_date),
        [row.start_date && normalizeDate(row.start_date), row.f3_name]
          .filter(Boolean)
          .join(" - "),
        jsonString({
          event_instance_id: row.event_instance_id,
          f3_name: row.f3_name || "",
          start_date: normalizeDate(row.start_date),
          updated: normalizeTimestamp(row.updated),
          q_ind: row.q_ind ?? 0,
          coq_ind: row.coq_ind ?? 0,
        })
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return stats;
}

function printSummary(db) {
  const eventCount = db.prepare("SELECT COUNT(*) AS count FROM events").get().count;
  const attendanceCount = db.prepare("SELECT COUNT(*) AS count FROM attendance").get().count;
  const firstEvent = db.prepare("SELECT MIN(start_date) AS value FROM events").get().value;
  const lastEvent = db.prepare("SELECT MAX(start_date) AS value FROM events").get().value;
  const backblastCount = db
    .prepare("SELECT COUNT(*) AS count FROM events WHERE COALESCE(backblast, '') != ''")
    .get().count;
  const imageUrlCount = db
    .prepare("SELECT COUNT(*) AS count FROM events WHERE COALESCE(image_urls_json, '[]') NOT IN ('', '[]')")
    .get().count;
  console.log(`SQLite events: ${eventCount}`);
  console.log(`SQLite attendance rows: ${attendanceCount}`);
  console.log(`Event date range: ${firstEvent || "n/a"} to ${lastEvent || "n/a"}`);
  console.log(`Events with backblast text: ${backblastCount}`);
  console.log(`Events with image URLs: ${imageUrlCount}`);
}

function printSyncRunSummary(stats, pruneStats) {
  console.log("Sync run counts:");
  console.log(`  events fetched: ${stats.fetchedEvents}`);
  console.log(`  events added: ${stats.addedEvents}`);
  console.log(`  events updated: ${stats.updatedEvents}`);
  console.log(`  attendance fetched: ${stats.fetchedAttendance}`);
  console.log(`  attendance added: ${stats.addedAttendance}`);
  console.log(`  attendance updated: ${stats.updatedAttendance}`);
  if (pruneStats) {
    console.log(
      `Pruned sync logs older than ${pruneStats.cutoff}: ${pruneStats.deletedRuns} run(s), ${pruneStats.deletedRecordLogs} record log(s).`
    );
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const db = openDb(args.dbPath);
  initDb(db);

  const cutoff = args.full ? "" : incrementalCutoff(db, args.days);
  const syncedAt = new Date().toISOString();
  const bigquery = new BigQuery(args.projectId ? { projectId: args.projectId } : undefined);
  let runId;

  console.log(`Mode: ${args.full ? "full" : "incremental"}`);
  console.log(`SQLite DB: ${args.dbPath}`);
  console.log(`Region org ID: ${args.regionOrgId}`);
  if (!args.full) console.log(`Incremental cutoff: ${cutoff}`);
  console.log(`Sync log retention: ${args.logRetentionDays} day(s)`);

  const stats = {
    fetchedEvents: 0,
    fetchedAttendance: 0,
    addedEvents: 0,
    updatedEvents: 0,
    addedAttendance: 0,
    updatedAttendance: 0,
  };

  try {
    const [events, attendance] = await Promise.all([
      fetchEvents(bigquery, args, cutoff),
      fetchAttendance(bigquery, args, cutoff),
    ]);

    stats.fetchedEvents = events.length;
    stats.fetchedAttendance = attendance.length;

    console.log(`Fetched events: ${events.length}`);
    console.log(`Fetched attendance rows: ${attendance.length}`);

    if (args.dryRun) {
      printSyncRunSummary(stats);
      printSummary(db);
      db.close();
      return;
    }

    runId = startSyncRun(db, {
      mode: args.full ? "full" : "incremental",
      cutoff,
      startedAt: syncedAt,
    });

    const eventStats = upsertEvents(db, events, syncedAt, runId);
    const attendanceStats = upsertAttendance(db, attendance, syncedAt, runId);
    stats.addedEvents = eventStats.added;
    stats.updatedEvents = eventStats.updated;
    stats.addedAttendance = attendanceStats.added;
    stats.updatedAttendance = attendanceStats.updated;

    setSyncState(db, "last_success_at", syncedAt);
    setSyncState(db, "last_mode", args.full ? "full" : "incremental");
    setSyncState(db, "last_cutoff", cutoff || "");
    finishSyncRun(db, runId, stats);
    const pruneStats = pruneSyncLogs(db, args.logRetentionDays);

    printSyncRunSummary(stats, pruneStats);
    printSummary(db);
    db.close();
    console.log("Reporting database sync complete.");
  } catch (err) {
    if (runId) finishSyncRun(db, runId, stats, err.stack || err.message || String(err));
    db.close();
    throw err;
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
