const fs = require("fs");
const path = require("path");

const DEFAULT_STATUS_PATH = path.join(process.cwd(), "tmp", "f3po-status.json");
const DEFAULT_MAX_AGE_SECONDS = 180;

function statusPath() {
  return process.env.F3PO_STATUS_PATH || DEFAULT_STATUS_PATH;
}

function maxAgeSeconds() {
  const parsed = Number.parseInt(process.env.F3PO_HEALTH_MAX_AGE_SECONDS || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_AGE_SECONDS;
}

function redact(value = "") {
  if (!value) return "";
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function readStatus(filePath = statusPath()) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function writeStatus(status, filePath = statusPath()) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function statusAgeSeconds(status, now = Date.now()) {
  const updatedAt = Date.parse(status?.updated_at || "");
  if (!Number.isFinite(updatedAt)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.round((now - updatedAt) / 1000));
}

function validateStatus(status, options = {}) {
  const maxAge = options.maxAgeSeconds || maxAgeSeconds();
  const checks = [];
  const pid = status?.process?.pid;

  const age = statusAgeSeconds(status);
  checks.push({
    name: "heartbeat_fresh",
    ok: age <= maxAge,
    detail: Number.isFinite(age) ? `${age}s old` : "missing/invalid updated_at",
  });

  checks.push({
    name: "process_pid_present",
    ok: pid > 0,
    detail: pid ? `pid ${pid}` : "missing pid",
  });

  if (pid > 0) {
    try {
      process.kill(pid, 0);
      checks.push({ name: "process_alive", ok: true, detail: `pid ${pid}` });
    } catch (err) {
      checks.push({ name: "process_alive", ok: false, detail: err.message || String(err) });
    }
  }

  checks.push({
    name: "slack_started",
    ok: status?.slack?.started === true,
    detail: status?.slack?.started ? "started" : "not started",
  });

  checks.push({
    name: "no_recent_fatal_error",
    ok: !status?.last_fatal_error_at,
    detail: status?.last_fatal_error_at || "none",
  });

  return checks;
}

module.exports = {
  DEFAULT_MAX_AGE_SECONDS,
  maxAgeSeconds,
  readStatus,
  redact,
  statusAgeSeconds,
  statusPath,
  validateStatus,
  writeStatus,
};
