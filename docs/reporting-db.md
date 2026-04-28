# Local Reporting Database

F3PO can sync Wichita region event and attendance data from BigQuery into a local SQLite database. This keeps Slack reporting off live BigQuery and gives us one controlled place to enforce privacy rules before exposing reports.

The local database is ignored by Git:

```text
export/google/f3po-reporting.sqlite
```

## Privacy Position

The reporting database is for approved reports, not arbitrary SQL from Slack.

Allowed starting point:

- aggregate FNG counts
- aggregate workout counts by month/AO
- aggregate Q counts
- historical non-current trends

Blocked by bot policy before Slack exposure:

- recent individual location or attendance tracking
- “where did Person X work out last week?”
- “was Person X at AO Y yesterday?”
- raw COT or prayer content

## Sync Commands

Initial full backfill:

```sh
npm run reporting:sync:full
```

Daily/incremental sync:

```sh
npm run reporting:sync
```

Dry run:

```sh
npm run reporting:sync:dry-run
```

Status:

```sh
npm run reporting:status
```

Health check:

```sh
npm run reporting:health
```

Override the rolling lookback:

```sh
npm run reporting:sync -- --days 7
```

The sync uses `analytics.event_info.updated` and `analytics.attendance_info.updated`. It records the last successful sync in SQLite and subtracts `REPORTING_SYNC_DAYS` as an overlap window, so late updates are picked up.

Wichita is selected with region org ID `36533`:

```sh
REPORTING_REGION_ORG_ID=36533
```

The event sync filters `analytics.event_info.region_org_id` directly. The attendance sync joins attendance rows back to `analytics.event_info` and only imports attendance for Wichita events.

Keep the local sync audit log for 90 days by default:

```sh
REPORTING_SYNC_LOG_RETENTION_DAYS=90
```

Override it for one run:

```sh
npm run reporting:sync -- --log-retention-days 180
```

The reporting health check fails when the local DB is empty, the last sync run failed, or the last successful sync is older than `REPORTING_HEALTH_MAX_AGE_HOURS`:

```sh
REPORTING_HEALTH_MAX_AGE_HOURS=36
```

## Tables

SQLite tables:

- `events`
- `attendance`
- `sync_state`
- `sync_runs`
- `sync_record_log`

The imported attendance table contains PAX-level data. Do not expose this table directly to Slack. Build approved reports on top of it.

`sync_runs` stores one row per successful or failed sync attempt, including the mode, cutoff, fetched counts, added counts, updated counts, and any error text.

`sync_record_log` stores the records touched by a sync run. It logs whether each event or attendance row was added or updated, plus a small JSON detail snapshot to make review easier. This table is local operational history, not bot-facing data.

The sync automatically prunes `sync_runs` and `sync_record_log` rows older than `REPORTING_SYNC_LOG_RETENTION_DAYS`. The SQLite database lives under `export/google/`, which is ignored by Git.

## Approved Aggregate Reports

Manual approved reports are available through `npm run reporting:query`. This is intentionally not an arbitrary SQL interface.

Examples:

```sh
npm run reporting:query -- fngs-by-month --days 365
npm run reporting:query -- workouts-by-month --days 365
npm run reporting:query -- workouts-by-ao --days 365
npm run reporting:query -- avg-attendance-by-ao --ao Flyover --days 365
npm run reporting:query -- attendance-by-ao-day --day saturday --days 365
```

These report types are aggregate AO/workout statistics. They do not expose recent individual attendance, person-location patterns, or raw COT/backblast text.

## Terminal Reporting Tester

Use the terminal tester on the RHEL server when you want to check whether a Slack-style question will hit F3PO’s deterministic reporting/F3 Nation API path before the model fallback.

This is deliberately narrow. If it says `No reporting reply`, that means the deterministic reporting/API path did not answer and the real Slack bot would continue to the normal model/vector-store path.

For a broader terminal test that includes that fallback, use:

