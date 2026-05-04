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
  return `(${id}, 'AO ${index + 1}', ${50000 + index}, '2026-05-${day}', '${hour}30', '${hour}45', 'Extra Beatdown ${index + 1}', 'Bootcamp', 5, '[]', '[]')`;
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
  description TEXT,
  pax_count INTEGER,
  image_urls_json TEXT,
  file_ids_json TEXT
);
CREATE TABLE attendance (
  id INTEGER PRIMARY KEY,
  event_instance_id INTEGER,
  f3_name TEXT,
  q_ind INTEGER,
  coq_ind INTEGER
);
INSERT INTO events (id, ao_name, ao_org_id, start_date, start_time, end_time, name, description, pax_count, image_urls_json, file_ids_json) VALUES
  (1, 'Wild West', 43950, '2026-05-02', '0630', '0730', 'Saturday Beatdown', 'Murph with burpees and coupon carries', 12, '["https://example.com/wild-west.jpg"]', '["F1"]'),
  (2, 'Time Will Tell (TWT)', 12345, '2026-05-02', '0630', '0730', 'Saturday Beatdown', 'Bootcamp', 8, '[]', '[]'),
  (3, 'Flyover', 45713, '2026-05-02', '0530', '0615', 'Morning Flight', 'Bootcamp', 9, '["https://example.com/flyover.jpg"]', '["F3"]'),
  (4, 'Depot', 45209, '2026-05-02', '0700', '0800', 'Depot Beatdown', 'Bootcamp', 7, '["https://example.com/depot.jpg"]', '["F4"]'),
  (5, 'Wild West', 43950, '2026-05-04', '0530', '0615', 'Monday Beatdown', 'Murph with burpees and coupon carries', 10, '[]', '[]'),
  (6, 'Flyover', 45713, '2026-05-06', '0530', '0615', 'Wednesday Flight', 'Hill ruck challenge', 11, '[]', '[]'),
  (7, 'Depot', 45209, '2026-04-15', '0530', '0615', 'Midweek Bootcamp', 'Bootcamp', 6, '[]', '[]'),
  (8, 'Fortress', 22222, '2026-04-20', '0530', '0615', 'April Q Test', 'Bootcamp', 6, '[]', '[]'),
  ${manyEvents};
INSERT INTO attendance (id, event_instance_id, f3_name, q_ind, coq_ind) VALUES
  (1, 1, 'Chubbs', 0, 0),
  (2, 5, 'Hammer Pants', 1, 0),
  (3, 6, 'Dr Pepper Shake', 1, 0),
  (4, 1, 'Hammer Pants', 1, 0),
  (5, 4, 'Chubbs', 1, 0),
  (6, 6, 'Chubbs', 0, 1),
  (7, 7, 'Chubbs', 0, 0),
  (8, 4, 'Dr Pepper Shake', 0, 0),
  (9, 4, 'Mariachi', 0, 0),
  (10, 8, 'Big Tip', 1, 0);
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

const overallLeaderboard = classifyReportRequest("Who Q'ed the most in April", db, {});
assert.equal(overallLeaderboard?.type, "q_leaderboard_overall");
assert.equal(overallLeaderboard.range.label, "April 2026");
const overallLeaderboardReport = runReport(db, overallLeaderboard, {});
assert.equal(overallLeaderboardReport.source, "reporting_db");
assert.match(overallLeaderboardReport.text, /Q Leaderboard — April 2026/);

const overallLeaderboardNoApostrophe = classifyReportRequest("Who Qed the most in April", db, {});
assert.equal(overallLeaderboardNoApostrophe?.type, "q_leaderboard_overall");
assert.equal(overallLeaderboardNoApostrophe.range.label, "April 2026");

const postLeaderboard = classifyReportRequest("Who posted the most in April", db, {});
assert.equal(postLeaderboard?.type, "post_leaderboard_overall");
assert.equal(postLeaderboard.range.label, "April 2026");
const postLeaderboardReport = runReport(db, postLeaderboard, {});
assert.equal(postLeaderboardReport.source, "reporting_db");
assert.match(postLeaderboardReport.text, /Post Leaderboard — April 2026/);

