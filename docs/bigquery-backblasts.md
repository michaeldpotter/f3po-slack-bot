# BigQuery Backblast Export

The preferred backblast source is BigQuery. It pulls current event records directly and avoids obsolete Slack log channels.

The exporter reads `analytics.event_info`, transforms the `backblast` field into markdown, and redacts from `COT:`, `Circle of Trust:`, prayer, praise, or intention headings onward before anything is ingested.

`export/google/` is reserved for ignored Google or BigQuery scratch exports. The normal BigQuery exporter does not need a raw local export file; it queries BigQuery directly and writes the reviewed output listed below.

## Requirements

- `@google-cloud/bigquery`, installed by `npm install`
- Google Cloud CLI, which provides `gcloud`
- A Google account with permission to query the F3 data project

## RHEL Google Cloud CLI Setup

On the RHEL server, run the helper script from the repo:

```sh
cd /mnt/nas/node/f3po-slack-bot
./scripts/setup-rhel-gcloud.sh
```

The script:

1. Adds the Google Cloud CLI yum repository for RHEL 10, or the RHEL 9-compatible repo on older compatible systems.
2. Installs `libxcrypt-compat.x86_64` and `google-cloud-cli`.
3. Verifies `gcloud` and `bq`.
4. Optionally runs interactive Application Default Credentials auth.
5. Sets the project to `f3data`.
6. Optionally runs `npm run backblasts:bigquery:dry-run`.

To use a different project or repo path:

```sh
GOOGLE_CLOUD_PROJECT=f3data F3PO_REPO_DIR=/mnt/nas/node/f3po-slack-bot ./scripts/setup-rhel-gcloud.sh
```

After setup, the important commands are:

```sh
gcloud auth application-default login
gcloud config set project f3data
cd /mnt/nas/node/f3po-slack-bot
npm run backblasts:bigquery:dry-run
```

If the server cannot open a browser, follow the URL/device-code flow printed by `gcloud`.

## macOS Google Cloud CLI Setup

On macOS with Homebrew:

```sh
brew install --cask google-cloud-sdk
```

Restart your terminal, then verify:

```sh
gcloud --version
```

Authenticate Application Default Credentials:

```sh
gcloud auth application-default login
```

Use the F3 data project:

```sh
gcloud config set project f3data
```

If project detection fails, set this in `.env`:

```sh
GOOGLE_CLOUD_PROJECT=f3data
```

## Query Shape

```sql
SELECT
    id,
    start_date,
    region_org_id,
    backblast
FROM `analytics.event_info`
WHERE region_org_id = 36533
  AND start_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY)
ORDER BY start_date ASC;
```

## Run

Preview:

```sh
npm run backblasts:bigquery:dry-run
```

Export:

```sh
npm run backblasts:bigquery
```

Optional filters:

```sh
npm run backblasts:bigquery -- --days 30
npm run backblasts:bigquery -- --since 2026-01-01
npm run backblasts:bigquery:dry-run -- --project f3data
```

The script writes:

```text
vectorstore/F3 Wichita Documents/f3wichita-backblasts.md
export/google/bigquery-backblast-export-review.json
```

Review the generated markdown before ingestion, then run:

```sh
npm run rag:add
```