```sh
npm run bot:ask -- "what can you do?"
npm run bot:ask -- --interactive
```

Install or update from the repo:

```sh
cd /mnt/nas/node/f3po-slack-bot
git pull
npm install
```

Make sure `.env` has the reporting DB and F3 Nation API settings:

```sh
REPORTING_DB_PATH=export/google/f3po-reporting.sqlite
F3_NATION_API_KEY=
F3_NATION_API_CLIENT=f3po-slack-bot
F3_NATION_REGION_ORG_ID=36533
```

Run a direct prompt:

```sh
npm run reporting:ask -- "ww q saturday"
npm run reporting:ask -- "who qs flyover wed"
npm run reporting:ask -- "show me wild west q schedule next week"
```

For the fastest follow-up testing, use interactive mode. It keeps a fake Slack thread in memory, appending each prompt and F3PO response so context-dependent follow-ups can resolve naturally:

```sh
npm run reporting:ask -- --interactive
```

Example interactive session:

```text
You> ww q saturday

F3PO>
[f3nation_api]
📅 *Wild West Q Schedule — saturday*

• *2026-05-02* 6:30 AM-7:30 AM — Wild West: Q: Hammer Pants (F3 Wichita)

You> rest of the month?

F3PO>
[f3nation_api]
📅 *Wild West Q Schedule — rest of the month*
...
```

Interactive commands:

```text
/thread   show the fake thread context currently in memory
/clear    clear the fake thread
/exit     quit
```

Successful reporting-path output starts with the answer source:

```text
[f3nation_api]
📅 *Wild West Q Schedule — saturday*

• *2026-05-02* 6:30 AM-7:30 AM — Wild West: Q: Hammer Pants (F3 Wichita)
```

If the script prints this, the prompt did not match an approved reporting handler and would likely fall through to the general model path in Slack:

```text
No reporting reply. This prompt would likely fall through to the model path.
```

Use JSON mode when debugging source/routing:

```sh
npm run reporting:ask -- --json "who qs flyover wed"
```

You can also test follow-up context from a saved text file. Put prior thread messages in a text file separated by blank lines:

```sh
cat >/tmp/f3po-thread.txt <<'EOF'
who is q on sat at ww?

📅 *Wild West Q Schedule — sat*

• *2026-05-02* 6:30 AM-7:30 AM — Wild West: Q: Hammer Pants
EOF

npm run reporting:ask -- --thread /tmp/f3po-thread.txt "rest of the month?"
npm run reporting:ask -- --thread /tmp/f3po-thread.txt "what about next week?"
```

You can also pipe a prompt from stdin:

```sh
printf '%s\n' "who has the q at wild west this saturday" | npm run reporting:ask -- --stdin
```

Regression checks for common Slack shorthand live in `scripts/check-reporting-intents.js` and run as part of:

```sh
npm test
```

## Slack Reporting

The bot checks messages for approved reporting requests before using vector search or web search.

Currently supported Slack report shapes:

- average attendance for a named AO, such as “How many PAX on average attend Flyover?”
- highest recorded attendance for a named AO, such as “What was the highest attendance ever at Wild West?”
- attendance by AO for a weekday, such as “Show attendance for all AOs that meet Saturday over the last year”
- Q schedule lookups for a named AO when the local DB has event/Q rows, such as “Who is scheduled to Q for Wild West this week?”
- a PAX’s own recent attendance, such as “Show me the last 5 workouts I was at”
- FNGs by month
- workouts by month
- workouts by AO

The Slack path uses the same local SQLite database and predefined SQL templates. It does not let the model write SQL.

For upcoming Q assignments, the bot can optionally query the live F3 Nation API calendar endpoint before falling back to the local reporting DB. Configure:

```sh
F3_NATION_API_KEY=
F3_NATION_API_CLIENT=f3po-slack-bot
F3_NATION_REGION_ORG_ID=36533
```

