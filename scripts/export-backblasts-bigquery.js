// Export recent F3 Wichita BigQuery backblasts into a redacted searchable markdown doc.
//
// Usage:
//   node scripts/export-backblasts-bigquery.js --dry-run
//   node scripts/export-backblasts-bigquery.js --days 90
//   node scripts/export-backblasts-bigquery.js --since 2026-01-01
//
// Auth:
//   Use normal Google Application Default Credentials, or set GOOGLE_APPLICATION_CREDENTIALS.

require("dotenv").config();

const fs = require("fs");
const path = require("path");

const DEFAULT_OUTPUT_DOC = path.join(
  "vectorstore",
  "F3 Wichita Documents",
  "f3wichita-backblasts.md"
);
const DEFAULT_REVIEW_PATH = path.join(
  "export",
  "google",
  "bigquery-backblast-export-review.json"
);
const DEFAULT_TABLE = "analytics.event_info";
const DEFAULT_REGION_ORG_ID = 36533;
const DEFAULT_DAYS = 90;

function loadBigQuery() {
  try {
    return require("@google-cloud/bigquery").BigQuery;
  } catch (err) {
    throw new Error(
      "Missing @google-cloud/bigquery. Run `npm install @google-cloud/bigquery` before exporting BigQuery backblasts."
    );
  }
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const valueAfter = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };

  const days = Number.parseInt(valueAfter("--days") || process.env.BIGQUERY_BACKBLAST_DAYS || DEFAULT_DAYS, 10);
  if (!Number.isInteger(days) || days < 1 || days > 3660) {
    throw new Error("--days must be an integer between 1 and 3660.");
  }

  return {
    dryRun: args.includes("--dry-run"),
    days,
    since: valueAfter("--since") || process.env.BIGQUERY_BACKBLAST_SINCE,
    output:
      valueAfter("--output") || process.env.BIGQUERY_BACKBLAST_OUTPUT || DEFAULT_OUTPUT_DOC,
    reviewPath:
      valueAfter("--review") || process.env.BIGQUERY_BACKBLAST_REVIEW_PATH || DEFAULT_REVIEW_PATH,
    table: valueAfter("--table") || process.env.BIGQUERY_BACKBLAST_TABLE || DEFAULT_TABLE,
    regionOrgId: Number.parseInt(
      valueAfter("--region-org-id") ||
        process.env.BIGQUERY_BACKBLAST_REGION_ORG_ID ||
        DEFAULT_REGION_ORG_ID,
      10
    ),
    projectId: valueAfter("--project") || process.env.GOOGLE_CLOUD_PROJECT,
  };
}

function validateDate(dateString, flagName) {
  if (!dateString) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString) || Number.isNaN(Date.parse(`${dateString}T00:00:00.000Z`))) {
    throw new Error(`${flagName} must be YYYY-MM-DD.`);
  }
  return dateString;
}

function tableIdentifier(table) {
  const cleaned = table.replace(/^`|`$/g, "");
  if (!/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+){1,2}$/.test(cleaned)) {
    throw new Error("BigQuery table must be dataset.table or project.dataset.table.");
  }
  return `\`${cleaned}\``;
}

function cleanText(text = "") {
  return String(text)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\uFFFD/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function redactSensitiveSections(backblast = "") {
  const text = cleanText(backblast);
  const boundary =
    /\b(cot|c\.o\.t\.?|circle of trust|prayer requests?|prayers?|praises?|intentions?)\s*:|\bprayers?\s+for\b|\b(opened|closed|ended)(\s+out)?\s+(with|in)\s+(a\s+)?(christian\s+)?prayer\b/i;
  const match = boundary.exec(text);

  if (!match) {
    return {
      text,
      redacted: false,
    };
  }

  return {
    text: `${text.slice(0, match.index).trim()}\n\nCOT: [redacted]`.trim(),
    redacted: true,
  };
}

function extractField(text, label) {
  const pattern = new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, "im");
  return text.match(pattern)?.[1]?.trim() || "";
}

