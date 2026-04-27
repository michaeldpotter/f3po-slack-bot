// Export F3 Wichita YouTube channel metadata/captions and rebuild the searchable
// vectorstore/F3 Wichita Documents/f3wichita-youtube.md index.
//
// Usage:
//   node scripts/export-youtube.js
//   node scripts/export-youtube.js --channel https://www.youtube.com/@f3wichita/videos
//   node scripts/export-youtube.js --skip-fetch

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_CHANNEL_URL = "https://www.youtube.com/@f3wichita/videos";
const EXPORT_DIR = path.join(REPO_ROOT, "export", "youtube");
const OUTPUT_DOC = path.join(
  REPO_ROOT,
  "vectorstore",
  "F3 Wichita Documents",
  "f3wichita-youtube.md"
);
const CHANNEL_DISPLAY_URL = "https://www.youtube.com/@f3wichita";
const ONE_MILE_OUT_VIDEO_ID = "xYi31rUVF4M";

function parseArgs(argv) {
  const args = argv.slice(2);
  const channelIndex = args.indexOf("--channel");

  return {
    channelUrl: channelIndex >= 0 ? args[channelIndex + 1] : DEFAULT_CHANNEL_URL,
    skipFetch: args.includes("--skip-fetch"),
  };
}

function ensureYtDlp() {
  try {
    execFileSync("yt-dlp", ["--version"], { stdio: "ignore" });
  } catch (err) {
    throw new Error(
      "yt-dlp is required but was not found. Install it, then rerun npm run youtube:export."
    );
  }
}

function runYtDlp(channelUrl) {
  fs.mkdirSync(EXPORT_DIR, { recursive: true });

  execFileSync(
    "yt-dlp",
    [
      "--write-info-json",
      "--write-auto-subs",
      "--sub-lang",
      "en",
      "--sub-format",
      "vtt",
      "--skip-download",
      "--ignore-errors",
      "--no-overwrites",
      "--output",
      path.join(EXPORT_DIR, "%(upload_date)s-%(id)s-%(title).80s.%(ext)s"),
      channelUrl,
    ],
    { stdio: "inherit" }
  );
}

function walkDir(dir) {
  const entries = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : [];
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkDir(fullPath));
    else files.push(fullPath);
  }

  return files;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function findCaptionText(infoPath, videoId) {
  const dir = path.dirname(infoPath);
  const base = path.basename(infoPath).replace(/\.info\.json$/, "");
  const candidates = walkDir(dir).filter((filePath) => {
    const name = path.basename(filePath);
    return (
      filePath.endsWith(".vtt") &&
      (name.startsWith(base) || name.includes(videoId))
    );
  });

  if (candidates.length === 0) return "";
  return cleanVtt(fs.readFileSync(candidates[0], "utf8"));
}

