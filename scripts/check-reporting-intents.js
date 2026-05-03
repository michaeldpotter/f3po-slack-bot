// Lightweight regression checks for Slack shorthand that should route to
// deterministic reporting/API handlers before the model gets a chance to guess.

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { classifyReportRequest, maybeAnswerReportingQuestion, runReport } = require("../lib/reporting");

const REPORTING_FIXTURE_SQL = `
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  ao_name TEXT,
  ao_org_id INTEGER,
  start_date TEXT,
  start_time TEXT,
  end_time TEXT,
  name TEXT,
  pax_count INTEGER
);
CREATE TABLE attendance (
  id INTEGER PRIMARY KEY,
  event_instance_id INTEGER,
  f3_name TEXT,
  q_ind INTEGER,
  coq_ind INTEGER
);
INSERT INTO events (id, ao_name, ao_org_id, start_date, start_time, end_time, name, pax_count) VALUES
  (1, 'Wild West', 43950, '2026-05-02', '0630', '0730', 'Saturday Beatdown', 12),
  (2, 'Time Will Tell (TWT)', 12345, '2026-05-02', '0630', '0730', 'Saturday Beatdown', 8),
  (3, 'Flyover', 45713, '2026-05-02', '0530', '0615', 'Morning Flight', 9),
  (4, 'Depot', 45209, '2026-05-02', '0700', '0800', 'Depot Beatdown', 7),
  (5, 'Wild West', 43950, '2026-05-04', '0530', '0615', 'Monday Beatdown', 10),
  (6, 'Flyover', 45713, '2026-05-06', '0530', '0615', 'Wednesday Flight', 11);
INSERT INTO attendance (id, event_instance_id, f3_name, q_ind, coq_ind) VALUES
  (1, 1, 'Chubbs', 0, 0),
  (2, 5, 'Hammer Pants', 1, 0);
`;

