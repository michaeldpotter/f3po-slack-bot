const DEFAULT_BASE_URL = "https://api.f3nation.com";
const DEFAULT_CLIENT = "f3po-slack-bot";
const DEFAULT_TIMEOUT_MS = 8000;
const cache = new Map();

function configFromEnv() {
  return {
    apiKey: process.env.F3_NATION_API_KEY || "",
    baseUrl: process.env.F3_NATION_API_BASE_URL || DEFAULT_BASE_URL,
    client: process.env.F3_NATION_API_CLIENT || DEFAULT_CLIENT,
    regionOrgId:
      process.env.F3_NATION_REGION_ORG_ID || process.env.REPORTING_REGION_ORG_ID || "",
    cacheTtlMs: Number.parseInt(process.env.F3_NATION_API_CACHE_TTL_MS || "300000", 10),
    timeoutMs: Number.parseInt(process.env.F3_NATION_API_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10),
  };
}

function isConfigured(config = configFromEnv()) {
  return Boolean(config.apiKey && config.regionOrgId);
}

function appendQuery(url, key, value) {
  if (value === undefined || value === null || value === "") return;
  if (Array.isArray(value)) {
    for (const item of value) appendQuery(url, key, item);
    return;
  }
  url.searchParams.append(key, String(value));
}

function cacheKeyFor(pathname, query) {
  return `${pathname}:${JSON.stringify(query)}`;
}

function readCache(key, ttlMs) {
  const cached = cache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.createdAt > ttlMs) {
    cache.delete(key);
    return null;
  }
  return cached.value;
}

function writeCache(key, value) {
  cache.set(key, { createdAt: Date.now(), value });
}

async function fetchJson(pathname, query = {}, config = configFromEnv()) {
  const url = new URL(pathname, config.baseUrl);
  for (const [key, value] of Object.entries(query)) appendQuery(url, key, value);

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS
  );

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Client: config.client || DEFAULT_CLIENT,
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`F3 Nation API ${response.status}: ${body.slice(0, 300)}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function firstValue(record, keys) {
  for (const key of keys) {
    const value = record?.[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
}

function normalizeDate(value) {
  if (!value) return "";
  if (typeof value === "string") return value.slice(0, 10);
  if (value.value) return String(value.value).slice(0, 10);
  return String(value).slice(0, 10);
}

function normalizeQNames(record, coq = false) {
  const candidateKeys = coq
    ? ["coQs", "coqs", "coQUsers", "coQNames", "co_qs", "coQ"]
    : ["qs", "qUsers", "qNames", "q", "Q"];
  const raw = firstValue(record, candidateKeys);
  if (!raw) return [];
  if (typeof raw === "string") return raw.split(",").map((name) => name.trim()).filter(Boolean);
  if (!Array.isArray(raw)) return [];

  return raw
    .map((item) => {
      if (typeof item === "string") return item;
      return firstValue(item, ["f3Name", "f3_name", "name", "userName", "displayName"]);
    })
    .map((name) => String(name || "").trim())
    .filter(Boolean);
}

function attendanceTypeNames(record) {
  const raw = firstValue(record, ["attendanceTypes", "types", "attendance_type_names", "typeNames"]);
  if (!raw) return [];
  if (typeof raw === "string") return [raw];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (typeof item === "string") return item;
      return firstValue(item, ["type", "name", "attendanceTypeName", "typeName"]);
    })
    .map((name) => String(name || "").toLowerCase())
    .filter(Boolean);
}

function attendanceUserName(record) {
  return firstValue(record, [
    "f3Name",
    "f3_name",
    "userF3Name",
    "user_f3_name",
    "userName",
    "name",
  ]) || firstValue(record.user || {}, ["f3Name", "f3_name", "name"]);
}

function attendanceQLabels(rows) {
  const labels = { qs: [], coqs: [] };
  for (const row of rows) {
    const name = String(attendanceUserName(row) || "").trim();
    if (!name) continue;

    const typeNames = attendanceTypeNames(row);
    const qInd = Boolean(firstValue(row, ["qInd", "q_ind", "isQ"]));
    const coqInd = Boolean(firstValue(row, ["coQInd", "coqInd", "coq_ind", "isCoQ"]));
    const isQ = qInd || typeNames.some((type) => /^q$|primary q|workout leader/.test(type));
    const isCoQ = coqInd || typeNames.some((type) => /co[-\s]?q|co q/.test(type));

    if (isQ && !labels.qs.includes(name)) labels.qs.push(name);
    else if (isCoQ && !labels.coqs.includes(name)) labels.coqs.push(name);
  }
  return labels;
}

function normalizeEvent(record) {
  const event = record.event || record.eventInstance || record;
  return {
    id: firstValue(event, ["id", "eventInstanceId", "event_instance_id"]),
    startDate: normalizeDate(firstValue(event, ["startDate", "start_date", "date"])),
    startTime: firstValue(event, ["startTime", "start_time"]),
    endTime: firstValue(event, ["endTime", "end_time"]),
    aoName: firstValue(event, ["aoName", "ao_name", "ao", "orgName"]),
    name: firstValue(event, ["name", "eventName", "title", "seriesName", "series_name"]),
    qs: normalizeQNames(event, false),
    coqs: normalizeQNames(event, true),
    raw: record,
  };
}

function extractRows(payload) {
  if (Array.isArray(payload)) return payload;
  for (const key of ["events", "eventInstances", "attendance", "schedule", "items", "rows", "data"]) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return [];
}

async function getPlannedAttendanceLabels(eventInstanceId, config = configFromEnv()) {
  if (!eventInstanceId) return { qs: [], coqs: [] };
  const payload = await fetchJson(
    `/v1/attendance/event-instance/${encodeURIComponent(eventInstanceId)}`,
    { isPlanned: true },
    config
  );
  return attendanceQLabels(extractRows(payload));
}

async function getUpcomingEventInstances({ aoOrgId, startDate, limit = 45 } = {}, config = configFromEnv()) {
  if (!isConfigured(config)) {
    return { configured: false, events: [] };
  }

  const query = {
    regionOrgId: config.regionOrgId,
    aoOrgId,
    startDate,
    pageSize: limit,
    pageIndex: 0,
  };

  const key = cacheKeyFor("/v1/event-instance", query);
  const ttlMs = Number.isFinite(config.cacheTtlMs) && config.cacheTtlMs >= 0 ? config.cacheTtlMs : 300000;
  const cached = readCache(key, ttlMs);
  if (cached) return cached;

  const payload = await fetchJson("/v1/event-instance", query, config);
  const events = extractRows(payload).map(normalizeEvent);
  const enrichedEvents = await Promise.all(
    events.map(async (event) => {
      if (event.qs.length > 0 || event.coqs.length > 0) return event;
      const labels = await getPlannedAttendanceLabels(event.id, config).catch(() => ({
        qs: [],
        coqs: [],
      }));
      return { ...event, ...labels };
    })
  );
  const value = {
    configured: true,
    events: enrichedEvents,
    raw: payload,
  };
  writeCache(key, value);
  return value;
}

module.exports = {
  configFromEnv,
  getUpcomingEventInstances,
  isConfigured,
  normalizeEvent,
};