function cleanVtt(vtt) {
  const seen = new Set();
  const lines = vtt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("WEBVTT"))
    .filter((line) => !line.startsWith("Kind:"))
    .filter((line) => !line.startsWith("Language:"))
    .filter((line) => !/^\d+$/.test(line))
    .filter((line) => !line.includes("-->"))
    .map((line) =>
      line
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter(Boolean)
    .filter((line) => {
      const key = line.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  return lines.join(" ");
}

function formatDate(uploadDate) {
  if (!/^\d{8}$/.test(uploadDate || "")) return "Unknown";
  return `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}`;
}

function normalizeUrl(info) {
  if (info.webpage_url) return info.webpage_url;
  if (info.id) return `https://youtu.be/${info.id}`;
  return "TBD";
}

function inferTopics(info, captionText) {
  const text = `${info.title || ""} ${info.description || ""} ${captionText || ""}`.toLowerCase();
  const topics = new Set(["F3 Wichita videos"]);

  const checks = [
    ["1-Mile Out", ["1-mile", "1 mile", "mile out"]],
    ["Rucking", ["ruck", "rucking", "rucker"]],
    ["Family-friendly events", ["family", "kids", "commons"]],
    ["Workout", ["workout", "beatdown", "boot camp", "bootcamp"]],
    ["Event recap", ["recap", "event"]],
    ["Leadership", ["leadership", "q source", "qsource"]],
    ["FNGs", ["fng"]],
  ];

  for (const [topic, needles] of checks) {
    if (needles.some((needle) => text.includes(needle))) topics.add(topic);
  }

  return Array.from(topics);
}

function trimText(text = "", max = 900) {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max).replace(/\s+\S*$/, "")}...`;
}

function markdownList(items) {
  return items.map((item) => `- ${item}`).join("\n");
}

function videoEntry(info, captionText) {
  const title = info.title || `YouTube Video ${info.id || ""}`.trim();
  const topics = inferTopics(info, captionText);
  const description = trimText(info.description || "", 800);
  const transcript = trimText(captionText || "", 1200);

  if (info.id === ONE_MILE_OUT_VIDEO_ID) {
    return `### 1-Mile Out Event Recap

Video URL: ${normalizeUrl(info)}

Upload date: ${formatDate(info.upload_date)}

Related event: 1-Mile Out

Topics:

${markdownList([
  "F3 Wichita events",
  "Rucking",
  "Family-friendly events",
  "1-mile loop challenge",
  "Loaded endurance",
  "PAX encouragement",
  "Event recap",
])}

Summary:

This video is a previous 1-Mile Out event video. Use it when someone asks what 1-Mile Out looks like, wants an example of the event, or asks for a video related to F3 Wichita rucking events.

The 1-Mile Out event is F3 Wichita's family-friendly ultimate rucker event. PAX attempt a 1-mile loop every 15 minutes, increasing weight at scheduled breaks and continuing until failure. As participants drop out, they join family and friends for food, fellowship, and cheering on the PAX still grinding.

${description ? `YouTube description excerpt:\n\n${description}\n\n` : ""}${transcript ? `Transcript excerpt:\n\n${transcript}\n\n` : ""}Bot guidance:

- If someone asks for a video about 1-Mile Out, provide this link.
- If someone asks what the event is, summarize the event from the F3 Wichita Events document and include this video as an example.
- If someone asks whether the video is current for a specific year, say this is a previous event video and the annual event details should be confirmed separately.`;
  }

  return `### ${title}

Video URL: ${normalizeUrl(info)}

Upload date: ${formatDate(info.upload_date)}

Related event, AO, or topic: TBD

Topics:

${markdownList(topics)}

Summary:

${description || "No YouTube description was exported for this video. Add a human-written summary here when available."}

${transcript ? `Transcript excerpt:\n\n${transcript}\n\n` : ""}Bot guidance:

- Use this video when someone asks about "${title}" or related F3 Wichita video content.
- If the user needs current event details, confirm dates, times, locations, and registration details separately.`;
}

function loadVideos() {
  const infoFiles = walkDir(EXPORT_DIR)
    .filter((filePath) => filePath.endsWith(".info.json"))
    .sort();

  return infoFiles
    .map((infoPath) => {
      const info = readJson(infoPath);
      return {
        info,
        captionText: findCaptionText(infoPath, info.id),
      };
    })
    .filter(({ info }) => info && info.id && info._type !== "playlist" && normalizeUrl(info).includes("watch"));
}

function buildMarkdown(videos) {
  const videoEntries = videos.map(({ info, captionText }) => videoEntry(info, captionText));

  return `# F3 Wichita YouTube

**Region:** Wichita  
**Purpose:** Searchable reference for F3 Wichita YouTube channel links, videos, summaries, and guidance on when the bot should point PAX to video resources.

---

## Channel

F3 Wichita YouTube Channel: ${CHANNEL_DISPLAY_URL}

Use this document when someone asks about F3 Wichita videos, event recap videos, video walkthroughs, or where to watch examples of F3 Wichita events and activities.

When answering from this document:

- Prefer a direct video link when a matching video is listed.
- Briefly summarize what the video covers.
- Do not claim the bot watched a video unless a summary or transcript is included in this document.
- If a requested video or topic is not listed here, say the local YouTube index does not currently include it.
- Treat upload dates as historical video metadata, not necessarily current event dates.

---

## Videos

${videoEntries.length > 0 ? videoEntries.join("\n\n---\n\n") : "No videos have been exported yet."}

---

## Videos To Add

Use this section as a holding area for future videos before they are fully summarized.

For each video, add:

- Title
- Video URL
- Related event, AO, or topic
- Short summary
- Important terms PAX might search for
- Any caution about outdated dates, locations, or details

### Template

Title: TBD

Video URL: TBD

Related event, AO, or topic: TBD

Topics:

- TBD

Summary:

TBD

Bot guidance:

- TBD
`;
}

function main() {
  const { channelUrl, skipFetch } = parseArgs(process.argv);

  if (!skipFetch) {
    ensureYtDlp();
    runYtDlp(channelUrl);
  }

  const videos = loadVideos();
  fs.mkdirSync(path.dirname(OUTPUT_DOC), { recursive: true });
  fs.writeFileSync(OUTPUT_DOC, buildMarkdown(videos), "utf8");

  console.log(`Wrote ${OUTPUT_DOC}`);
  console.log(`Indexed ${videos.length} video(s).`);
  console.log("Next step: npm run rag:add");
}

main();