const ruckLeaderboard = classifyReportRequest("Who was at the most rucks in May?", db, {});
assert.equal(ruckLeaderboard?.type, "post_leaderboard_overall");
assert.equal(ruckLeaderboard.workoutKind, "ruck");
assert.equal(ruckLeaderboard.range.label, "MAY 2026");
const ruckLeaderboardReport = runReport(db, ruckLeaderboard, {});
assert.equal(ruckLeaderboardReport.source, "reporting_db");
assert.match(ruckLeaderboardReport.text, /Ruck Leaderboard/);

const hardestBeatdowns = classifyReportRequest("Who has the hardest beatdowns ever?", db, {});
assert.equal(hardestBeatdowns?.type, "hardest_beatdowns_fun");
const hardestReport = runReport(db, hardestBeatdowns, {});
assert.equal(hardestReport.source, "reporting_db_fun");
assert.match(hardestReport.text, /Unofficial Misery Index/);
assert.match(hardestReport.text, /Hammer Pants/);

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

  const firstSelfQ = classifyReportRequest("show me the first beatdown I Qed", db, {
    requesterName: "Chubbs",
  });
  assert.equal(firstSelfQ?.type, "self_q_events");
  assert.equal(firstSelfQ.order, "asc");
  assert.equal(firstSelfQ.limit, 1);
  const firstSelfQReport = runReport(db, firstSelfQ, { requesterName: "Chubbs" });
  assert.equal(firstSelfQReport.source, "reporting_db_self");
  assert.match(firstSelfQReport.text, /Chubbs's First Q/);
  assert.match(firstSelfQReport.text, /Depot: Depot Beatdown/);

  const eventDetailFollowup = classifyReportRequest("Can you show me that beatdown?", db, {
    threadMessages: [{ text: firstSelfQReport.text }],
  });
  assert.equal(eventDetailFollowup?.type, "event_detail_followup");
  assert.equal(eventDetailFollowup.event.ao, "Depot");
  const eventDetailReport = runReport(db, eventDetailFollowup, {});
  assert.equal(eventDetailReport.source, "reporting_db_followup");
  assert.match(eventDetailReport.text, /Depot Beatdown/);
  assert.match(eventDetailReport.text, /Bootcamp/);

  const eventQFollowup = classifyReportRequest("Who was the Q?", db, {
    threadMessages: [{ text: firstSelfQReport.text }],
  });
  assert.equal(eventQFollowup?.type, "event_q_followup");
  assert.equal(eventQFollowup.event.ao, "Depot");
  const eventQReport = runReport(db, eventQFollowup, {});
  assert.equal(eventQReport.source, "reporting_db_followup");
  assert.match(eventQReport.text, /Event Q/);
  assert.match(eventQReport.text, /\*Q:\* Chubbs/);

  const eventRosterFollowup = classifyReportRequest("Who was there?", db, {
    threadMessages: [{ text: firstSelfQReport.text }],
  });
  assert.equal(eventRosterFollowup?.type, "event_roster_followup");
  assert.equal(eventRosterFollowup.event.ao, "Depot");
  const eventRosterReport = runReport(db, eventRosterFollowup, {});
  assert.equal(eventRosterReport.source, "reporting_db_followup");
  assert.match(eventRosterReport.text, /Event Roster/);
  assert.match(eventRosterReport.text, /Chubbs \(Q\)/);
  assert.match(eventRosterReport.text, /Dr Pepper Shake/);

  const eventRosterPronounFollowup = classifyReportRequest("Who was with him?", db, {
    threadMessages: [
      {
        text: "",
        reportingContext: {
          type: "pax_post_events",
          order: "asc",
          limit: 1,
          label: "First Post",
          event: {
            startDate: "2026-05-02",
            ao: "Depot",
            name: "Depot Beatdown",
          },
        },
      },
    ],
  });
  assert.equal(eventRosterPronounFollowup?.type, "event_roster_followup");
  assert.equal(eventRosterPronounFollowup.event.ao, "Depot");

  const selfQCount = classifyReportRequest("how many times have I Qed?", db, {
    requesterName: "Chubbs",
  });
  assert.equal(selfQCount?.type, "self_q_count");
  const selfQCountReport = runReport(db, selfQCount, { requesterName: "Chubbs" });
  assert.match(selfQCountReport.text, /Q: \*1\*/);
  assert.match(selfQCountReport.text, /Co-Q: \*1\*/);

  const selfFirstPost = classifyReportRequest("what was my first workout?", db, {
    requesterName: "Chubbs",
  });
  assert.equal(selfFirstPost?.type, "self_post_events");
  assert.equal(selfFirstPost.order, "asc");
  const selfFirstPostReport = runReport(db, selfFirstPost, { requesterName: "Chubbs" });

  const namedPaxSameFirstPost = classifyReportRequest("What about Hammer Pants?", db, {
    threadMessages: [{ text: selfFirstPostReport.text }],
  });
  assert.equal(namedPaxSameFirstPost?.type, "pax_post_events");
  assert.equal(namedPaxSameFirstPost.paxName, "Hammer Pants");
  assert.equal(namedPaxSameFirstPost.order, "asc");
  assert.equal(namedPaxSameFirstPost.label, "First Post");

  const namedPaxSameFirstPostFromState = classifyReportRequest("What about Hammer Pants?", db, {
    threadMessages: [
      {
        text: "",
        reportingContext: {
          type: "pax_post_events",
          order: "asc",
          limit: 1,
          label: "First Post",
          workoutKind: "",
        },
      },
    ],
  });
  assert.equal(namedPaxSameFirstPostFromState?.type, "pax_post_events");
  assert.equal(namedPaxSameFirstPostFromState.paxName, "Hammer Pants");
  assert.equal(namedPaxSameFirstPostFromState.order, "asc");

  const selfFirstBeatdown = classifyReportRequest("When was my first beatdown?", db, {
    requesterName: "Chubbs",
  });
  assert.equal(selfFirstBeatdown?.type, "self_post_events");
  assert.equal(selfFirstBeatdown.order, "asc");
  assert.equal(selfFirstBeatdown.limit, 1);

  const selfFirstBeatDown = classifyReportRequest("When was my first beat down?", db, {
    requesterName: "Chubbs",
  });
  assert.equal(selfFirstBeatDown?.type, "self_post_events");
  assert.equal(selfFirstBeatDown.order, "asc");
  assert.equal(selfFirstBeatDown.limit, 1);

  for (const text of ["When was my first boot camp?", "When was my first bootcamp?", "When was my first work out?"]) {
    const intent = classifyReportRequest(text, db, { requesterName: "Chubbs" });
    assert.equal(intent?.type, "self_post_events", text);
    assert.equal(intent.order, "asc", text);
    assert.equal(intent.limit, 1, text);
  }

  const selfFirstBc = classifyReportRequest("When was my first BC?", db, {
    requesterName: "Chubbs",
  });
  assert.equal(selfFirstBc?.type, "self_post_events");
  assert.equal(selfFirstBc.order, "asc");

  const selfFirstRuck = classifyReportRequest("When was my first ruck?", db, {
    requesterName: "Chubbs",
  });
  assert.equal(selfFirstRuck?.type, "self_post_events");
  assert.equal(selfFirstRuck.workoutKind, "ruck");
  const selfFirstRuckReport = runReport(db, selfFirstRuck, { requesterName: "Chubbs" });
  assert.match(selfFirstRuckReport.text, /First Ruck/);
  assert.match(selfFirstRuckReport.text, /2026-05-06/);
  assert.doesNotMatch(selfFirstRuckReport.text, /2026-05-02/);

  const selfFavoriteAo = classifyReportRequest("What is my favorite AO?", db, {
    requesterName: "Chubbs",
  });
  assert.equal(selfFavoriteAo?.type, "self_favorite_ao");
  const selfFavoriteAoReport = runReport(db, selfFavoriteAo, { requesterName: "Chubbs" });
  assert.equal(selfFavoriteAoReport.source, "reporting_db_self");
  assert.match(selfFavoriteAoReport.text, /Chubbs's Favorite AO/);
  assert.match(selfFavoriteAoReport.text, /Depot/);

  const favoriteAoFollowup = classifyReportRequest("What about Hammer Pants?", db, {
    threadMessages: [
      {
        text: selfFavoriteAoReport.text,
        reportingContext: {
          type: "pax_favorite_ao",
        },
      },
    ],
  });
  assert.equal(favoriteAoFollowup?.type, "pax_favorite_ao");
  assert.equal(favoriteAoFollowup.paxName, "Hammer Pants");
  const favoriteAoFollowupReport = runReport(db, favoriteAoFollowup, {});
  assert.equal(favoriteAoFollowupReport.source, "reporting_db_pax");
  assert.match(favoriteAoFollowupReport.text, /Hammer Pants's Favorite AO/);

  const selfFavoriteRuckingAo = classifyReportRequest("What is my favorite rucking ao?", db, {
    requesterName: "Chubbs",
  });
  assert.equal(selfFavoriteRuckingAo?.type, "self_favorite_ao");
  assert.equal(selfFavoriteRuckingAo.workoutKind, "ruck");
  const selfFavoriteRuckingAoReport = runReport(db, selfFavoriteRuckingAo, { requesterName: "Chubbs" });
  assert.equal(selfFavoriteRuckingAoReport.source, "reporting_db_self");
  assert.match(selfFavoriteRuckingAoReport.text, /Chubbs's Favorite Rucking AO/);
  assert.match(selfFavoriteRuckingAoReport.text, /Flyover/);

  const selfFirstBeatdownInYear = classifyReportRequest("When was my first beatdown in 2024?", db, {
    requesterName: "Chubbs",
  });
  assert.equal(selfFirstBeatdownInYear?.type, "self_post_events");
  assert.equal(selfFirstBeatdownInYear.range.label, "2024");
  assert.equal(selfFirstBeatdownInYear.range.start, "2024-01-01");
  assert.equal(selfFirstBeatdownInYear.range.end, "2024-12-31");

  const namedPaxFirstQ = classifyReportRequest("When was Hammer Pants first Q?", db, {});
  assert.equal(namedPaxFirstQ?.type, "pax_q_events");
  assert.equal(namedPaxFirstQ.paxName, "Hammer Pants");
  assert.equal(namedPaxFirstQ.order, "asc");
  const namedPaxFirstQReport = runReport(db, namedPaxFirstQ, {});
  assert.equal(namedPaxFirstQReport.source, "reporting_db_pax");
  assert.match(namedPaxFirstQReport.text, /Hammer Pants's First Q/);
  assert.match(namedPaxFirstQReport.text, /Wild West: Saturday Beatdown/);

const namedPaxQCount = classifyReportRequest("How many times has Hammer Pants Qed?", db, {});
assert.equal(namedPaxQCount?.type, "pax_q_count");

const namedPaxQHistory = classifyReportRequest("Show Hammer Pants Q history", db, {});
assert.equal(namedPaxQHistory?.type, "pax_q_events");
assert.equal(namedPaxQHistory.limit, 10);

const likelyReportingFallback = classifyReportRequest("How many beatdowns have Hammer Pants and Chubbs been to together?", db, {});
assert.equal(likelyReportingFallback?.type, "unsupported_reporting_stats");

const namedPaxFirstRuck = classifyReportRequest("when was chubbs first ruck?", db, {});
assert.equal(namedPaxFirstRuck?.type, "pax_post_events");
assert.equal(namedPaxFirstRuck.paxName, "Chubbs");
assert.equal(namedPaxFirstRuck.workoutKind, "ruck");
const namedPaxFirstRuckReport = runReport(db, namedPaxFirstRuck, {});
assert.equal(namedPaxFirstRuckReport.source, "reporting_db_pax");
assert.match(namedPaxFirstRuckReport.text, /Chubbs's First Ruck/);
assert.match(namedPaxFirstRuckReport.text, /2026-05-06/);

const namedPaxFirstBeatdown = classifyReportRequest("when was chubbs first beatdown?", db, {});
assert.equal(namedPaxFirstBeatdown?.type, "pax_post_events");
assert.equal(namedPaxFirstBeatdown.paxName, "Chubbs");
assert.equal(namedPaxFirstBeatdown.label, "First Post");

const namedPaxFirstBc = classifyReportRequest("when was chubbs first bc?", db, {});
assert.equal(namedPaxFirstBc?.type, "pax_post_events");
assert.equal(namedPaxFirstBc.paxName, "Chubbs");
assert.equal(namedPaxFirstBc.label, "First Post");

const namedPaxLastBeatdown = classifyReportRequest("when was chubbs last beatdown?", db, {});
assert.equal(namedPaxLastBeatdown?.type, "pax_post_events");
assert.equal(namedPaxLastBeatdown.paxName, "Chubbs");
assert.equal(namedPaxLastBeatdown.order, "desc");
assert.equal(namedPaxLastBeatdown.label, "Most Recent Post");
const namedPaxLastBeatdownReport = runReport(db, namedPaxLastBeatdown, {});
assert.equal(namedPaxLastBeatdownReport.source, "reporting_db_pax");
assert.match(namedPaxLastBeatdownReport.text, /2026-05-06/);

const namedPaxLastBd = classifyReportRequest("when was chubbs last BD?", db, {});
assert.equal(namedPaxLastBd?.type, "pax_post_events");
assert.equal(namedPaxLastBd.paxName, "Chubbs");
assert.equal(namedPaxLastBd.order, "desc");

const namedPaxLastRuck = classifyReportRequest("when was chubbs last ruck?", db, {});
assert.equal(namedPaxLastRuck?.type, "pax_post_events");
assert.equal(namedPaxLastRuck.workoutKind, "ruck");
const namedPaxLastRuckReport = runReport(db, namedPaxLastRuck, {});
assert.match(namedPaxLastRuckReport.text, /Chubbs's Most Recent Ruck/);
assert.match(namedPaxLastRuckReport.text, /2026-05-06/);

const namedPaxCountLastMonth = classifyReportRequest("how many times has chubbs been at a workout in the last month?", db, {});
assert.equal(namedPaxCountLastMonth?.type, "pax_post_count");
assert.equal(namedPaxCountLastMonth.range.label, "last month");
const namedPaxCountLastMonthReport = runReport(db, namedPaxCountLastMonth, {});
assert.match(namedPaxCountLastMonthReport.text, /Chubbs's Post Count — last month/);
assert.match(namedPaxCountLastMonthReport.text, /Posts: \*1\*/);

const namedPaxRuckCount = classifyReportRequest("how many rucks has chubbs done?", db, {});
assert.equal(namedPaxRuckCount?.type, "pax_post_count");
assert.equal(namedPaxRuckCount.workoutKind, "ruck");
const namedPaxRuckCountReport = runReport(db, namedPaxRuckCount, {});
assert.match(namedPaxRuckCountReport.text, /Chubbs's Ruck Count/);
assert.match(namedPaxRuckCountReport.text, /Rucks: \*1\*/);

const namedPaxAoSummary = classifyReportRequest("what AOs has chubbs posted at this year?", db, {});
assert.equal(namedPaxAoSummary?.type, "pax_post_aos");
assert.equal(namedPaxAoSummary.range.label, "this year");
const namedPaxAoSummaryReport = runReport(db, namedPaxAoSummary, {});
assert.match(namedPaxAoSummaryReport.text, /AOs Chubbs Has Posted — this year/);
assert.match(namedPaxAoSummaryReport.text, /Wild West/);

const namedPaxFavoriteAo = classifyReportRequest("What is Hammer Pants favorite AO?", db, {});
assert.equal(namedPaxFavoriteAo?.type, "pax_favorite_ao");
assert.equal(namedPaxFavoriteAo.paxName, "Hammer Pants");
const namedPaxFavoriteAoReport = runReport(db, namedPaxFavoriteAo, {});
assert.equal(namedPaxFavoriteAoReport.source, "reporting_db_pax");
assert.match(namedPaxFavoriteAoReport.text, /Hammer Pants's Favorite AO/);
assert.match(namedPaxFavoriteAoReport.text, /Wild West/);

const namedPaxLastFiveBlocked = classifyReportRequest("show me chubbs last 5 workouts", db, {});
assert.equal(namedPaxLastFiveBlocked?.type, "blocked_recent_person_attendance");

const qSourceDocsQuestion = classifyReportRequest("Did Mariachi ever take Q Source?", db, {});
assert.equal(qSourceDocsQuestion, null);

const regionSchedule = classifyReportRequest("Show me the schedule for next week", db, {});
  assert.equal(regionSchedule?.type, "scheduled_workouts_by_region");
  assert.equal(regionSchedule.range.label, "next week");
  assert.equal(regionSchedule.range.start, "2026-05-04");
  assert.equal(regionSchedule.range.end, "2026-05-10");

  const regionScheduleCases = [
    ["what workouts are on the calendar for the next 14 days?", "next 14 days", "2026-05-02", "2026-05-16"],
    ["show me all workouts tomorrow", "tomorrow", "2026-05-03", "2026-05-03"],
    ["show me all BDs tomorrow", "tomorrow", "2026-05-03", "2026-05-03"],
    ["show me all BCs tomorrow", "tomorrow", "2026-05-03", "2026-05-03"],
    ["show me all boot camps tomorrow", "tomorrow", "2026-05-03", "2026-05-03"],
    ["show me all bootcamps tomorrow", "tomorrow", "2026-05-03", "2026-05-03"],
    ["show me all rucks tomorrow", "tomorrow", "2026-05-03", "2026-05-03"],
    ["show me all hiking tomorrow", "tomorrow", "2026-05-03", "2026-05-03"],
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

  const ruckSchedule = classifyReportRequest("show me all rucks next week", db, {});
  assert.equal(ruckSchedule?.type, "scheduled_workouts_by_region");
  assert.equal(ruckSchedule.workoutKind, "ruck");
  const ruckScheduleReport = runReport(db, ruckSchedule, {});
  assert.match(ruckScheduleReport.text, /F3 Wichita Ruck Schedule — next week/);
  assert.match(ruckScheduleReport.text, /Flyover: Wednesday Flight/);
  assert.doesNotMatch(ruckScheduleReport.text, /Wild West: Monday Beatdown/);
  assert.doesNotMatch(regionScheduleReport.text, /Showing 30 of/);

  const boyBandByAo = classifyReportRequest("show me the boy band for Wild West last Saturday", db, {});
  assert.equal(boyBandByAo?.type, "boy_band_images");
  assert.equal(boyBandByAo.ao, "Wild West");
  assert.equal(boyBandByAo.range.start, "2026-05-02");
  const boyBandReport = runReport(db, boyBandByAo, {});
  assert.equal(boyBandReport.source, "reporting_db_images");
  assert.match(boyBandReport.text, /https:\/\/example.com\/wild-west.jpg/);
  assert.match(boyBandReport.text, /Hammer Pants/);

  const boyBandByPax = classifyReportRequest("show every picture of Hammer Pants", db, {});
  assert.equal(boyBandByPax?.type, "boy_band_images");
  assert.equal(boyBandByPax.pax, "Hammer Pants");
  assert.equal(boyBandByPax.limit, 5);
  assert.equal(boyBandByPax.broad, true);

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