Create a read-only API key at <https://map.f3nation.com/admin/api-keys>. The API requires both `Authorization: Bearer ...` and a `Client` header. The bot uses `GET /v1/event-instance` plus planned attendance from `GET /v1/attendance/event-instance/{eventInstanceId}` for upcoming schedule/Q questions and caches responses briefly with `F3_NATION_API_CACHE_TTL_MS`.

If the live API is not configured or does not have a matching future event/Q assignment, and the local reporting DB also does not have future Q rows, the bot should not offer to draft Slack messages, inspect signup threads, or invent Slack channel suggestions. It should briefly say it cannot confirm the scheduled Q from the available data.

For self-attendance, the bot uses a conservative fuzzy match between the Slack display name and `attendance.f3_name`. If the match is not high-confidence or is ambiguous, it refuses instead of guessing.

The bot blocks obvious recent person-attendance/location requests, such as:

- “Where did Chubbs work out last week?”
- “Was Person X at AO Y yesterday?”
- “Who attended AO X this morning?”

Blocked response:

```text
I can’t report recent individual attendance or location patterns. I can help with aggregate AO activity, FNG counts, Q counts, or longer-range non-current trends.
```

For reporting/stat questions that are not yet wired into F3PO’s approved report templates, the bot points users to PAX Vault:

```text
I don’t have that report type wired in yet. You may want to check PAX Vault: https://pax-vault.f3nation.com/
```

Inspect recent sync runs:

```sh
sqlite3 export/google/f3po-reporting.sqlite \
  "SELECT id, started_at, status, mode, fetched_events, added_events, updated_events, fetched_attendance, added_attendance, updated_attendance FROM sync_runs ORDER BY id DESC LIMIT 10;"
```

Inspect add/update counts for the latest run:

```sh
sqlite3 export/google/f3po-reporting.sqlite \
  "SELECT table_name, action, COUNT(*) FROM sync_record_log WHERE run_id = (SELECT MAX(id) FROM sync_runs) GROUP BY table_name, action ORDER BY table_name, action;"
```

## RHEL 3 AM Timer

Install the daily sync timer on the RHEL server:

```sh
cd /mnt/nas/node/f3po-slack-bot
./scripts/install-reporting-sync-timer.sh
```

The timer installer is safe to rerun after a move or config change; it rewrites the service/timer units and reloads systemd.

The timer runs:

```sh
./scripts/run-reporting-sync-with-healthchecks.sh
```

every day at 3 AM.

The wrapper runs `npm run reporting:sync`, then `npm run reporting:health`.

## Healthchecks.io

To monitor the daily reporting sync, create a Healthchecks.io check and put its full ping URL in `.env` on the server:

```sh
HEALTHCHECKS_REPORTING_SYNC_URL=https://hc-ping.com/your-uuid
```

Healthchecks.io ping URLs are secrets. Do not commit this value.

The sync wrapper sends:

- `/start` before the sync begins
- the base URL after sync and health check success
- `/fail` if sync or health check fails

Healthchecks.io documents `/start`, base success pings, and `/fail` failure pings in its Pinging API docs: <https://healthchecks.io/docs/http_api/>.

After setting or changing `HEALTHCHECKS_REPORTING_SYNC_URL`, reinstall the timer so systemd uses the wrapper:

```sh
./scripts/install-reporting-sync-timer.sh
```

The installer runs the service as the current user by default, or `SUDO_USER` when launched through `sudo`. Override that user if needed:

```sh
F3PO_SERVICE_USER=mpotter ./scripts/install-reporting-sync-timer.sh
```

Use the same user that ran `gcloud auth application-default login`, because the sync reads that user's Google Application Default Credentials.

Manual run:

```sh
sudo systemctl start f3po-reporting-sync.service
```

Status/logs:

```sh
systemctl list-timers f3po-reporting-sync.timer --no-pager
sudo journalctl -u f3po-reporting-sync.service -n 100 --no-pager
```