function extractTitle(text) {
  const title = text.match(/^\s*Backblast!\s*(.+?)\s*$/im)?.[1]?.trim() || "";
  return title.replace(/[!:.]+$/, "").trim();
}

function safeHeadingPart(value, fallback) {
  const cleaned = cleanText(value).split("\n")[0]?.replace(/^#+\s*/, "").trim();
  return cleaned || fallback;
}

function normalizeRowDate(value) {
  if (!value) return "";
  if (typeof value === "string") return value.slice(0, 10);
  if (value.value) return String(value.value).slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function formatBackblast(row) {
  const redaction = redactSensitiveSections(row.backblast || "");
  const sourceText = redaction.text;
  const date = extractField(sourceText, "Date") || normalizeRowDate(row.start_date) || "unknown-date";
  const ao = extractField(sourceText, "AO") || "Unknown AO";
  const q = extractField(sourceText, "Q");
  const pax = extractField(sourceText, "PAX");
  const title = extractTitle(sourceText);
  const headingParts = [date, safeHeadingPart(ao, "Unknown AO"), title && safeHeadingPart(title, "")].filter(Boolean);

  return {
    markdown: `## ${headingParts.join(" - ")}

BigQuery id: ${row.id}
Date: ${date}
AO: ${ao}
${q ? `Q: ${q}\n` : ""}${pax ? `PAX: ${pax}\n` : ""}
Backblast:

${sourceText}
`,
    review: {
      id: row.id,
      date,
      ao,
      redacted: redaction.redacted,
      hasBackblast: Boolean(sourceText),
    },
  };
}

function buildMarkdown(entries) {
  return `# F3 Wichita Backblasts

**Region:** Wichita  
**Purpose:** Redacted searchable archive of F3 Wichita backblasts from BigQuery.

This document is generated from BigQuery event records. COT, prayer, praise, and other sensitive sections are redacted before ingestion.

---

${entries.length > 0 ? entries.join("\n---\n\n") : "No backblasts exported yet."}
`;
}

async function fetchBackblasts(args) {
  const BigQuery = loadBigQuery();
  const bigquery = new BigQuery(args.projectId ? { projectId: args.projectId } : undefined);
  const since = validateDate(args.since, "--since");
  const sincePredicate = since
    ? "start_date >= @sinceDate"
    : `start_date >= DATE_SUB(CURRENT_DATE(), INTERVAL ${args.days} DAY)`;

  const query = `
SELECT
    id,
    start_date,
    region_org_id,
    backblast
FROM ${tableIdentifier(args.table)}
WHERE region_org_id = @regionOrgId
  AND ${sincePredicate}
  AND backblast IS NOT NULL
  AND TRIM(backblast) != ''
ORDER BY start_date ASC, id ASC
`;

  const options = {
    query,
    params: {
      regionOrgId: args.regionOrgId,
      ...(since ? { sinceDate: since } : {}),
    },
  };

  const [rows] = await bigquery.query(options);
  return rows;
}

async function main() {
  const args = parseArgs(process.argv);
  const rows = await fetchBackblasts(args);
  const formatted = rows.map(formatBackblast);
  const entries = formatted.map((item) => item.markdown);
  const review = formatted.map((item) => item.review);

  if (args.dryRun) {
    console.log(`Dry run: ${entries.length} BigQuery backblast(s) would be exported.`);
    for (const item of review.slice(0, 20)) {
      console.log(`- ${JSON.stringify(item)}`);
    }
    return;
  }

  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, buildMarkdown(entries), "utf8");

  fs.mkdirSync(path.dirname(args.reviewPath), { recursive: true });
  fs.writeFileSync(args.reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");

  console.log(`Wrote ${args.output}`);
  console.log(`Wrote review log: ${args.reviewPath}`);
  console.log(`Exported ${entries.length} BigQuery backblast(s).`);
  console.log("Next step: review the markdown, then run npm run rag:add");
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