async function main() {
const db = new DatabaseSync(":memory:");
db.exec(REPORTING_FIXTURE_SQL);

const scheduleCases = [
  ["who is q on sat at ww?", "Wild West", "saturday"],
  ["who is qing on sat at ww?", "Wild West", "saturday"],
  ["who is q at ww saturday", "Wild West", "saturday"],
  ["ww q saturday", "Wild West", "saturday"],
  ["q for ww sat?", "Wild West", "saturday"],
  ["who has the q at wild west this saturday", "Wild West", "saturday"],
  ["who is on q at twt tomorrow", "Time Will Tell (TWT)", "tomorrow"],
  ["show me wild west q schedule next week", "Wild West", "next week"],
  ["who qs flyover wed", "Flyover", "wednesday"],
  ["show q calendar for ww", "Wild West", "upcoming week"],
];

for (const [text, ao, label] of scheduleCases) {
  const intent = classifyReportRequest(text, db, {});
  assert.equal(intent?.type, "scheduled_q_by_ao", text);
  assert.equal(intent.ao, ao, text);
  assert.equal(intent.range.label, label, text);
}

const threadMessages = [
  { text: "who is q on sat at ww?" },
  {
    text:
      "📅 *Wild West Q Schedule — sat*\n\n" +
      "• *2026-05-02* 6:30 AM-7:30 AM — Wild West: Q: Hammer Pants",
  },
];

for (const text of ["rest of the month?", "what about next week", "and the rest of may?"]) {
  const intent = classifyReportRequest(text, db, { threadMessages });
  assert.equal(intent?.type, "scheduled_q_by_ao", text);
  assert.equal(intent.ao, "Wild West", text);
}

const typoAoFollowup = classifyReportRequest("What about for flyonver?", db, { threadMessages });
assert.equal(typoAoFollowup?.type, "scheduled_q_by_ao");
assert.equal(typoAoFollowup.ao, "Flyover");
assert.equal(typoAoFollowup.range.label, "upcoming week");

const leaderboard = classifyReportRequest("who qd the most at wild west last month", db, {});
assert.equal(leaderboard?.type, "q_leaderboard_by_ao");
assert.equal(leaderboard.range.label, "last month");

const realDate = Date;
class FixedDate extends Date {
  constructor(...args) {
    super(...(args.length > 0 ? args : ["2026-05-02T12:00:00.000Z"]));
  }

  static now() {
    return new realDate("2026-05-02T12:00:00.000Z").getTime();
  }
}
FixedDate.UTC = realDate.UTC;
FixedDate.parse = realDate.parse;
global.Date = FixedDate;
try {
  const selfWeekdays = classifyReportRequest(
    "Can you show me where I was the last four Saturdays?",
    db,
    {}
  );
  assert.equal(selfWeekdays?.type, "self_recent_weekday_attendance");
  assert.equal(selfWeekdays.weekday.label, "saturday");
  assert.deepEqual(selfWeekdays.dates, ["2026-05-02", "2026-04-25", "2026-04-18", "2026-04-11"]);

  const selfReport = runReport(db, selfWeekdays, { requesterName: "Chubbs" });
  assert.equal(selfReport.source, "reporting_db_self");
  assert.match(selfReport.text, /Chubbs's Most Recent 4 Saturdays/);
  assert.match(selfReport.text, /Wild West: Saturday Beatdown/);

  const namedSelfWeekdays = classifyReportRequest(
    "Yes, show me where Chubbs was the most recent four Saturdays",
    db,
    { requesterName: "Chubbs" }
  );
  assert.equal(namedSelfWeekdays?.type, "self_recent_weekday_attendance");

  const regionSchedule = classifyReportRequest("Show me the schedule for next week", db, {});
  assert.equal(regionSchedule?.type, "scheduled_workouts_by_region");
  assert.equal(regionSchedule.range.label, "next week");
  assert.equal(regionSchedule.range.start, "2026-05-04");
  assert.equal(regionSchedule.range.end, "2026-05-10");

  const regionScheduleReport = runReport(db, regionSchedule, {});
  assert.equal(regionScheduleReport.source, "reporting_db_region");
  assert.match(regionScheduleReport.text, /F3 Wichita Schedule — next week/);
  assert.match(regionScheduleReport.text, /Wild West: Monday Beatdown; Q: Hammer Pants/);
  assert.match(regionScheduleReport.text, /Flyover: Wednesday Flight/);

  const regionScheduleQFollowup = classifyReportRequest("Can you show me that with Qs?", db, {
    threadMessages: [
      { text: "show me the schedule for next week" },
      {
        text:
          "Got it — next week: Mon May 4 → Sun May 10, 2026. Here are the published AO times.",
      },
    ],
  });
  assert.equal(regionScheduleQFollowup?.type, "scheduled_workouts_by_region");
  assert.equal(regionScheduleQFollowup.range.label, "next week");

  const regionScheduleRangeFollowup = classifyReportRequest(
    "Can you show me for the next 14 days?",
    db,
    {
      threadMessages: [
        { text: "show me the schedule for next week" },
        {
          text:
            "📅 *F3 Wichita Schedule — next week*\n\n" +
            "• *2026-05-04* 5:30 AM-6:30 AM — Wild West: Q: Grease Monkey\n" +
            "• *2026-05-06* 5:30 AM-6:30 AM — Flyover: Q: not marked in the F3 Nation calendar",
        },
      ],
    }
  );
  assert.equal(regionScheduleRangeFollowup?.type, "scheduled_workouts_by_region");
  assert.equal(regionScheduleRangeFollowup.range.label, "next 14 days");
  assert.equal(regionScheduleRangeFollowup.range.start, "2026-05-02");
  assert.equal(regionScheduleRangeFollowup.range.end, "2026-05-16");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "f3po-reporting-test-"));
  const tmpDbPath = path.join(tmpDir, "f3po-reporting.sqlite");
  const fileDb = new DatabaseSync(tmpDbPath);
  fileDb.exec(REPORTING_FIXTURE_SQL);
  fileDb.close();

  const localDbReport = await maybeAnswerReportingQuestion(
    "Can you show me where I was the last four Saturdays?",
    { dbPath: tmpDbPath, requesterName: "Chubbs" }
  );
  assert.equal(localDbReport.source, "reporting_db_self");
  assert.match(localDbReport.text, /Wild West: Saturday Beatdown/);
  fs.rmSync(tmpDir, { recursive: true, force: true });
} finally {
  global.Date = realDate;
}

db.close();
console.log("reporting intent checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
