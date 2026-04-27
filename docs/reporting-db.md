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

Override the rolling lookback:

```sh
npm run reporting:sync -- --days 7
```

The sync uses `analytics.event_info.updated` and `analytics.attendance_info.updated`. It records the last successful sync in SQLite and subtracts `REPORTING_SYNC_DAYS` as an overlap window, so late updates are picked up.

Keep the local sync audit log for 90 days by default:

```sh
REPORTING_SYNC_LOG_RETENTION_DAYS=90
```

Override it for one run:

```sh
npm run reporting:sync -- --log-retention-days 180
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
npm run reporting:sync
```

every day at 3 AM.

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
