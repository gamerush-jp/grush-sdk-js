import { gameJsonError, operationIdError } from "./game-json.js";
import { isLeaderboardKey } from "./mock-manifest.js";

const PERIODS = new Set(["all_time", "daily", "weekly", "monthly"]);

function clamp(value, fallback, max) {
  return typeof value === "number" && value > 0 ? Math.min(Math.floor(value), max) : fallback;
}

// The same period keys GameRush uses (UTC). When the key changes, the board starts over like a new
// period on the server.
function periodKeyOf(period, at) {
  if (period === "daily") return at.toISOString().slice(0, 10);
  if (period === "monthly") return at.toISOString().slice(0, 7);
  if (period !== "weekly") return "";
  const date = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const day = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function createMockLeaderboards(selfIdentity, now = () => new Date()) {
  const boards = new Map();
  let rivalCount = 0;

  // requireRange is set for boards read from grush.json: GameRush accepts no score on a board without
  // minValue / maxValue. defineLeaderboard keeps accepting any value when no range is given.
  function create(key, options, requireRange) {
    const period = PERIODS.has(options.period) ? options.period : "all_time";
    boards.set(key, {
      key,
      title: options.title || key,
      sort: options.sort === "asc" ? "asc" : "desc",
      valueType: options.valueType ?? "int",
      aggregation: options.aggregation ?? "best",
      period,
      minValue: options.minValue ?? null,
      maxValue: options.maxValue ?? null,
      enabled: options.enabled !== false,
      requireRange,
      periodKey: periodKeyOf(period, now()),
      entries: [],
    });
  }

  function define(key, options = {}) {
    create(key, options, false);
  }

  // Defines the boards of a parsed grush.json. With keepDefined, keys already declared with
  // defineLeaderboard stay as they are. A board that only addRival created is a placeholder: addRival
  // can run before grush.json is read, so the file's definition replaces it and keeps its entries.
  // Returns the keys it defined.
  function load(entries, keepDefined) {
    const defined = [];
    for (const entry of entries) {
      const existing = boards.get(entry.key);
      if (keepDefined && existing && !existing.placeholder) continue;
      create(entry.key, entry, true);
      if (existing?.placeholder) boards.get(entry.key).entries = existing.entries;
      defined.push(entry.key);
    }
    return defined;
  }

  function ensure(key) {
    if (!boards.has(key)) {
      define(key);
      boards.get(key).placeholder = true;
    }
    return boards.get(key);
  }

  function addRival(key, displayName, value, options = {}) {
    const isGuest = options.isGuest === true;
    rivalCount += 1;
    current(ensure(key)).entries.push({
      pseudoId: `mock-rival-${rivalCount}`,
      displayName: isGuest ? null : displayName,
      avatarUrl: isGuest ? null : (options.avatarUrl ?? null),
      isGuest,
      value,
      metadata: null,
      isSelf: false,
    });
  }

  function ranked(board) {
    const direction = board.sort === "asc" ? 1 : -1;
    return [...board.entries].sort((a, b) => (a.value - b.value) * direction);
  }

  function current(board) {
    const key = periodKeyOf(board.period, now());
    if (key !== board.periodKey) {
      board.periodKey = key;
      board.entries = [];
    }
    return board;
  }

  function list() {
    return [...boards.values()]
      .filter((board) => board.enabled)
      .map((board) => ({
        key: board.key,
        title: board.title,
        sort: board.sort,
        valueType: board.valueType,
        aggregation: board.aggregation,
        period: board.period,
        minValue: board.minValue,
        maxValue: board.maxValue,
      }));
  }

  // GameRush answers an undeclared key and a disabled board the same way.
  function playable(key) {
    if (!isLeaderboardKey(key)) return { error: "Invalid leaderboard key." };
    const board = boards.get(key);
    if (!board) {
      return {
        error: `No mock leaderboard named ${key}. Declare it in grush.json or with GRush.mock.defineLeaderboard.`,
      };
    }
    if (!board.enabled) return { error: `The mock leaderboard ${key} is disabled.` };
    return { board: current(board) };
  }

  function nextValue(board, current, value) {
    if (board.aggregation === "sum") return current + value;
    if (board.aggregation === "last") return value;
    const better = board.sort === "asc" ? value < current : value > current;
    return better ? value : current;
  }

  // The checks run in the same order as on GameRush: the board, the value, metadata, operationId, then
  // the declared range.
  function submit(key, value, metadata, operationId) {
    const found = playable(key);
    if (found.error) return found;
    const { board } = found;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { error: "Score must be a finite number." };
    }
    if (board.valueType !== "float" && !Number.isInteger(value)) {
      return { error: "Score must be an integer for this leaderboard." };
    }
    if (board.valueType === "duration_ms" && value < 0) {
      return { error: "Duration must not be negative." };
    }
    if (metadata !== undefined && metadata !== null) {
      const metadataError = gameJsonError(metadata, "Metadata");
      if (metadataError) return { error: metadataError };
    }
    const idError = operationIdError(operationId);
    if (idError) return { error: idError };
    if (board.requireRange && board.minValue === null) {
      return { error: "This leaderboard declares no minValue / maxValue, so it accepts no score." };
    }
    const belowMin = board.minValue !== null && value < board.minValue;
    const aboveMax = board.maxValue !== null && value > board.maxValue;
    if (belowMin || aboveMax) {
      return { error: "Score is outside the declared range." };
    }
    let self = board.entries.find((entry) => entry.isSelf);
    let updated = true;
    if (!self) {
      self = { isSelf: true, value, metadata: null };
      board.entries.push(self);
    } else {
      const next = nextValue(board, self.value, value);
      updated = next !== self.value;
      self.value = next;
    }
    Object.assign(self, selfIdentity());
    if (metadata !== undefined && metadata !== null) self.metadata = metadata;
    const rank = ranked(board).indexOf(self) + 1;
    return { result: { accepted: true, updated, value: self.value, rank, verified: false } };
  }

  function pageWire(board, entries, start, total) {
    return {
      key: board.key,
      title: board.title,
      sort: board.sort,
      valueType: board.valueType,
      period: board.period,
      periodKey: board.periodKey,
      verified: false,
      total,
      entries: entries.map((stored, index) => {
        const entry = stored.isSelf ? { ...stored, ...selfIdentity() } : stored;
        return {
          rank: start + index + 1,
          pseudoId: entry.pseudoId,
          displayName: entry.displayName,
          avatarUrl: entry.avatarUrl,
          isGuest: entry.isGuest,
          value: entry.value,
          metadata: entry.metadata ?? null,
          submittedAt: "",
          isSelf: entry.isSelf,
        };
      }),
    };
  }

  function page(key, options = {}, aroundMe = false) {
    const found = playable(key);
    if (found.error) return found;
    const { board } = found;
    const rows = ranked(board);
    if (!aroundMe) {
      const start = Math.max(0, options.offset ?? 0);
      const count = clamp(options.limit, 20, 100);
      return { page: pageWire(board, rows.slice(start, start + count), start, rows.length) };
    }
    const selfIndex = rows.findIndex((entry) => entry.isSelf);
    if (selfIndex < 0) return { page: pageWire(board, [], 0, rows.length) };
    const range = clamp(options.range, 5, 25);
    const start = Math.max(0, selfIndex - range);
    return {
      page: pageWire(board, rows.slice(start, selfIndex + range + 1), start, rows.length),
    };
  }

  return { define, load, addRival, list, submit, page, reset: () => boards.clear() };
}
