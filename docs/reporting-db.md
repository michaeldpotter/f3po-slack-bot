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

## Tables

SQLite tables:

- `events`
- `attendance`
- `sync_state`

The imported attendance table contains PAX-level data. Do not expose this table directly to Slack. Build approved reports on top of it.

## RHEL 3 AM Timer

Install the daily sync timer on the RHEL server:

```sh
cd /mnt/nas/node/f3po-slack-bot
./scripts/install-reporting-sync-timer.sh
```

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
