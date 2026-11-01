// Reads grush.json for the mock with the same rules GameRush applies on upload, so a mistake shows up
// while testing locally instead of failing the upload. The messages match the ones the upload shows.
export const MANIFEST_PATH = "grush.json";

const MAX_BYTES = 64 * 1024;
const MAX_LEADERBOARDS = 20;
const MAX_TITLE_LENGTH = 60;
const KEY_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const LINE_BREAKING_OR_CONTROL = /[\p{Cc}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069]+/gu;
// A lone surrogate (half of a UTF-16 pair). With the u flag a whole pair is one code point, so only
// the unpaired halves match.
const LONE_SURROGATE = /\p{Cs}/gu;
const TOP_LEVEL_FIELDS = new Set(["$schema", "leaderboards"]);
const ENTRY_FIELDS = new Set([
  "key",
  "title",
  "sort",
  "valueType",
  "aggregation",
  "period",
  "minValue",
  "maxValue",
  "enabled",
]);
const CHOICES = {
  sort: ["desc", "asc"],
  valueType: ["int", "float", "duration_ms"],
  aggregation: ["best", "last", "sum"],
  period: ["all_time", "daily", "weekly", "monthly"],
};

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidField(field) {
  return { ok: false, error: `${MANIFEST_PATH} has an invalid value: ${field}` };
}

// GameRush measures the file in bytes and rejects bytes that are not UTF-8, so a fetched file is
// passed in as bytes. Like GameRush, the decoder drops a leading UTF-8 BOM and one more is dropped
// before JSON.parse, as some Windows editors add one.
function readSource(source) {
  if (typeof source !== "string" && !(source instanceof Uint8Array)) {
    return { ok: true, value: source };
  }
  const bytes = typeof source === "string" ? new TextEncoder().encode(source) : source;
  if (bytes.byteLength > MAX_BYTES) {
    return { ok: false, error: `${MANIFEST_PATH} is too large (${MAX_BYTES / 1024}KB at most).` };
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, error: `${MANIFEST_PATH} can't be read as a JSON object.` };
  }
}

// The checks run in the same order as on upload, so a file with several mistakes reports the same one.
function readEntry(item, at, seen) {
  if (!isPlainObject(item)) return invalidField(at);
  for (const field of Object.keys(item)) {
    if (!ENTRY_FIELDS.has(field)) {
      return { ok: false, error: `${MANIFEST_PATH} has an unknown field: ${at}.${field}` };
    }
  }
  if (typeof item.key !== "string" || !KEY_PATTERN.test(item.key)) return invalidField(`${at}.key`);
  if (seen.has(item.key)) {
    return {
      ok: false,
      error: `${MANIFEST_PATH} declares the leaderboard key more than once: ${item.key}`,
    };
  }
  seen.add(item.key);
  for (const field of ["minValue", "maxValue"]) {
    const value = item[field];
    if (value !== undefined && value !== null && !Number.isFinite(value)) {
      return invalidField(`${at}.${field}`);
    }
  }
  // Like GameRush, lone surrogates are dropped first, so control characters on both sides of one
  // collapse into a single space.
  const title =
    typeof item.title === "string"
      ? item.title.replace(LONE_SURROGATE, "").replace(LINE_BREAKING_OR_CONTROL, " ").trim()
      : "";
  if (title.length < 1 || title.length > MAX_TITLE_LENGTH) return invalidField(`${at}.title`);
  for (const [field, choices] of Object.entries(CHOICES)) {
    if (!choices.includes(item[field])) return invalidField(`${at}.${field}`);
  }
  if (item.enabled !== undefined && typeof item.enabled !== "boolean") {
    return invalidField(`${at}.enabled`);
  }
  const minValue = item.minValue ?? null;
  const maxValue = item.maxValue ?? null;
  if ((minValue === null) !== (maxValue === null) || (minValue !== null && minValue >= maxValue)) {
    return invalidField(`${at}.minValue / maxValue`);
  }
  return {
    ok: true,
    entry: {
      key: item.key,
      title,
      sort: item.sort,
      valueType: item.valueType,
      aggregation: item.aggregation,
      period: item.period,
      minValue,
      maxValue,
      enabled: item.enabled !== false,
    },
  };
}

// source is the file's text, its bytes, or the already parsed object. Returns
// { ok: true, leaderboards } or { ok: false, error }.
export function parseLeaderboardManifest(source) {
  const read = readSource(source);
  if (!read.ok) return read;
  const parsed = read.value;
  if (!isPlainObject(parsed)) {
    return { ok: false, error: `${MANIFEST_PATH} can't be read as a JSON object.` };
  }
  for (const field of Object.keys(parsed)) {
    if (!TOP_LEVEL_FIELDS.has(field)) {
      return { ok: false, error: `${MANIFEST_PATH} has an unknown field: ${field}` };
    }
  }
  const list = parsed.leaderboards ?? [];
  if (!Array.isArray(list)) return invalidField("leaderboards");
  if (list.length > MAX_LEADERBOARDS) {
    return {
      ok: false,
      error: `${MANIFEST_PATH} can declare up to ${MAX_LEADERBOARDS} leaderboards.`,
    };
  }
  const leaderboards = [];
  const seen = new Set();
  for (const [index, item] of list.entries()) {
    const read = readEntry(item, `leaderboards[${index}]`, seen);
    if (!read.ok) return read;
    leaderboards.push(read.entry);
  }
  return { ok: true, leaderboards };
}
