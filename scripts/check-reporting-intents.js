// Lightweight regression checks for Slack shorthand that should route to
// deterministic reporting/API handlers before the model gets a chance to guess.

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { classifyReportRequest, maybeAnswerReportingQuestion, runReport } = require("../lib/reporting");

const manyEvents = Array.from({ length: 65 }, (_, index) => {
  const id = 100 + index;
  const day = String((index % 14) + 3).padStart(2, "0");
  const hour = String(5 + (index % 3)).padStart(2, "0");
  return `(${id}, 'AO ${index + 1}', ${50000 + index}, '2026-05-${day}', '${hour}30', '${hour}45', 'Extra Beatdown ${index + 1}', 5)`;
}).join(",\n  ");

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
  (6, 'Flyover', 45713, '2026-05-06', '0530', '0615', 'Wednesday Flight', 11),
  ${manyEvents};
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
  ["show me flyover schedule next week", "Flyover", "next week"],
  ["when is flyover this week", "Flyover", "this week"],
  ["what time is depot tomorrow", "Depot", "tomorrow"],
  ["is there a workout at depot today", "Depot", "today"],
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

const thirdPartyLastWorkouts = classifyReportRequest(
  "Show me the last 5 workouts that <@U06MS2VU37C> was at",
  db,
  { requesterName: "Chubbs", botUserId: "U0AVA0SAXDL" }
);
assert.equal(thirdPartyLastWorkouts?.type, "blocked_recent_person_attendance");

const firstNantan = classifyReportRequest("Who was the first nantan?", db, {});
assert.equal(firstNantan, null);

const betaAnnouncement = classifyReportRequest(
  "_*Hey PAX, I’m opening this channel up for some F3PO beta testing.*_ " +
    "F3PO is our Slack bot that can answer questions using F3 Wichita / F3 Nation docs. " +
    "Example: <@U0AVA0SAXDL> Who is the Tech Q for F3 Wichita?",
  db,
  { botUserId: "U0AVA0SAXDL" }
);
assert.equal(betaAnnouncement, null);

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

  const regionScheduleCases = [
    ["what workouts are on the calendar for the next 14 days?", "next 14 days", "2026-05-02", "2026-05-16"],
    ["show me all workouts tomorrow", "tomorrow", "2026-05-03", "2026-05-03"],
    ["show me the F3 Wichita calendar this weekend", "this weekend", "2026-05-02", "2026-05-03"],
    ["what is the schedule next weekend?", "next weekend", "2026-05-09", "2026-05-10"],
    ["give us the Q schedule for next week at all AOs", "next week", "2026-05-04", "2026-05-10"],
    ["show open q slots next week", "next week", "2026-05-04", "2026-05-10"],
  ];

  for (const [text, label, start, end] of regionScheduleCases) {
    const intent = classifyReportRequest(text, db, {});
    assert.equal(intent?.type, "scheduled_workouts_by_region", text);
    assert.equal(intent.range.label, label, text);
    assert.equal(intent.range.start, start, text);
    assert.equal(intent.range.end, end, text);
  }

  const regionScheduleReport = runReport(db, regionSchedule, {});
  assert.equal(regionScheduleReport.source, "reporting_db_region");
  assert.match(regionScheduleReport.text, /F3 Wichita Schedule — next week/);
  assert.match(regionScheduleReport.text, /Wild West: Monday Beatdown; Q: Hammer Pants/);
  assert.match(regionScheduleReport.text, /Flyover: Wednesday Flight/);
  assert.doesNotMatch(regionScheduleReport.text, /Showing 30 of/);

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

  const regionScheduleAoFilterFollowup = classifyReportRequest("Show me just for Flyover", db, {
    threadMessages: [
      { text: "Can you show me the next 14 days?" },
      {
        text:
          "📅 *F3 Wichita Schedule — next 14 days*\n\n" +
          "• *2026-05-04* 5:30 AM-6:30 AM — Wild West: Q: Grease Monkey\n" +
          "• *2026-05-06* 5:30 AM-6:30 AM — Flyover: Q: not marked in the F3 Nation calendar",
      },
    ],
  });
  assert.equal(regionScheduleAoFilterFollowup?.type, "scheduled_q_by_ao");
  assert.equal(regionScheduleAoFilterFollowup.ao, "Flyover");
  assert.equal(regionScheduleAoFilterFollowup.range.label, "next 14 days");

  const regionScheduleFollowupContext = {
    threadMessages: [
      { text: "Can you show me the next 14 days?" },
      {
        text:
          "📅 *F3 Wichita Schedule — next 14 days*\n\n" +
          "• *2026-05-04* 5:30 AM-6:30 AM — Wild West: Q: Grease Monkey\n" +
          "• *2026-05-06* 5:30 AM-6:30 AM — Flyover: Q: not marked in the F3 Nation calendar\n" +
          "• *2026-05-06* 5:00 AM-6:00 AM — Depot: Q: not marked in the F3 Nation calendar",
      },
    ],
  };
  const regionScheduleRangeFilterFollowups = [
    ["just Saturday", "scheduled_workouts_by_region", "", "saturday"],
    ["only this weekend", "scheduled_workouts_by_region", "", "this weekend"],
    ["what about Flyover", "scheduled_q_by_ao", "Flyover", "next 14 days"],
    ["how about depot", "scheduled_q_by_ao", "Depot", "next 14 days"],
  ];

  for (const [text, type, ao, label] of regionScheduleRangeFilterFollowups) {
    const intent = classifyReportRequest(text, db, regionScheduleFollowupContext);
    assert.equal(intent?.type, type, text);
    if (ao) assert.equal(intent.ao, ao, text);
    assert.equal(intent.range.label, label, text);
  }

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
