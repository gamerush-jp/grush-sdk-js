/*! GameRush SDK for JavaScript v0.12.0 */
"use strict";
(() => {
  // src/analytics-rules.js
  var ANALYTICS_EVENT_KINDS = ["onboarding", "funnel", "custom", "economy"];
  var ANALYTICS_ECONOMY_FLOWS = ["source", "sink"];
  var ANALYTICS_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
  var ANALYTICS_SHORT_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,32}$/;
  var ANALYTICS_FIELD_KEY_PATTERN = /^[A-Za-z0-9_]{1,32}$/;
  var ANALYTICS_MAX_FIELDS = 3;
  var ANALYTICS_MAX_TEXT_CODE_POINTS = 40;
  var ANALYTICS_MIN_STEP = 1;
  var ANALYTICS_MAX_STEP = 100;
  var ANALYTICS_DEFAULT_CUSTOM_VALUE = 1;
  var ANALYTICS_MAX_ABS_CUSTOM_VALUE = 1e9;
  var ANALYTICS_MAX_AMOUNT = 1e12;
  var ANALYTICS_MAX_ABS_ENDING_BALANCE = 1e15;
  var LINE_BREAKING_OR_CONTROL = /[\p{Cc}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069]+/gu;
  var VISIBLY_BLANK = /^[\s\p{Z}\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u115F\u1160\u3164\uFFA0\u2800]*$/u;
  var LONE_SURROGATE = /\p{Cs}/u;
  function reject(reason) {
    return { ok: false, reason };
  }
  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function isKey(value, pattern) {
    return typeof value === "string" && pattern.test(value);
  }
  function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }
  function lineText(value) {
    if (typeof value !== "string") return null;
    const text2 = value.replace(LINE_BREAKING_OR_CONTROL, " ").trim();
    if (LONE_SURROGATE.test(text2)) return null;
    if ([...text2].length > ANALYTICS_MAX_TEXT_CODE_POINTS) return null;
    return VISIBLY_BLANK.test(text2) ? "" : text2;
  }
  function optionalText(value) {
    if (value === void 0 || value === null) return { ok: true, value: void 0 };
    const text2 = lineText(value);
    if (text2 === null) return reject("text");
    return { ok: true, value: text2 === "" ? void 0 : text2 };
  }
  function sanitizeFields(value) {
    if (value === void 0 || value === null) return { ok: true, value: void 0 };
    if (!isRecord(value)) return reject("fields");
    const entries = Object.entries(value);
    if (entries.length > ANALYTICS_MAX_FIELDS) return reject("fields");
    const normalized = [];
    for (const [key, raw] of entries) {
      const text2 = lineText(raw);
      if (!ANALYTICS_FIELD_KEY_PATTERN.test(key) || !text2) return reject("fields");
      normalized.push([key, text2]);
    }
    if (normalized.length === 0) return { ok: true, value: void 0 };
    return { ok: true, value: Object.fromEntries(normalized) };
  }
  function isStep(value) {
    return typeof value === "number" && Number.isInteger(value) && value >= ANALYTICS_MIN_STEP && value <= ANALYTICS_MAX_STEP;
  }
  function sanitizeStep(data, fields) {
    if (!isStep(data.step)) return reject("step");
    const stepName = optionalText(data.stepName);
    if (!stepName.ok) return stepName;
    let event;
    if (data.kind === "onboarding") {
      event = { kind: "onboarding", step: data.step };
    } else {
      if (!isKey(data.funnel, ANALYTICS_KEY_PATTERN)) return reject("name");
      event = { kind: "funnel", funnel: data.funnel, step: data.step };
      const funnelSessionId = data.funnelSessionId;
      if (funnelSessionId !== void 0 && funnelSessionId !== null && funnelSessionId !== "") {
        if (!isKey(funnelSessionId, ANALYTICS_KEY_PATTERN)) return reject("name");
        event.funnelSessionId = funnelSessionId;
      }
    }
    if (stepName.value !== void 0) event.stepName = stepName.value;
    if (fields !== void 0) event.fields = fields;
    return { ok: true, event };
  }
  function sanitizeCustom(data, fields) {
    if (!isKey(data.name, ANALYTICS_KEY_PATTERN)) return reject("name");
    const value = data.value === void 0 ? ANALYTICS_DEFAULT_CUSTOM_VALUE : data.value;
    if (!isFiniteNumber(value) || Math.abs(value) > ANALYTICS_MAX_ABS_CUSTOM_VALUE) {
      return reject("value");
    }
    const event = { kind: "custom", name: data.name, value };
    if (fields !== void 0) event.fields = fields;
    return { ok: true, event };
  }
  function sanitizeEconomy(data, fields) {
    const { flowType, currency, amount, endingBalance, transactionType } = data;
    if (!ANALYTICS_ECONOMY_FLOWS.includes(flowType)) return reject("flowType");
    if (!isKey(currency, ANALYTICS_SHORT_KEY_PATTERN)) return reject("currency");
    if (!isFiniteNumber(amount) || amount <= 0 || amount > ANALYTICS_MAX_AMOUNT) {
      return reject("amount");
    }
    if (!isFiniteNumber(endingBalance) || Math.abs(endingBalance) > ANALYTICS_MAX_ABS_ENDING_BALANCE) {
      return reject("endingBalance");
    }
    if (!isKey(transactionType, ANALYTICS_SHORT_KEY_PATTERN)) return reject("transactionType");
    const itemSku = optionalText(data.itemSku);
    if (!itemSku.ok) return itemSku;
    const event = { kind: "economy", flowType, currency, amount, endingBalance, transactionType };
    if (itemSku.value !== void 0) event.itemSku = itemSku.value;
    if (fields !== void 0) event.fields = fields;
    return { ok: true, event };
  }
  function sanitizeAnalyticsEvent(raw) {
    if (!isRecord(raw)) return reject("shape");
    if (!ANALYTICS_EVENT_KINDS.includes(raw.kind)) return reject("kind");
    const fields = sanitizeFields(raw.fields);
    if (!fields.ok) return fields;
    if (raw.kind === "onboarding" || raw.kind === "funnel") return sanitizeStep(raw, fields.value);
    if (raw.kind === "custom") return sanitizeCustom(raw, fields.value);
    return sanitizeEconomy(raw, fields.value);
  }

  // src/mock-leaderboards.js
  var PERIODS = /* @__PURE__ */ new Set(["all_time", "daily", "weekly", "monthly"]);
  function clamp(value, fallback, max) {
    return typeof value === "number" && value > 0 ? Math.min(Math.floor(value), max) : fallback;
  }
  function periodKeyOf(period, at) {
    if (period === "daily") return at.toISOString().slice(0, 10);
    if (period === "monthly") return at.toISOString().slice(0, 7);
    if (period !== "weekly") return "";
    const date = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
    const day = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
    date.setUTCDate(date.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 864e5 + 1) / 7);
    return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
  }
  function createMockLeaderboards(selfIdentity, now = () => /* @__PURE__ */ new Date()) {
    const boards = /* @__PURE__ */ new Map();
    let rivalCount = 0;
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
        entries: []
      });
    }
    function define(key, options = {}) {
      create(key, options, false);
    }
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
        avatarUrl: isGuest ? null : options.avatarUrl ?? null,
        isGuest,
        value,
        metadata: null,
        isSelf: false
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
      return [...boards.values()].filter((board) => board.enabled).map((board) => ({
        key: board.key,
        title: board.title,
        sort: board.sort,
        valueType: board.valueType,
        aggregation: board.aggregation,
        period: board.period,
        minValue: board.minValue,
        maxValue: board.maxValue
      }));
    }
    function playable(key) {
      const board = boards.get(key);
      if (!board) {
        return {
          error: `No mock leaderboard named ${key}. Declare it in grush.json or with GRush.mock.defineLeaderboard.`
        };
      }
      if (!board.enabled) return { error: `The mock leaderboard ${key} is disabled.` };
      return { board: current(board) };
    }
    function nextValue(board, current2, value) {
      if (board.aggregation === "sum") return current2 + value;
      if (board.aggregation === "last") return value;
      const better = board.sort === "asc" ? value < current2 : value > current2;
      return better ? value : current2;
    }
    function submit(key, value, metadata) {
      const found = playable(key);
      if (found.error) return found;
      const { board } = found;
      if (board.requireRange && board.minValue === null) {
        return { error: "This leaderboard declares no minValue / maxValue, so it accepts no score." };
      }
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { error: "Score must be a finite number." };
      }
      if (board.valueType !== "float" && !Number.isInteger(value)) {
        return { error: "Score must be an integer for this leaderboard." };
      }
      if (board.valueType === "duration_ms" && value < 0) {
        return { error: "Duration must not be negative." };
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
      if (metadata !== void 0 && metadata !== null) self.metadata = metadata;
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
            isSelf: entry.isSelf
          };
        })
      };
    }
    function page(key, options = {}, aroundMe = false) {
      const found = playable(key);
      if (found.error) return found;
      const { board } = found;
      const rows = ranked(board);
      if (!aroundMe) {
        const start2 = Math.max(0, options.offset ?? 0);
        const count = clamp(options.limit, 20, 100);
        return { page: pageWire(board, rows.slice(start2, start2 + count), start2, rows.length) };
      }
      const selfIndex = rows.findIndex((entry) => entry.isSelf);
      if (selfIndex < 0) return { page: pageWire(board, [], 0, rows.length) };
      const range = clamp(options.range, 5, 25);
      const start = Math.max(0, selfIndex - range);
      return {
        page: pageWire(board, rows.slice(start, selfIndex + range + 1), start, rows.length)
      };
    }
    return { define, load, addRival, list, submit, page, reset: () => boards.clear() };
  }

  // src/mock-manifest.js
  var MANIFEST_PATH = "grush.json";
  var MAX_BYTES = 64 * 1024;
  var MAX_LEADERBOARDS = 20;
  var MAX_TITLE_LENGTH = 60;
  var KEY_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
  var LINE_BREAKING_OR_CONTROL2 = /[\p{Cc}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069]+/gu;
  var TOP_LEVEL_FIELDS = /* @__PURE__ */ new Set(["$schema", "leaderboards"]);
  var ENTRY_FIELDS = /* @__PURE__ */ new Set([
    "key",
    "title",
    "sort",
    "valueType",
    "aggregation",
    "period",
    "minValue",
    "maxValue",
    "enabled"
  ]);
  var CHOICES = {
    sort: ["desc", "asc"],
    valueType: ["int", "float", "duration_ms"],
    aggregation: ["best", "last", "sum"],
    period: ["all_time", "daily", "weekly", "monthly"]
  };
  function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  function invalidField(field) {
    return { ok: false, error: `${MANIFEST_PATH} has an invalid value: ${field}` };
  }
  function readSource(source) {
    if (typeof source !== "string" && !(source instanceof Uint8Array)) {
      return { ok: true, value: source };
    }
    const bytes = typeof source === "string" ? new TextEncoder().encode(source) : source;
    if (bytes.byteLength > MAX_BYTES) {
      return { ok: false, error: `${MANIFEST_PATH} is too large (${MAX_BYTES / 1024}KB at most).` };
    }
    try {
      const text2 = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
      return { ok: true, value: JSON.parse(text2) };
    } catch {
      return { ok: false, error: `${MANIFEST_PATH} can't be read as a JSON object.` };
    }
  }
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
        error: `${MANIFEST_PATH} declares the leaderboard key more than once: ${item.key}`
      };
    }
    seen.add(item.key);
    for (const field of ["minValue", "maxValue"]) {
      const value = item[field];
      if (value !== void 0 && value !== null && !Number.isFinite(value)) {
        return invalidField(`${at}.${field}`);
      }
    }
    const title = typeof item.title === "string" ? item.title.replace(LINE_BREAKING_OR_CONTROL2, " ").trim() : "";
    if (title.length < 1 || title.length > MAX_TITLE_LENGTH) return invalidField(`${at}.title`);
    for (const [field, choices] of Object.entries(CHOICES)) {
      if (!choices.includes(item[field])) return invalidField(`${at}.${field}`);
    }
    if (item.enabled !== void 0 && typeof item.enabled !== "boolean") {
      return invalidField(`${at}.enabled`);
    }
    const minValue = item.minValue ?? null;
    const maxValue = item.maxValue ?? null;
    if (minValue === null !== (maxValue === null) || minValue !== null && minValue >= maxValue) {
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
        enabled: item.enabled !== false
      }
    };
  }
  function parseLeaderboardManifest(source) {
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
        error: `${MANIFEST_PATH} can declare up to ${MAX_LEADERBOARDS} leaderboards.`
      };
    }
    const leaderboards = [];
    const seen = /* @__PURE__ */ new Set();
    for (const [index, item] of list.entries()) {
      const read2 = readEntry(item, `leaderboards[${index}]`, seen);
      if (!read2.ok) return read2;
      leaderboards.push(read2.entry);
    }
    return { ok: true, leaderboards };
  }

  // src/bytes.js
  var MAX_MESSAGE_BYTES = 8 * 1024;
  function toBytes(payload) {
    if (payload instanceof ArrayBuffer) return payload.slice(0);
    if (ArrayBuffer.isView(payload)) {
      return payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
    }
    if (typeof payload === "string") return new TextEncoder().encode(payload).buffer;
    return null;
  }
  function decodeText(buffer) {
    if (!(buffer instanceof ArrayBuffer)) return "";
    return new TextDecoder().decode(buffer);
  }
  function decodeJson(buffer) {
    try {
      return JSON.parse(decodeText(buffer));
    } catch {
      return void 0;
    }
  }

  // src/mock-net.js
  var MODE_PATTERN = /^[A-Za-z0-9._:-]{1,32}$/;
  var ROOM_CODE_PATTERN = /^[A-Za-z0-9]{4,12}$/;
  function later(callback) {
    setTimeout(callback, 0);
  }
  function createListeners() {
    const handlers = /* @__PURE__ */ new Map();
    return {
      on(name, handler) {
        if (typeof handler !== "function") return () => {
        };
        const list = handlers.get(name) ?? [];
        handlers.set(name, [...list, handler]);
        return () => handlers.set(
          name,
          (handlers.get(name) ?? []).filter((h) => h !== handler)
        );
      },
      emit(name, event) {
        for (const handler of handlers.get(name) ?? []) {
          try {
            handler(event);
          } catch {
          }
        }
      },
      clear: () => handlers.clear()
    };
  }
  function createMockNet(config, localPeerWire) {
    const members = /* @__PURE__ */ new Map();
    const outgoingSeq = /* @__PURE__ */ new Map();
    const local = createListeners();
    let localIndex = -1;
    let roomCode = "";
    let hostIndex = -1;
    let peerSerial = 0;
    function nextFreeIndex() {
      for (let index = 0; index < config.maxPeers; index += 1) {
        if (!members.has(index) && index !== localIndex) return index;
      }
      return -1;
    }
    function peerWire(index) {
      const peer = members.get(index);
      if (!peer) return localPeerWire(index);
      return {
        index,
        pseudoId: peer.pseudoId,
        displayName: peer.displayName,
        avatarUrl: peer.avatarUrl
      };
    }
    function lowestIndex() {
      return members.size === 0 && localIndex < 0 ? -1 : Math.min(...allIndexes());
    }
    function allIndexes() {
      const indexes = [...members.keys()];
      if (localIndex >= 0) indexes.push(localIndex);
      return indexes;
    }
    function announceToLocal(name, event) {
      if (localIndex < 0) return;
      later(() => local.emit(name, event));
    }
    function refreshHost() {
      const next = lowestIndex();
      if (next === hostIndex) return;
      hostIndex = next;
      if (next >= 0) announceToLocal("host", { index: next });
    }
    function route(from, payload, options = {}) {
      const bytes = toBytes(payload);
      if (!bytes) throw new TypeError("Payload must be an ArrayBuffer, a typed array, or a string.");
      const channel = options.channel === "unreliable" ? "unreliable" : "reliable";
      const to = typeof options.to === "number" ? options.to : -1;
      if (channel === "unreliable" && Math.random() < config.unreliableDropRate) return;
      const seq = (outgoingSeq.get(from) ?? 0) + 1;
      outgoingSeq.set(from, seq);
      for (const index of allIndexes()) {
        if (index === from || to !== -1 && index !== to) continue;
        const message = { from, channel, seq, payload: bytes.slice(0) };
        const peer = members.get(index);
        if (peer) later(() => peer.listeners.emit("message", withDecoders(message)));
        else later(() => local.emit("message", message));
      }
    }
    function addPeer(displayName, avatarUrl = null) {
      const index = nextFreeIndex();
      if (index < 0) return null;
      const listeners = createListeners();
      peerSerial += 1;
      const peer = {
        index,
        pseudoId: `mock-peer-${peerSerial}`,
        displayName,
        avatarUrl,
        listeners
      };
      members.set(index, peer);
      announceToLocal("peerjoin", peerWire(index));
      refreshHost();
      return {
        index,
        pseudoId: peer.pseudoId,
        displayName,
        avatarUrl,
        on: (name, handler) => listeners.on(name, handler),
        send: (payload, options) => {
          if (members.get(index) === peer) route(index, payload, options);
        }
      };
    }
    function removePeer(handle) {
      if (!handle || members.get(handle.index)?.pseudoId !== handle.pseudoId) return;
      members.get(handle.index).listeners.clear();
      members.delete(handle.index);
      outgoingSeq.delete(handle.index);
      announceToLocal("peerleave", { index: handle.index });
      refreshHost();
    }
    function leave() {
      if (localIndex < 0) return;
      outgoingSeq.delete(localIndex);
      localIndex = -1;
      local.clear();
      hostIndex = lowestIndex();
    }
    function join(params) {
      leave();
      const mode = params.mode ?? "default";
      const requested = params.roomCode;
      if (!MODE_PATTERN.test(mode)) return null;
      if (requested !== void 0 && !ROOM_CODE_PATTERN.test(requested)) return null;
      const index = nextFreeIndex();
      if (index < 0) return null;
      roomCode = requested ? requested.toUpperCase() : roomCode || "MOCKROOM";
      const peers = [...members.keys()].map(peerWire);
      localIndex = index;
      hostIndex = lowestIndex();
      const source = {
        on: (name, handler) => local.on(name, handler),
        send: (bytes, options) => route(index, bytes, options),
        leave: async () => {
          if (localIndex === index) leave();
          return true;
        }
      };
      const info = {
        roomId: `mock:${mode}:${roomCode}`,
        roomCode,
        epoch: 1,
        localPeerIndex: index,
        hostIndex,
        peers: [...peers, localPeerWire(index)],
        transport: "ws",
        serverTimeMs: Date.now()
      };
      return { source, info };
    }
    function raiseError(code, message) {
      if (localIndex < 0) return false;
      announceToLocal("error", { code: String(code), message: String(message) });
      return true;
    }
    function reset() {
      for (const peer of members.values()) peer.listeners.clear();
      members.clear();
      outgoingSeq.clear();
      leave();
      roomCode = "";
      hostIndex = -1;
    }
    return { join, addPeer, removePeer, raiseError, reset };
  }
  function withDecoders(message) {
    return {
      ...message,
      isStale: false,
      text: () => decodeText(message.payload),
      json: () => decodeJson(message.payload)
    };
  }

  // src/result.js
  var CODES = Object.freeze({
    unsupported: "unsupported",
    unavailable: "unavailable",
    timeout: "timeout",
    rateLimited: "rateLimited",
    signInRequired: "signInRequired",
    consentDeclined: "consentDeclined",
    invalidParams: "invalidParams",
    conflict: "conflict",
    internal: "internal"
  });
  var PASS_THROUGH_CODES = new Set(Object.values(CODES));
  function ok(value) {
    return { ok: true, value, code: "", message: "" };
  }
  function failure(code, message) {
    return { ok: false, value: null, code, message };
  }
  function unsupported() {
    return failure(CODES.unsupported, "GameRush GameAPI is not available here.");
  }
  function failureFromError(error) {
    const rawCode = error && typeof error.code === "string" ? error.code : "";
    const code = rawCode === "unsupportedMethod" ? CODES.unsupported : PASS_THROUGH_CODES.has(rawCode) ? rawCode : CODES.internal;
    const result = failure(code, messageOf(error, "GameRush API call failed."));
    if (error && typeof error.retryAfterMs === "number") result.retryAfterMs = error.retryAfterMs;
    return result;
  }
  var CLOUD_SAVE_STATUS_CODES = /* @__PURE__ */ new Map([
    [0, CODES.unavailable],
    [400, CODES.invalidParams],
    [401, CODES.signInRequired],
    [409, CODES.conflict],
    [413, CODES.invalidParams],
    [429, CODES.rateLimited]
  ]);
  function failureFromCloudSaveError(error) {
    const status = error && typeof error.status === "number" ? error.status : null;
    const message = messageOf(error, "Cloud save failed.");
    if (status === null) {
      if (/timed out/i.test(message)) return failure(CODES.timeout, message);
      if (/only available inside GameRush|frame was destroyed/i.test(message)) {
        return failure(CODES.unavailable, message);
      }
      return failure(CODES.invalidParams, message);
    }
    if (status === 409 && /owner mismatch/i.test(message)) return failure(CODES.internal, message);
    return failure(CLOUD_SAVE_STATUS_CODES.get(status) ?? CODES.internal, message);
  }
  function messageOf(error, fallback) {
    return error && typeof error.message === "string" && error.message ? error.message : fallback;
  }

  // src/mock-social.js
  var TOKEN = /^[A-Za-z0-9_.:-]{1,32}$/;
  var KEY = /^[A-Za-z0-9._:-]{1,32}$/;
  var OPERATION_ID = /^[A-Za-z0-9._:-]{1,64}$/;
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var MAX_DEPTH = 4;
  var MAX_SCALARS = 64;
  var INBOX_MAX_BYTES = 1024;
  var OFFER_MAX_BYTES = 2048;
  var WANT_MAX_BYTES = 1024;
  var GIVE_MAX_BYTES = 2048;
  var MAX_IDS = 50;
  var DEFAULT_LIMIT = 20;
  var MAX_LIMIT = 50;
  var MAX_OPEN_TRADES = 10;
  var PENDING_LIMIT = 100;
  var DEFAULT_EXPIRES_IN_SEC = 3 * 24 * 60 * 60;
  var MIN_EXPIRES_IN_SEC = 10 * 60;
  var MAX_EXPIRES_IN_SEC = 7 * 24 * 60 * 60;
  var MOCK_RIVALS = Object.freeze(["mock-rival-1", "mock-rival-2", "mock-rival-3"]);
  function isPlainObject2(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }
  function walk(value, depth, state) {
    if (Array.isArray(value) || isPlainObject2(value)) {
      if (depth > MAX_DEPTH) return `${state.label} must not nest deeper than ${MAX_DEPTH} levels.`;
      const entries = Array.isArray(value) ? value.map((item) => [null, item]) : Object.entries(value);
      for (const [key, item] of entries) {
        if (key !== null && !TOKEN.test(key)) {
          return `${state.label} keys must be 1-32 letters, digits, or _ . : -`;
        }
        const error = walk(item, depth + 1, state);
        if (error) return error;
      }
      return null;
    }
    state.scalars += 1;
    if (state.scalars > MAX_SCALARS) return `${state.label} must hold at most ${MAX_SCALARS} values.`;
    if (typeof value === "string") {
      return TOKEN.test(value) ? null : `${state.label} strings must be 1-32 letters, digits, or _ . : - (no free text).`;
    }
    if (typeof value === "number") {
      return Number.isFinite(value) ? null : `${state.label} numbers must be finite.`;
    }
    if (typeof value === "boolean" || value === null) return null;
    return `${state.label} must be JSON.`;
  }
  function payloadError(value, maxBytes, label) {
    if (!isPlainObject2(value)) return `${label} must be a JSON object.`;
    const error = walk(value, 1, { scalars: 0, label });
    if (error) return error;
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maxBytes) {
      return `${label} must be ${maxBytes} bytes or smaller.`;
    }
    return null;
  }
  function idsOf(value) {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_IDS) return null;
    const ids = /* @__PURE__ */ new Set();
    for (const entry of value) {
      if (typeof entry !== "string" || !UUID.test(entry)) return null;
      ids.add(entry.toLowerCase());
    }
    return ids;
  }
  function limitOf(value) {
    if (value === void 0 || value === null) return DEFAULT_LIMIT;
    return Number.isInteger(value) && value >= 1 && value <= MAX_LIMIT ? value : null;
  }
  function uuid() {
    const crypto = globalThis.crypto;
    if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
    const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join(
      ""
    );
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
  }
  function invalid(message) {
    return failure(CODES.invalidParams, message);
  }
  function copy(value) {
    return value === null || value === void 0 ? value : JSON.parse(JSON.stringify(value));
  }
  function pageOf(items, limit, cursor) {
    let start = 0;
    if (cursor !== void 0 && cursor !== null) {
      const at = typeof cursor === "string" ? items.findIndex((item) => item.id === cursor) : -1;
      if (at === -1) return null;
      start = at + 1;
    }
    const page = items.slice(start, start + limit);
    const nextCursor = start + limit < items.length && page.length > 0 ? page.at(-1).id : null;
    return { page, nextCursor };
  }
  function createMockSocial({ config, selfId, isKnownPlayer, now = () => Date.now() }) {
    let messages = [];
    let trades = [];
    const blocked = /* @__PURE__ */ new Set();
    const iso = (ms) => new Date(ms).toISOString();
    function deliver(from, kind, payload) {
      if (blocked.has(from)) return;
      messages.push({
        id: uuid(),
        from,
        kind,
        payload: copy(payload),
        createdAt: iso(now()),
        readAt: null,
        removed: false
      });
    }
    function visibleMessages() {
      return messages.filter((message) => !message.removed && !blocked.has(message.from)).reverse();
    }
    function messageWire({ removed: _removed, ...message }) {
      return copy(message);
    }
    function send({ to, kind, payload }) {
      if (typeof to !== "string" || !to) return invalid("Invalid recipient.");
      if (to === selfId()) return invalid("Cannot send a message to yourself.");
      if (!isKnownPlayer(to)) return invalid("No player with that id.");
      if (typeof kind !== "string" || !KEY.test(kind)) return invalid("Invalid kind.");
      const error = payloadError(payload, INBOX_MAX_BYTES, "Inbox payload");
      if (error) return invalid(error);
      deliver(to, kind, payload);
      return ok(true);
    }
    function list({ unreadOnly, limit, cursor }) {
      const size = limitOf(limit);
      if (size === null) return invalid("Invalid limit.");
      const visible = visibleMessages();
      const filtered = unreadOnly === true ? visible.filter((message) => !message.readAt) : visible;
      const found = pageOf(filtered, size, cursor);
      if (!found) return invalid("Invalid cursor.");
      return ok({
        messages: found.page.map(messageWire),
        unreadCount: visible.filter((message) => !message.readAt).length,
        nextCursor: found.nextCursor
      });
    }
    function updateMessages(rawIds, apply) {
      const ids = idsOf(rawIds);
      if (!ids) return invalid("ids must be 1 to 50 message ids.");
      let updated = 0;
      for (const message of visibleMessages()) {
        if (ids.has(message.id.toLowerCase()) && apply(message)) updated += 1;
      }
      return ok(updated);
    }
    const markRead = ({ ids }) => updateMessages(ids, (message) => {
      if (message.readAt) return false;
      message.readAt = iso(now());
      return true;
    });
    const removeMessages = ({ ids }) => updateMessages(ids, (message) => {
      message.removed = true;
      return true;
    });
    function reportMessage({ messageId }) {
      if (!config.signedIn) return failure(CODES.signInRequired, "Reporting requires sign-in.");
      const target = visibleMessages().find((message) => message.id === messageId);
      if (!target) return invalid("No message for that id.");
      if (config.confirmInboxReport !== true) return ok(false);
      blocked.add(target.from);
      return ok(true);
    }
    function expireDue() {
      const at = now();
      for (const trade of trades) {
        if (trade.status === "open" && Date.parse(trade.expiresAt) <= at) {
          trade.status = "expired";
          trade.settledAt = trade.expiresAt;
        }
      }
    }
    function tradeWire(trade) {
      const { ackedBy: _ackedBy, operationId: _operationId, ...wire } = trade;
      const party = trade.from === selfId() || trade.taker === selfId();
      return copy({ ...wire, give: party ? trade.give : null });
    }
    function openTrade(from, { offer, want, offerKey, wantKey, to, expiresInSec, operationId }) {
      const createdAt = now();
      const trade = {
        id: uuid(),
        from,
        to: to ?? null,
        taker: null,
        offer: copy(offer),
        want: copy(want),
        offerKey: offerKey ?? null,
        wantKey: wantKey ?? null,
        give: null,
        status: "open",
        createdAt: iso(createdAt),
        expiresAt: iso(createdAt + (expiresInSec ?? DEFAULT_EXPIRES_IN_SEC) * 1e3),
        settledAt: null,
        ackedBy: /* @__PURE__ */ new Set(),
        operationId: operationId ?? null
      };
      trades.push(trade);
      return trade;
    }
    function tradeOptionsError(p) {
      const offerError = payloadError(p.offer, OFFER_MAX_BYTES, "Trade offer");
      if (offerError) return offerError;
      const wantError = payloadError(p.want, WANT_MAX_BYTES, "Trade want");
      if (wantError) return wantError;
      for (const name of ["offerKey", "wantKey"]) {
        const value = p[name];
        if (value !== void 0 && value !== null && (typeof value !== "string" || !KEY.test(value))) {
          return `Invalid ${name}.`;
        }
      }
      const seconds = p.expiresInSec;
      if (seconds !== void 0 && seconds !== null && !(Number.isInteger(seconds) && seconds >= MIN_EXPIRES_IN_SEC && seconds <= MAX_EXPIRES_IN_SEC)) {
        return "Invalid expiresInSec.";
      }
      return null;
    }
    function create(p) {
      const error = tradeOptionsError(p);
      if (error) return invalid(error);
      if (typeof p.operationId !== "string" || !OPERATION_ID.test(p.operationId)) {
        return invalid("Invalid operationId.");
      }
      const self = selfId();
      if (p.to !== void 0 && p.to !== null) {
        if (typeof p.to !== "string" || !p.to) return invalid("Invalid recipient.");
        if (p.to === self) return invalid("Cannot offer a trade to yourself.");
        if (!isKnownPlayer(p.to)) return invalid("No player with that id.");
      }
      const existing = trades.find(
        (trade) => trade.from === self && trade.operationId === p.operationId
      );
      if (existing) return ok(tradeWire(existing));
      expireDue();
      const open = trades.filter((trade) => trade.from === self && trade.status === "open");
      if (open.length >= MAX_OPEN_TRADES) {
        return failure(CODES.invalidParams, "Too many open trades. Cancel an open trade first.");
      }
      return ok(tradeWire(openTrade(self, p)));
    }
    function listTrades({ offerKey, wantKey, limit, cursor }) {
      const size = limitOf(limit);
      if (size === null) return invalid("Invalid limit.");
      expireDue();
      const self = selfId();
      const visible = trades.filter(
        (trade) => trade.status === "open" && trade.from !== self && (trade.to === null || trade.to === self) && !blocked.has(trade.from) && (offerKey === void 0 || offerKey === null || trade.offerKey === offerKey) && (wantKey === void 0 || wantKey === null || trade.wantKey === wantKey)
      ).reverse();
      const found = pageOf(visible, size, cursor);
      if (!found) return invalid("Invalid cursor.");
      return ok({ trades: found.page.map(tradeWire), nextCursor: found.nextCursor });
    }
    function pendingOf(trade, self) {
      if (trade.status === "open" || trade.ackedBy.has(self)) return null;
      if (trade.from === self) {
        return {
          ...tradeWire(trade),
          role: "offerer",
          action: trade.status === "matched" ? "receiveGive" : "returnOffer"
        };
      }
      if (trade.taker === self) return { ...tradeWire(trade), role: "taker", action: "receiveOffer" };
      return null;
    }
    function mine() {
      expireDue();
      const self = selfId();
      const open = trades.filter((trade) => trade.from === self && trade.status === "open").reverse().map(tradeWire);
      const pending = trades.map((trade) => pendingOf(trade, self)).filter((trade) => trade !== null).sort((a, b) => Date.parse(a.settledAt) - Date.parse(b.settledAt)).slice(0, PENDING_LIMIT);
      return ok({ open, pending });
    }
    function settle(tradeId, give, taker) {
      expireDue();
      const trade = trades.find((entry) => entry.id === tradeId);
      if (!trade || trade.from === taker || trade.to !== null && trade.to !== taker || blocked.has(trade.from)) {
        return { outcome: "notFound" };
      }
      if (trade.status === "matched") {
        return trade.taker === taker ? { outcome: "matched", trade } : { outcome: "taken" };
      }
      if (trade.status !== "open") return { outcome: trade.status };
      trade.taker = taker;
      trade.give = copy(give);
      trade.status = "matched";
      trade.settledAt = iso(now());
      return { outcome: "matched", trade };
    }
    function accept({ tradeId, give }) {
      if (typeof tradeId !== "string" || !tradeId) return invalid("Invalid tradeId.");
      const error = payloadError(give, GIVE_MAX_BYTES, "Trade give");
      if (error) return invalid(error);
      const settled = settle(tradeId, give, selfId());
      return ok(
        settled.trade ? { outcome: settled.outcome, trade: tradeWire(settled.trade) } : { outcome: settled.outcome, trade: null }
      );
    }
    function cancel({ tradeId }) {
      expireDue();
      const trade = trades.find((entry) => entry.id === tradeId && entry.from === selfId());
      if (!trade) return invalid("No trade of yours for that id.");
      if (trade.status === "open") {
        trade.status = "cancelled";
        trade.settledAt = iso(now());
      }
      return ok(tradeWire(trade));
    }
    function ack({ ids: rawIds }) {
      const ids = idsOf(rawIds);
      if (!ids) return invalid("ids must be 1 to 50 trade ids.");
      expireDue();
      const self = selfId();
      let acked = 0;
      for (const trade of trades) {
        if (!ids.has(trade.id.toLowerCase()) || !pendingOf(trade, self)) continue;
        trade.ackedBy.add(self);
        acked += 1;
      }
      return ok(acked);
    }
    function reportTrade({ tradeId }) {
      if (!config.signedIn) return failure(CODES.signInRequired, "Reporting requires sign-in.");
      expireDue();
      const self = selfId();
      const trade = trades.find((entry) => entry.id === tradeId);
      const listed = trade && trade.status === "open" && trade.from !== self && (trade.to === null || trade.to === self);
      if (!trade || !(listed || trade.taker === self)) return invalid("No trade for that id.");
      if (config.confirmTradeReport !== true) return ok(false);
      blocked.add(trade.from);
      return ok(true);
    }
    function seed() {
      messages = [];
      trades = [];
      blocked.clear();
      deliver(MOCK_RIVALS[0], "challenge", { stage: 3, score: 1200 });
      openTrade(MOCK_RIVALS[0], {
        offer: { item: "sword", count: 1 },
        want: { item: "gem", count: 3 },
        offerKey: "sword",
        wantKey: "gem"
      });
      openTrade(MOCK_RIVALS[1], {
        offer: { item: "shield", count: 1 },
        want: { item: "coin", count: 100 },
        offerKey: "shield",
        wantKey: "coin"
      });
    }
    seed();
    const controls = {
      receiveInbox(from, kind, payload) {
        if (typeof from !== "string" || !from || from === selfId()) return false;
        if (typeof kind !== "string" || !KEY.test(kind)) return false;
        if (payloadError(payload, INBOX_MAX_BYTES, "Inbox payload")) return false;
        if (blocked.has(from)) return false;
        deliver(from, kind, payload);
        return true;
      },
      offerTrade(from, offer, want, options = {}) {
        const opts = options ?? {};
        if (typeof from !== "string" || !from || from === selfId()) return null;
        if (tradeOptionsError({ ...opts, offer, want })) return null;
        const to = opts.toSelf === true ? selfId() : null;
        return tradeWire(openTrade(from, { ...opts, offer, want, to, operationId: null }));
      },
      acceptTrade(tradeId, give, by = MOCK_RIVALS[0]) {
        if (typeof by !== "string" || !by || by === selfId()) return "notFound";
        if (payloadError(give, GIVE_MAX_BYTES, "Trade give")) return "notFound";
        const trade = trades.find((entry) => entry.id === tradeId);
        if (!trade || trade.from !== selfId()) return "notFound";
        return settle(tradeId, give, by).outcome;
      },
      expireTrade(tradeId) {
        const trade = trades.find((entry) => entry.id === tradeId && entry.status === "open");
        if (!trade) return false;
        trade.expiresAt = iso(now());
        expireDue();
        return true;
      }
    };
    return {
      controls,
      reset: seed,
      handlers: {
        send,
        list,
        markRead,
        removeMessages,
        reportMessage,
        create,
        listTrades,
        mine,
        accept,
        cancel,
        ack,
        reportTrade
      }
    };
  }

  // src/backend-mock.js
  var MANIFEST_TIMEOUT_MS = 3e3;
  var MOCK_ANALYTICS_MAX_EVENTS = 200;
  var MOCK_PROTOCOL_VERSION = 10;
  var STORAGE_KEY = "grush-sdk-mock";
  var SLOT_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
  var PLAYER_STATE_MAX_BYTES = 4 * 1024;
  var SAMPLE_DEFAULT_COUNT = 10;
  var SAMPLE_MAX_COUNT = 20;
  var RATING_LIMIT = 1e9;
  var RIVAL_RATINGS = [1e3, 1200, 1500];
  var CLOUD_SAVE_MAX_BYTES = 256 * 1024;
  var OPAQUE_STRING_MIN_LENGTH = 256;
  var LOCALE_FALLBACK = "ja";
  var BASE64_LIKE = /^[A-Za-z0-9+/\-_]+={0,2}$/;
  function containsOpaqueString(value) {
    if (typeof value === "string") {
      return value.length >= OPAQUE_STRING_MIN_LENGTH && BASE64_LIKE.test(value);
    }
    if (Array.isArray(value)) return value.some(containsOpaqueString);
    if (value && typeof value === "object") return Object.values(value).some(containsOpaqueString);
    return false;
  }
  function mockLaunch(config) {
    const params = config.launchParams;
    if (!params || typeof params !== "object") return { params: {} };
    return {
      params: Object.fromEntries(
        Object.entries(params).filter(([, value]) => typeof value === "string")
      )
    };
  }
  var SHARE_LAUNCH_KEY = /^[A-Za-z0-9_-]{1,32}$/;
  var SHARE_LAUNCH_VALUE = /^[A-Za-z0-9._~:,-]{0,128}$/;
  var SHARE_LAUNCH_MAX_PARAMS = 8;
  function shareLaunchParamsValid(value) {
    if (value === void 0 || value === null) return true;
    if (typeof value !== "object" || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    const keys = Object.keys(value);
    if (Reflect.ownKeys(value).length !== keys.length) return false;
    if (keys.length > SHARE_LAUNCH_MAX_PARAMS) return false;
    return keys.every(
      (key) => SHARE_LAUNCH_KEY.test(key) && key !== "__proto__" && typeof value[key] === "string" && SHARE_LAUNCH_VALUE.test(value[key])
    );
  }
  function deviceLanguages() {
    const list = globalThis.navigator?.languages;
    const single = globalThis.navigator?.language;
    const tags = Array.isArray(list) ? list : [single];
    return tags.filter((tag) => typeof tag === "string" && tag);
  }
  function mockLocale(config) {
    const device = deviceLanguages();
    if (typeof config.locale === "string" && config.locale) {
      const languages = [config.locale, ...device.filter((tag) => tag !== config.locale)];
      return { locale: config.locale, source: "user", languages };
    }
    return {
      locale: device[0] ?? LOCALE_FALLBACK,
      source: "device",
      languages: device.length ? device : [LOCALE_FALLBACK]
    };
  }
  function defaultMockConfig() {
    return {
      signedIn: true,
      displayName: "Local Player",
      avatarUrl: null,
      grantProfileConsent: true,
      confirmPlayerStateReport: true,
      confirmInboxReport: true,
      confirmTradeReport: true,
      unreliableDropRate: 0,
      maxPeers: 8,
      shareAvailable: true,
      shareStatus: "opened",
      locale: null,
      launchParams: {}
    };
  }
  var memoryStore = null;
  function readStored() {
    if (memoryStore) return memoryStore;
    try {
      const parsed = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? "{}");
      memoryStore = parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      memoryStore = {};
    }
    return memoryStore;
  }
  function writeStored(patch) {
    memoryStore = { ...readStored(), ...patch };
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(memoryStore));
    } catch {
    }
  }
  function localPseudoId() {
    const stored = readStored().pseudoId;
    if (typeof stored === "string" && stored) return stored;
    const created = `mock-local-${Math.random().toString(36).slice(2, 12)}`;
    writeStored({ pseudoId: created });
    return created;
  }
  function jsonBytes(value) {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  }
  function snapshot(result) {
    if (!result.ok || !result.value || typeof result.value !== "object" || result.value.source) {
      return result;
    }
    return { ...result, value: structuredClone(result.value) };
  }
  function invalid2(message) {
    return failure(CODES.invalidParams, message);
  }
  function fallbackOf(value) {
    if (value === void 0 || value === null) return { ok: true, local: false };
    if (value === "local") return { ok: true, local: true };
    return { ok: false };
  }
  function isRating(value) {
    return typeof value === "number" && Number.isFinite(value) && value > -RATING_LIMIT && value < RATING_LIMIT;
  }
  function shuffled(items) {
    const copy2 = [...items];
    for (let index = copy2.length - 1; index > 0; index -= 1) {
      const other = Math.floor(Math.random() * (index + 1));
      [copy2[index], copy2[other]] = [copy2[other], copy2[index]];
    }
    return copy2;
  }
  function stateWire({ hidden: _hidden, ...state }) {
    return state;
  }
  function isPlainObject3(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }
  function createMockPreview() {
    let pending = null;
    let handler = null;
    let token = null;
    let scheduled = false;
    function deliver() {
      scheduled = false;
      if (!handler || pending === null) return;
      const json = pending;
      pending = null;
      try {
        handler(JSON.parse(json));
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
    function schedule() {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(deliver);
    }
    return {
      show(json) {
        pending = json;
        schedule();
      },
      onPreview(next) {
        const own = {};
        handler = next;
        token = own;
        schedule();
        return () => {
          if (token !== own) return;
          handler = null;
          token = null;
        };
      },
      reset() {
        pending = null;
      }
    };
  }
  function createMockBackend(config) {
    const otherStates = /* @__PURE__ */ new Map();
    const cloudSaves = /* @__PURE__ */ new Map();
    const localSaves = /* @__PURE__ */ new Map();
    let analyticsEvents = [];
    const analyticsWarned = /* @__PURE__ */ new Set();
    let myState = null;
    const preview = createMockPreview();
    function previewPlayerState(pseudoId, payload, options) {
      const extra = options ?? {};
      if (typeof pseudoId !== "string" || !pseudoId) return false;
      if (!isPlainObject3(payload)) return false;
      const rating = extra.rating ?? null;
      if (rating !== null && !isRating(rating)) return false;
      const revision = extra.revision ?? 1;
      if (!Number.isInteger(revision) || revision < 0) return false;
      let json;
      try {
        json = JSON.stringify({
          pseudoId,
          payload,
          revision,
          rating,
          updatedAt: (/* @__PURE__ */ new Date()).toISOString()
        });
      } catch {
        return false;
      }
      preview.show(json);
      return true;
    }
    function putState(pseudoId, payload, options) {
      otherStates.set(pseudoId, {
        pseudoId,
        payload,
        revision: 1,
        rating: isRating(options.rating) ? options.rating : null,
        updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
        hidden: options.hidden === true
      });
    }
    function seedRivals() {
      MOCK_RIVALS.forEach((pseudoId, index) => {
        putState(pseudoId, { level: (index + 1) * 5 }, { rating: RIVAL_RATINGS[index] });
      });
    }
    seedRivals();
    const social = createMockSocial({
      config,
      selfId: () => localPseudoId(),
      isKnownPlayer: (pseudoId) => otherStates.has(pseudoId)
    });
    const consented = () => config.signedIn && readStored().consent === true;
    function playerWire() {
      return {
        pseudoId: localPseudoId(),
        isGuest: !config.signedIn,
        profileConsent: consented(),
        profile: { displayName: config.displayName, avatarUrl: config.avatarUrl }
      };
    }
    function localPeerWire(index) {
      return {
        index,
        pseudoId: localPseudoId(),
        displayName: consented() ? config.displayName : null,
        avatarUrl: consented() ? config.avatarUrl : null
      };
    }
    const net = createMockNet(config, localPeerWire);
    const leaderboards = createMockLeaderboards(() => {
      const { index: _index, ...identity } = localPeerWire(-1);
      return { ...identity, isGuest: !config.signedIn };
    });
    let manifestRead = null;
    let manifestGeneration = 0;
    async function readManifestFile(generation) {
      const location = globalThis.location;
      if (typeof globalThis.fetch !== "function" || !location?.href || location.protocol === "file:") {
        return;
      }
      const controller = new AbortController();
      let timer;
      const deadline = new Promise((_, reject2) => {
        timer = setTimeout(() => {
          controller.abort();
          reject2(new Error("grush.json took too long."));
        }, MANIFEST_TIMEOUT_MS);
      });
      let bytes;
      try {
        const response = await Promise.race([
          globalThis.fetch(new URL(MANIFEST_PATH, location.href), {
            cache: "no-store",
            signal: controller.signal
          }),
          deadline
        ]);
        if (!response.ok || (response.headers?.get("content-type") ?? "").includes("text/html")) {
          return;
        }
        bytes = new Uint8Array(await Promise.race([response.arrayBuffer(), deadline]));
      } catch {
        return;
      } finally {
        clearTimeout(timer);
      }
      if (generation !== manifestGeneration) return;
      const parsed = parseLeaderboardManifest(bytes);
      if (!parsed.ok) {
        globalThis.console?.warn?.(`[GRush mock] ${parsed.error}`);
        return;
      }
      leaderboards.load(parsed.leaderboards, true);
    }
    function manifestReady() {
      manifestRead ?? (manifestRead = readManifestFile(manifestGeneration));
      return manifestRead;
    }
    function loadLeaderboards(manifest) {
      manifestGeneration += 1;
      manifestRead = Promise.resolve();
      const parsed = parseLeaderboardManifest(manifest);
      if (!parsed.ok) return invalid2(parsed.error);
      return ok(leaderboards.load(parsed.leaderboards, false));
    }
    function requestProfile() {
      if (!config.signedIn) {
        return failure(CODES.signInRequired, "The player is a guest and has no profile.");
      }
      if (!config.grantProfileConsent) {
        return failure(CODES.consentDeclined, "The player declined to share their profile.");
      }
      writeStored({ consent: true });
      return ok(playerWire());
    }
    function setMine(params) {
      const { payload, baseRevision } = params;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return invalid2("Player state payload must be a JSON object.");
      }
      if (jsonBytes(payload) > PLAYER_STATE_MAX_BYTES) return invalid2("Player state is too large.");
      if (containsOpaqueString(payload)) {
        return invalid2("Player state must not contain opaque encoded strings.");
      }
      const ratingGiven = "rating" in params && params.rating !== void 0;
      if (ratingGiven && params.rating !== null && !isRating(params.rating)) {
        return invalid2("Invalid rating.");
      }
      const current = myState ? myState.revision : 0;
      if (typeof baseRevision === "number" && baseRevision !== current) {
        return failure(CODES.invalidParams, "Player state was updated elsewhere.");
      }
      myState = {
        pseudoId: localPseudoId(),
        payload: structuredClone(payload),
        revision: current + 1,
        rating: ratingGiven ? params.rating : myState?.rating ?? null,
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      return ok(myState);
    }
    function getMany({ pseudoIds }) {
      if (!Array.isArray(pseudoIds) || pseudoIds.length === 0 || pseudoIds.length > 50) {
        return invalid2("pseudoIds must be an array of at most 50 ids.");
      }
      const states = pseudoIds.map((id) => otherStates.get(id)).filter((state) => state && !state.hidden).map(stateWire);
      return ok(states);
    }
    function sample({ count, minRating, maxRating }) {
      let size = SAMPLE_DEFAULT_COUNT;
      if (count !== void 0 && count !== null) {
        if (!Number.isInteger(count) || count < 1 || count > SAMPLE_MAX_COUNT) {
          return invalid2(`count must be an integer from 1 to ${SAMPLE_MAX_COUNT}.`);
        }
        size = count;
      }
      const minGiven = minRating !== void 0 && minRating !== null;
      const maxGiven = maxRating !== void 0 && maxRating !== null;
      if (minGiven !== maxGiven) return invalid2("minRating and maxRating must be given together.");
      if (minGiven && (!isRating(minRating) || !isRating(maxRating))) {
        return invalid2("Invalid rating range.");
      }
      if (minGiven && minRating > maxRating) return invalid2("minRating must not exceed maxRating.");
      const self = localPseudoId();
      const candidates = [...otherStates.values()].filter(
        (state) => !state.hidden && state.pseudoId !== self && (!minGiven || state.rating !== null && state.rating >= minRating && state.rating <= maxRating)
      );
      return ok(shuffled(candidates).slice(0, size).map(stateWire));
    }
    function saveCloud({ payload, slot, baseRevision, fallback }) {
      const key = slot || "default";
      if (!SLOT_PATTERN.test(key)) return invalid2("Invalid cloud save slot.");
      if (payload === void 0 || payload === null)
        return invalid2("Cloud save payload is required.");
      if (jsonBytes(payload) > CLOUD_SAVE_MAX_BYTES)
        return invalid2("Cloud save payload is too large.");
      const mode = fallbackOf(fallback);
      if (!mode.ok) return invalid2("Invalid cloud save fallback.");
      if (!config.signedIn) {
        if (!mode.local) return failure(CODES.signInRequired, "Cloud save requires sign-in.");
        const now2 = (/* @__PURE__ */ new Date()).toISOString();
        const previous = localSaves.get(key);
        const save2 = {
          slot: key,
          payload: structuredClone(payload),
          revision: 0,
          createdAt: previous ? previous.createdAt : now2,
          updatedAt: now2,
          storage: "local"
        };
        localSaves.set(key, save2);
        return ok(save2);
      }
      const current = cloudSaves.get(key);
      const revision = current ? current.revision : 0;
      if (typeof baseRevision === "number" && baseRevision !== revision) {
        return failure(CODES.conflict, "Cloud save was updated elsewhere.");
      }
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const save = {
        slot: key,
        payload: structuredClone(payload),
        revision: revision + 1,
        createdAt: current ? current.createdAt : now,
        updatedAt: now
      };
      cloudSaves.set(key, save);
      if (mode.local) localSaves.delete(key);
      return ok(save);
    }
    function loadCloud({ slot, fallback }) {
      const key = slot || "default";
      if (!SLOT_PATTERN.test(key)) return invalid2("Invalid cloud save slot.");
      const mode = fallbackOf(fallback);
      if (!mode.ok) return invalid2("Invalid cloud save fallback.");
      if (!config.signedIn) {
        if (!mode.local) return failure(CODES.signInRequired, "Cloud save requires sign-in.");
        return ok(localSaves.get(key) ?? null);
      }
      const save = cloudSaves.get(key);
      if (save) return ok(save);
      return ok(mode.local ? localSaves.get(key) ?? null : null);
    }
    function removeCloud({ slot, fallback }) {
      const key = slot || "default";
      if (!SLOT_PATTERN.test(key)) return invalid2("Invalid cloud save slot.");
      const mode = fallbackOf(fallback);
      if (!mode.ok) return invalid2("Invalid cloud save fallback.");
      if (!config.signedIn && !mode.local) {
        return failure(CODES.signInRequired, "Cloud save requires sign-in.");
      }
      if (config.signedIn) cloudSaves.delete(key);
      if (mode.local) localSaves.delete(key);
      return ok(true);
    }
    function logAnalytics(kind, params) {
      const result = sanitizeAnalyticsEvent({ ...params, kind });
      if (!result.ok) {
        if (!analyticsWarned.has(result.reason)) {
          analyticsWarned.add(result.reason);
          globalThis.console?.warn?.(`[GRush mock] analytics event rejected (${result.reason}).`);
        }
        return false;
      }
      analyticsEvents.push(result.event);
      if (analyticsEvents.length > MOCK_ANALYTICS_MAX_EVENTS) {
        analyticsEvents = analyticsEvents.slice(-MOCK_ANALYTICS_MAX_EVENTS);
      }
      globalThis.console?.info?.(`[GRush mock] analytics ${JSON.stringify(result.event)}`);
      return true;
    }
    function fromBoard(outcome, pick) {
      return outcome.error ? invalid2(outcome.error) : ok(pick(outcome));
    }
    const handlers = {
      "player.getSelf": () => ok(playerWire()),
      "player.requestProfile": requestProfile,
      "player.revokeProfile": () => {
        writeStored({ consent: false });
        return ok(playerWire());
      },
      "leaderboard.list": () => ok(leaderboards.list()),
      "leaderboard.submit": (p) => fromBoard(leaderboards.submit(p.key, p.value, p.metadata), (o) => o.result),
      "leaderboard.top": (p) => fromBoard(leaderboards.page(p.key, p, false), (o) => o.page),
      "leaderboard.aroundMe": (p) => fromBoard(leaderboards.page(p.key, p, true), (o) => o.page),
      "leaderboard.friends": () => failure(CODES.consentDeclined, "Friend leaderboards require per-game friend consent."),
      "playerState.getMine": () => ok(myState),
      "playerState.setMine": setMine,
      "playerState.get": getMany,
      "playerState.report": (p) => {
        if (!config.signedIn) return failure(CODES.signInRequired, "Reporting requires sign-in.");
        const target = otherStates.get(p.pseudoId);
        if (!target || target.hidden) return invalid2("No player state for that id.");
        return ok(config.confirmPlayerStateReport === true);
      },
      "playerState.sample": sample,
      "inbox.send": social.handlers.send,
      "inbox.list": social.handlers.list,
      "inbox.markRead": social.handlers.markRead,
      "inbox.remove": social.handlers.removeMessages,
      "inbox.report": social.handlers.reportMessage,
      "trade.create": social.handlers.create,
      "trade.list": social.handlers.listTrades,
      "trade.mine": social.handlers.mine,
      "trade.accept": social.handlers.accept,
      "trade.cancel": social.handlers.cancel,
      "trade.ack": social.handlers.ack,
      "trade.report": social.handlers.reportTrade,
      "cloudSave.load": loadCloud,
      "cloudSave.save": saveCloud,
      "cloudSave.remove": removeCloud,
      "share.open": (p) => {
        if (!shareLaunchParamsValid(p.launchParams)) {
          return failure(CODES.invalidParams, "Invalid launch params.");
        }
        if (!config.shareAvailable) return failure(CODES.unavailable, "Sharing is unavailable here.");
        return ok({ status: config.shareStatus === "cancelled" ? "cancelled" : "opened" });
      },
      "share.getAvailability": () => ok(config.shareAvailable === true),
      "locale.get": () => ok(mockLocale(config)),
      "launch.get": () => ok(mockLaunch(config)),
      "net.join": (p) => {
        const joined = net.join(p);
        if (joined === null) return failure(CODES.internal, "Failed to join a room.");
        return ok(joined);
      }
    };
    const controls = {
      config,
      defineLeaderboard: (key, options) => leaderboards.define(key, options),
      loadLeaderboards,
      addRival: (key, displayName, value, options) => leaderboards.addRival(key, displayName, value, options),
      definePlayerState: (pseudoId, payload, options) => putState(pseudoId, structuredClone(payload), options ?? {}),
      previewPlayerState,
      rivals: MOCK_RIVALS,
      receiveInbox: social.controls.receiveInbox,
      offerTrade: social.controls.offerTrade,
      acceptTrade: social.controls.acceptTrade,
      expireTrade: social.controls.expireTrade,
      addPeer: (displayName, avatarUrl) => net.addPeer(displayName, avatarUrl),
      removePeer: (peer) => net.removePeer(peer),
      raiseRoomError: (code, message) => net.raiseError(code, message),
      analyticsEvents: () => structuredClone(analyticsEvents),
      reset() {
        leaderboards.reset();
        manifestGeneration += 1;
        manifestRead = null;
        otherStates.clear();
        seedRivals();
        social.reset();
        cloudSaves.clear();
        localSaves.clear();
        analyticsEvents = [];
        analyticsWarned.clear();
        myState = null;
        preview.reset();
        net.reset();
        Object.assign(config, defaultMockConfig());
        writeStored({ consent: false });
      }
    };
    return {
      kind: "mock",
      controls,
      isAvailable: () => true,
      protocolVersion: () => MOCK_PROTOCOL_VERSION,
      localeCurrent: () => mockLocale(config),
      localeOnChange: () => () => {
      },
      playerStateOnPreview: (handler) => preview.onPreview(handler),
      launchCurrent: () => mockLaunch(config),
      analyticsAvailable: () => true,
      logAnalytics,
      async call(method, params = {}) {
        const handler = handlers[method];
        if (!handler) return failure(CODES.unsupported, `The mock does not implement ${method}.`);
        if (method.startsWith("leaderboard.")) await manifestReady();
        await new Promise((resolve) => setTimeout(resolve, 0));
        try {
          return snapshot(handler(params ?? {}));
        } catch (error) {
          return invalid2(error instanceof Error ? error.message : "The mock rejected the call.");
        }
      }
    };
  }

  // src/backend-web.js
  function runtimeApi(name) {
    return globalThis[`GRush${name}`] ?? globalThis[`GameRush${name}`] ?? null;
  }
  function isRuntimePresent() {
    return runtimeApi("Info") !== null && runtimeApi("Player") !== null;
  }
  function describeRoom(room) {
    if (typeof room.describe === "function") return room.describe();
    return {
      roomId: room.roomId,
      roomCode: room.roomCode,
      epoch: room.roomEpoch,
      localPeerIndex: room.localPeerId,
      hostIndex: room.hostPeerId,
      peers: room.peers,
      transport: room.stats ? room.stats.transport : "ws",
      serverTimeMs: typeof room.serverTimeMs === "function" ? room.serverTimeMs() : Date.now()
    };
  }
  function roomSourceOf(room) {
    return {
      on: (name, handler) => room.on(name, handler),
      send: (bytes, options) => room.send(bytes, options),
      leave: () => room.leave()
    };
  }
  var INVOKERS = {
    "player.getSelf": (apis) => apis.Player?.getSelf(),
    "player.requestProfile": (apis) => apis.Player?.requestProfile(),
    "player.revokeProfile": (apis) => apis.Player?.revokeProfile(),
    "leaderboard.list": (apis) => apis.Leaderboards?.list(),
    "leaderboard.submit": (apis, p) => apis.Leaderboards?.submit(p.key, p.value, p.metadata, p.operationId),
    "leaderboard.top": (apis, p) => apis.Leaderboards?.top(p.key, p),
    "leaderboard.aroundMe": (apis, p) => apis.Leaderboards?.aroundMe(p.key, p),
    "leaderboard.friends": (apis, p) => apis.Leaderboards?.friends(p.key, p),
    "playerState.getMine": (apis) => apis.PlayerState?.getMine(),
    // `rating` is in the params only when the runtime is new enough to read it (see sdk.js).
    "playerState.setMine": (apis, p) => "rating" in p ? apis.PlayerState?.setMine(p.payload, p.baseRevision, { rating: p.rating }) : apis.PlayerState?.setMine(p.payload, p.baseRevision),
    "playerState.get": (apis, p) => apis.PlayerState?.get(p.pseudoIds),
    "playerState.report": (apis, p) => apis.PlayerState?.report(p.pseudoId),
    "playerState.sample": (apis, p) => apis.PlayerState?.sample?.(p),
    "inbox.send": (apis, p) => apis.Inbox?.send?.(p.to, p.kind, p.payload),
    "inbox.list": (apis, p) => apis.Inbox?.list?.(p),
    "inbox.markRead": (apis, p) => apis.Inbox?.markRead?.(p.ids),
    "inbox.remove": (apis, p) => apis.Inbox?.remove?.(p.ids),
    "inbox.report": (apis, p) => apis.Inbox?.report?.(p.messageId),
    "trade.create": (apis, p) => apis.Trade?.create?.(p),
    "trade.list": (apis, p) => apis.Trade?.list?.(p),
    "trade.mine": (apis) => apis.Trade?.mine?.(),
    "trade.accept": (apis, p) => apis.Trade?.accept?.(p.tradeId, p.give),
    "trade.cancel": (apis, p) => apis.Trade?.cancel?.(p.tradeId),
    "trade.ack": (apis, p) => apis.Trade?.ack?.(p.ids),
    "trade.report": (apis, p) => apis.Trade?.report?.(p.tradeId),
    "share.open": (apis, p) => apis.Share?.share(p),
    "share.getAvailability": (apis) => apis.Share?.isAvailable(),
    "locale.get": (apis) => apis.Locale?.get(),
    "launch.get": (apis) => apis.Launch?.get(),
    "net.join": (apis, p) => apis.Net?.join(p).then(
      (room) => room ? { source: roomSourceOf(room), info: describeRoom(room) } : null
    )
  };
  function fallbackOptions(p) {
    return "fallback" in p ? { fallback: p.fallback } : {};
  }
  var CLOUD_SAVE_INVOKERS = {
    "cloudSave.load": (api, p) => api.loadWithMetadata(p.slot, fallbackOptions(p)),
    "cloudSave.save": (api, p) => {
      const options = fallbackOptions(p);
      if (typeof p.baseRevision === "number") options.baseRevision = p.baseRevision;
      return api.save(p.payload, p.slot, options);
    },
    "cloudSave.remove": (api, p) => api.remove(p.slot, fallbackOptions(p))
  };
  function currentApis() {
    return {
      Player: runtimeApi("Player"),
      Leaderboards: runtimeApi("Leaderboards"),
      PlayerState: runtimeApi("PlayerState"),
      Net: runtimeApi("Net"),
      Share: runtimeApi("Share"),
      Locale: runtimeApi("Locale"),
      Launch: runtimeApi("Launch"),
      Inbox: runtimeApi("Inbox"),
      Trade: runtimeApi("Trade")
    };
  }
  async function callCloudSave(method, params) {
    const api = runtimeApi("CloudSave");
    if (!api) return unsupported();
    try {
      return ok(await CLOUD_SAVE_INVOKERS[method](api, params));
    } catch (error) {
      return failureFromCloudSaveError(error);
    }
  }
  function createWebBackend() {
    return {
      kind: "web",
      isAvailable: () => isRuntimePresent(),
      protocolVersion() {
        const version = runtimeApi("Info")?.protocolVersion;
        return typeof version === "number" ? version : 0;
      },
      localeCurrent: () => runtimeApi("Locale")?.current?.() ?? null,
      localeOnChange(handler) {
        const unsubscribe = runtimeApi("Locale")?.onChange?.(handler);
        return typeof unsubscribe === "function" ? unsubscribe : () => {
        };
      },
      // The runtime holds one handler and replaces it on the next call, so sdk.js registers only once.
      playerStateOnPreview(handler) {
        const unsubscribe = runtimeApi("PlayerState")?.onPreview?.(handler);
        return typeof unsubscribe === "function" ? unsubscribe : () => {
        };
      },
      launchCurrent: () => runtimeApi("Launch")?.current?.() ?? null,
      analyticsAvailable: () => runtimeApi("Analytics")?.isAvailable?.() === true,
      logAnalytics: (kind, params) => runtimeApi("Analytics")?.log?.(kind, params) === true,
      async call(method, params = {}) {
        if (method in CLOUD_SAVE_INVOKERS) return callCloudSave(method, params);
        const invoke = INVOKERS[method];
        if (!invoke) return failure("unsupported", `GameRush does not expose ${method}.`);
        try {
          const pending = invoke(currentApis(), params);
          if (pending === void 0) return unsupported();
          return ok(await pending);
        } catch (error) {
          return failureFromError(error);
        }
      }
    };
  }

  // src/normalize.js
  var text = (value, fallback = "") => typeof value === "string" ? value : fallback;
  var number = (value, fallback = 0) => typeof value === "number" ? value : fallback;
  var nullableText = (value) => typeof value === "string" ? value : null;
  function playerOf(raw) {
    if (!raw || typeof raw !== "object") return null;
    const source = raw;
    const consent = source.profileConsent === true;
    const profile = consent && source.profile && typeof source.profile === "object" ? source.profile : {};
    return {
      pseudoId: text(source.pseudoId),
      isGuest: source.isGuest !== false,
      profileConsent: consent,
      displayName: nullableText(profile.displayName),
      avatarUrl: nullableText(profile.avatarUrl)
    };
  }
  function peerOf(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    return {
      index: number(source.index, -1),
      pseudoId: text(source.pseudoId),
      displayName: nullableText(source.displayName),
      avatarUrl: nullableText(source.avatarUrl)
    };
  }
  function leaderboardDefinitionOf(raw) {
    if (!raw || typeof raw !== "object") return null;
    const source = raw;
    return {
      key: text(source.key),
      title: text(source.title),
      sort: source.sort === "asc" ? "asc" : "desc",
      valueType: text(source.valueType, "int"),
      aggregation: text(source.aggregation, "best"),
      period: text(source.period, "all_time"),
      minValue: typeof source.minValue === "number" ? source.minValue : null,
      maxValue: typeof source.maxValue === "number" ? source.maxValue : null
    };
  }
  function submitResultOf(raw) {
    if (!raw || typeof raw !== "object") return null;
    return {
      accepted: raw.accepted === true,
      updated: raw.updated === true,
      value: number(raw.value),
      rank: typeof raw.rank === "number" ? raw.rank : null,
      verified: false
    };
  }
  function entryOf(raw) {
    if (!raw || typeof raw !== "object") return null;
    const source = raw;
    return {
      rank: number(source.rank),
      pseudoId: text(source.pseudoId),
      displayName: nullableText(source.displayName),
      avatarUrl: nullableText(source.avatarUrl),
      isGuest: source.isGuest !== false,
      value: number(source.value),
      metadata: source.metadata ?? null,
      submittedAt: text(source.submittedAt),
      isSelf: source.isSelf === true
    };
  }
  function leaderboardPageOf(raw) {
    if (!raw || typeof raw !== "object") return null;
    return {
      key: text(raw.key),
      title: text(raw.title),
      sort: raw.sort === "asc" ? "asc" : "desc",
      valueType: text(raw.valueType, "int"),
      period: text(raw.period, "all_time"),
      periodKey: text(raw.periodKey),
      verified: false,
      entries: Array.isArray(raw.entries) ? raw.entries.map(entryOf).filter((entry) => entry !== null) : [],
      total: number(raw.total)
    };
  }
  function playerStateOf(raw) {
    if (!raw || typeof raw !== "object") return null;
    return {
      pseudoId: text(raw.pseudoId),
      payload: raw.payload ?? {},
      revision: number(raw.revision),
      rating: typeof raw.rating === "number" ? raw.rating : null,
      updatedAt: text(raw.updatedAt)
    };
  }
  function unwrap(raw, key) {
    return raw && typeof raw === "object" && !Array.isArray(raw) && key in raw ? raw[key] : raw;
  }
  function countOf(raw, key) {
    const value = unwrap(raw, key);
    return typeof value === "number" ? value : void 0;
  }
  function flagOf(raw, key) {
    return unwrap(raw, key) === true;
  }
  function payloadOf(raw) {
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  }
  function inboxMessageOf(raw) {
    if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !raw.id) return null;
    return {
      id: raw.id,
      from: text(raw.from),
      kind: text(raw.kind),
      payload: payloadOf(raw.payload),
      createdAt: text(raw.createdAt),
      readAt: nullableText(raw.readAt)
    };
  }
  function inboxPageOf(raw) {
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.messages)) return null;
    return {
      messages: raw.messages.map(inboxMessageOf).filter((message) => message !== null),
      unreadCount: number(raw.unreadCount),
      nextCursor: nullableText(raw.nextCursor)
    };
  }
  var TRADE_OUTCOMES = /* @__PURE__ */ new Set(["matched", "taken", "expired", "cancelled", "notFound"]);
  function tradeOf(raw) {
    if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !raw.id) return null;
    return {
      id: raw.id,
      from: nullableText(raw.from),
      to: nullableText(raw.to),
      taker: nullableText(raw.taker),
      offer: payloadOf(raw.offer),
      want: payloadOf(raw.want),
      offerKey: nullableText(raw.offerKey),
      wantKey: nullableText(raw.wantKey),
      give: raw.give && typeof raw.give === "object" && !Array.isArray(raw.give) ? raw.give : null,
      // A status this SDK does not know yet is passed through as is, so a newer GameRush still reads.
      status: text(raw.status),
      createdAt: text(raw.createdAt),
      expiresAt: text(raw.expiresAt),
      settledAt: nullableText(raw.settledAt)
    };
  }
  function pendingTradeOf(raw) {
    const trade = tradeOf(raw);
    if (!trade) return null;
    return { ...trade, role: text(raw.role), action: text(raw.action) };
  }
  function tradePageOf(raw) {
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.trades)) return null;
    return {
      trades: raw.trades.map(tradeOf).filter((trade) => trade !== null),
      nextCursor: nullableText(raw.nextCursor)
    };
  }
  function myTradesOf(raw) {
    if (!raw || typeof raw !== "object") return null;
    if (!Array.isArray(raw.open) || !Array.isArray(raw.pending)) return null;
    return {
      open: raw.open.map(tradeOf).filter((trade) => trade !== null),
      pending: raw.pending.map(pendingTradeOf).filter((trade) => trade !== null)
    };
  }
  function acceptResultOf(raw) {
    if (!raw || typeof raw !== "object" || !TRADE_OUTCOMES.has(raw.outcome)) return null;
    return { outcome: raw.outcome, trade: tradeOf(raw.trade) };
  }
  function cloudSaveOf(raw) {
    if (!raw || typeof raw !== "object") return null;
    return {
      slot: text(raw.slot, "default"),
      payload: raw.payload ?? null,
      revision: number(raw.revision),
      createdAt: text(raw.createdAt),
      updatedAt: text(raw.updatedAt),
      storage: raw.storage === "local" ? "local" : "cloud"
    };
  }
  function shareResultOf(raw) {
    if (!raw || typeof raw !== "object") return null;
    return { status: raw.status === "opened" ? "opened" : "cancelled" };
  }
  function localeOf(raw) {
    if (!raw || typeof raw !== "object") return null;
    if (typeof raw.locale !== "string" || !raw.locale) return null;
    const languages = Array.isArray(raw.languages) ? raw.languages.filter((tag) => typeof tag === "string" && tag) : [];
    return {
      locale: raw.locale,
      source: typeof raw.source === "string" && raw.source ? raw.source : "device",
      languages: languages.length ? languages : [raw.locale]
    };
  }
  function launchOf(raw) {
    if (!raw || typeof raw !== "object") return null;
    const params = raw.params;
    if (!params || typeof params !== "object" || Array.isArray(params)) return null;
    return {
      params: Object.fromEntries(
        Object.entries(params).filter(([, value]) => typeof value === "string")
      )
    };
  }

  // src/room.js
  var EVENTS = ["message", "peerjoin", "peerleave", "host", "transportchange", "error", "close"];
  function createRoom(source, info, onClosed) {
    const listeners = new Map(EVENTS.map((name) => [name, []]));
    const lastSeq = /* @__PURE__ */ new Map();
    const serverOffsetMs = (typeof info.serverTimeMs === "number" ? info.serverTimeMs : Date.now()) - Date.now();
    let peers = Array.isArray(info.peers) ? info.peers.map(peerOf) : [];
    let hostPeerId = typeof info.hostIndex === "number" ? info.hostIndex : 0;
    let transport = typeof info.transport === "string" ? info.transport : "ws";
    let closed = false;
    const unsubscribers = [];
    function emit(name, event) {
      for (const handler of listeners.get(name) ?? []) {
        try {
          handler(event);
        } catch {
        }
      }
    }
    function markClosed(reason) {
      if (closed) return;
      closed = true;
      peers = [];
      for (const unsubscribe of unsubscribers.splice(0)) {
        try {
          unsubscribe?.();
        } catch {
        }
      }
      onClosed(room);
      emit("close", { reason });
    }
    const handlers = {
      message(raw) {
        const from = typeof raw?.from === "number" ? raw.from : -1;
        const seq = typeof raw?.seq === "number" ? raw.seq : 0;
        const previous = lastSeq.get(from) ?? 0;
        if (seq > previous) lastSeq.set(from, seq);
        const payload = raw?.payload instanceof ArrayBuffer ? raw.payload : new ArrayBuffer(0);
        emit("message", {
          from,
          channel: raw?.channel === "unreliable" ? "unreliable" : "reliable",
          seq,
          payload,
          isStale: seq !== 0 && seq <= previous,
          text: () => decodeText(payload),
          json: () => decodeJson(payload)
        });
      },
      peerjoin(raw) {
        const peer = peerOf(raw);
        lastSeq.delete(peer.index);
        peers = [...peers.filter((entry) => entry.index !== peer.index), peer];
        emit("peerjoin", peer);
      },
      peerleave(raw) {
        const index = typeof raw?.index === "number" ? raw.index : -1;
        peers = peers.filter((entry) => entry.index !== index);
        lastSeq.delete(index);
        emit("peerleave", { index });
      },
      host(raw) {
        if (typeof raw?.index === "number") hostPeerId = raw.index;
        emit("host", { index: hostPeerId });
      },
      transportchange(raw) {
        if (typeof raw?.transport === "string") transport = raw.transport;
        emit("transportchange", { transport });
      },
      error(raw) {
        emit("error", {
          code: typeof raw?.code === "string" ? raw.code : "",
          message: typeof raw?.message === "string" ? raw.message : ""
        });
      },
      close(raw) {
        markClosed(typeof raw?.reason === "string" ? raw.reason : "");
      }
    };
    const room = {
      roomId: typeof info.roomId === "string" ? info.roomId : "",
      roomCode: typeof info.roomCode === "string" ? info.roomCode : "",
      roomEpoch: typeof info.epoch === "number" ? info.epoch : 0,
      localPeerId: typeof info.localPeerIndex === "number" ? info.localPeerIndex : 0,
      get peers() {
        return peers.slice();
      },
      get hostPeerId() {
        return hostPeerId;
      },
      get transport() {
        return transport;
      },
      get isClosed() {
        return closed;
      },
      isHost: () => hostPeerId === room.localPeerId,
      serverTimeMs: () => Date.now() + serverOffsetMs,
      lastSeqFrom: (peerId) => lastSeq.get(peerId) ?? 0,
      on(name, handler) {
        const list = listeners.get(name);
        if (!list || typeof handler !== "function") return () => {
        };
        list.push(handler);
        return () => {
          const current = listeners.get(name);
          const index = current.indexOf(handler);
          if (index >= 0) current.splice(index, 1);
        };
      },
      send(payload, rawOptions) {
        const options = rawOptions ?? {};
        if (closed) return failure(CODES.unavailable, "The room is already closed.");
        const bytes = toBytes(payload);
        if (!bytes) {
          return failure(
            CODES.invalidParams,
            "Payload must be an ArrayBuffer, a typed array, or a string."
          );
        }
        if (bytes.byteLength > MAX_MESSAGE_BYTES) {
          return failure(CODES.invalidParams, "Payload exceeds the 8KB message limit.");
        }
        const channel = options.channel === "unreliable" ? "unreliable" : "reliable";
        const to = typeof options.to === "number" ? options.to : -1;
        try {
          source.send(bytes, { channel, to });
          return ok(true);
        } catch (error) {
          return failureFromError(error);
        }
      },
      sendJson(value, options) {
        let encoded;
        try {
          encoded = JSON.stringify(value);
        } catch (error) {
          return failure(
            CODES.invalidParams,
            error instanceof Error ? error.message : "Value is not JSON."
          );
        }
        if (typeof encoded !== "string") return failure(CODES.invalidParams, "Value is not JSON.");
        return room.send(encoded, options);
      },
      async leave() {
        if (closed) return ok(true);
        let result = ok(true);
        try {
          await source.leave();
        } catch (error) {
          result = failureFromError(error);
        }
        markClosed("left");
        return result;
      },
      closeLocally: (reason) => markClosed(reason)
    };
    for (const name of EVENTS) {
      unsubscribers.push(source.on(name, (event) => handlers[name](event)));
    }
    return room;
  }

  // src/sdk.js
  var VERSION = "0.12.0";
  var REQUIRED_PROTOCOL_VERSION = 1;
  var PLAYER_STATE_PROTOCOL_VERSION = 2;
  var SHARE_PROTOCOL_VERSION = 3;
  var LOCALE_PROTOCOL_VERSION = 4;
  var CLOUD_SAVE_LOCAL_PROTOCOL_VERSION = 5;
  var ANALYTICS_PROTOCOL_VERSION = 6;
  var MATCHMAKING_PROTOCOL_VERSION = 7;
  var INBOX_PROTOCOL_VERSION = 7;
  var TRADE_PROTOCOL_VERSION = 7;
  var LAUNCH_PROTOCOL_VERSION = 8;
  var SHARE_LAUNCH_PROTOCOL_VERSION = 9;
  var PLAYER_STATE_PREVIEW_PROTOCOL_VERSION = 10;
  var BACKENDS = /* @__PURE__ */ new Set(["auto", "web", "mock", "none"]);
  var LOCAL_HOSTNAMES = /* @__PURE__ */ new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
  var noneBackend = {
    kind: "none",
    isAvailable: () => false,
    protocolVersion: () => 0,
    call: async () => unsupported()
  };
  function hasLaunchParams(value) {
    if (value === void 0 || value === null) return false;
    if (typeof value !== "object") return true;
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return true;
    return Reflect.ownKeys(value).length > 0;
  }
  function isLocalDevelopment() {
    const location = globalThis.location;
    if (!location) return false;
    return location.protocol === "file:" || LOCAL_HOSTNAMES.has(location.hostname);
  }
  function createGRush(options = {}) {
    const mockBackend = createMockBackend(defaultMockConfig());
    const webBackend = createWebBackend();
    let selection = BACKENDS.has(options.backend) ? options.backend : "auto";
    let currentRoom = null;
    function backend() {
      if (selection === "web") return webBackend;
      if (selection === "mock") return mockBackend;
      if (selection === "none") return noneBackend;
      if (isRuntimePresent()) return webBackend;
      return isLocalDevelopment() ? mockBackend : noneBackend;
    }
    function closeCurrentRoom(reason) {
      const previous = currentRoom;
      currentRoom = null;
      previous?.closeLocally(reason);
    }
    async function call(method, params, minProtocol = REQUIRED_PROTOCOL_VERSION) {
      const active = backend();
      if (!active.isAvailable() || active.protocolVersion() < minProtocol) return unsupported();
      return active.call(method, params);
    }
    async function mapped(method, params, pick, minProtocol) {
      const result = await call(method, params, minProtocol);
      if (!result.ok) return result;
      const value = pick(result.value);
      if (value === void 0)
        return failure(CODES.internal, `GameRush returned an unreadable ${method} result.`);
      return ok(value);
    }
    const orNull = (normalize) => (raw) => raw == null ? null : normalize(raw);
    const required = (normalize) => (raw) => normalize(raw) ?? void 0;
    const listOf = (normalize) => (raw) => Array.isArray(raw) ? raw.map(normalize).filter((item) => item !== null) : [];
    const playerCall = (method) => () => mapped(method, void 0, required(playerOf));
    const statesCall = (method, params, pick) => mapped(method, params, pick, PLAYER_STATE_PROTOCOL_VERSION);
    const player = {
      getSelf: playerCall("player.getSelf"),
      requestProfile: playerCall("player.requestProfile"),
      revokeProfile: playerCall("player.revokeProfile")
    };
    const leaderboards = {
      list: () => mapped("leaderboard.list", void 0, listOf(leaderboardDefinitionOf)),
      submit(key, value, rawExtra) {
        const extra = rawExtra ?? {};
        const params = { key, value };
        if (extra.metadata !== void 0) params.metadata = extra.metadata;
        if (typeof extra.operationId === "string") params.operationId = extra.operationId;
        return mapped("leaderboard.submit", params, required(submitResultOf));
      },
      top: (key, opts) => mapped(
        "leaderboard.top",
        pageParams(key, opts, ["limit", "offset"]),
        required(leaderboardPageOf)
      ),
      aroundMe: (key, opts) => mapped("leaderboard.aroundMe", pageParams(key, opts, ["range"]), required(leaderboardPageOf)),
      friends: (key, opts) => mapped("leaderboard.friends", pageParams(key, opts, ["limit"]), required(leaderboardPageOf))
    };
    const definedOf = (source, names) => {
      const params = {};
      for (const name of names) {
        if (source?.[name] !== void 0) params[name] = source[name];
      }
      return params;
    };
    const listIn = (key, normalize) => (raw) => {
      const list = unwrap(raw, key);
      return Array.isArray(list) ? list.map(normalize).filter((item) => item !== null) : void 0;
    };
    const tradeIn = (raw) => tradeOf(unwrap(raw, "trade")) ?? void 0;
    const optionsError = (options2, label) => options2 !== void 0 && options2 !== null && typeof options2 !== "object" ? Promise.resolve(failure(CODES.invalidParams, `${label} options must be an object.`)) : null;
    const localeRelay = createRelay(backend, {
      minProtocol: LOCALE_PROTOCOL_VERSION,
      subscribe: (target, dispatch) => target.localeOnChange?.(dispatch),
      copyOf: localeOf,
      rethrow: false
    });
    const previewRelay = createRelay(backend, {
      minProtocol: PLAYER_STATE_PREVIEW_PROTOCOL_VERSION,
      subscribe: (target, dispatch) => target.playerStateOnPreview?.(dispatch),
      copyOf: previewStateOf,
      rethrow: true
    });
    const playerState = {
      getMine: () => statesCall("playerState.getMine", void 0, orNull(playerStateOf)),
      setMine(payload, baseRevision, rawExtra) {
        const params = { payload };
        if (typeof baseRevision === "number") params.baseRevision = baseRevision;
        if (rawExtra?.rating !== void 0 && backend().protocolVersion() >= MATCHMAKING_PROTOCOL_VERSION) {
          params.rating = rawExtra.rating;
        }
        return statesCall("playerState.setMine", params, required(playerStateOf));
      },
      get: (pseudoIds) => statesCall("playerState.get", { pseudoIds }, listOf(playerStateOf)),
      report: (pseudoId) => statesCall("playerState.report", { pseudoId }, (raw) => raw === true),
      sample(options2) {
        const error = optionsError(options2, "Sample");
        if (error) return error;
        return mapped(
          "playerState.sample",
          definedOf(options2, ["count", "minRating", "maxRating"]),
          listIn("states", playerStateOf),
          MATCHMAKING_PROTOCOL_VERSION
        );
      },
      onPreview: (handler) => previewRelay.subscribe(handler)
    };
    const inbox = {
      send: (to, kind, payload) => mapped(
        "inbox.send",
        { to, kind, payload },
        (raw) => flagOf(raw, "sent"),
        INBOX_PROTOCOL_VERSION
      ),
      list(options2) {
        const error = optionsError(options2, "Inbox list");
        if (error) return error;
        return mapped(
          "inbox.list",
          definedOf(options2, ["unreadOnly", "limit", "cursor"]),
          required(inboxPageOf),
          INBOX_PROTOCOL_VERSION
        );
      },
      markRead: (ids) => mapped("inbox.markRead", { ids }, (raw) => countOf(raw, "updated"), INBOX_PROTOCOL_VERSION),
      remove: (ids) => mapped("inbox.remove", { ids }, (raw) => countOf(raw, "updated"), INBOX_PROTOCOL_VERSION),
      report: (messageId) => mapped(
        "inbox.report",
        { messageId },
        (raw) => flagOf(raw, "reported"),
        INBOX_PROTOCOL_VERSION
      )
    };
    const trade = {
      create(options2) {
        if (!options2 || typeof options2 !== "object") {
          return Promise.resolve(
            failure(CODES.invalidParams, "Trade options must be an object like { offer, want }.")
          );
        }
        const params = definedOf(options2, [
          "offer",
          "want",
          "offerKey",
          "wantKey",
          "to",
          "expiresInSec",
          "operationId"
        ]);
        return mapped("trade.create", params, tradeIn, TRADE_PROTOCOL_VERSION);
      },
      list(options2) {
        const error = optionsError(options2, "Trade list");
        if (error) return error;
        return mapped(
          "trade.list",
          definedOf(options2, ["offerKey", "wantKey", "limit", "cursor"]),
          required(tradePageOf),
          TRADE_PROTOCOL_VERSION
        );
      },
      mine: () => mapped("trade.mine", void 0, required(myTradesOf), TRADE_PROTOCOL_VERSION),
      accept: (tradeId, give) => mapped("trade.accept", { tradeId, give }, required(acceptResultOf), TRADE_PROTOCOL_VERSION),
      cancel: (tradeId) => mapped("trade.cancel", { tradeId }, tradeIn, TRADE_PROTOCOL_VERSION),
      ack: (ids) => mapped("trade.ack", { ids }, (raw) => countOf(raw, "acked"), TRADE_PROTOCOL_VERSION),
      report: (tradeId) => mapped("trade.report", { tradeId }, (raw) => flagOf(raw, "reported"), TRADE_PROTOCOL_VERSION)
    };
    function withFallback(params, extra) {
      if (extra?.fallback !== void 0 && backend().protocolVersion() >= CLOUD_SAVE_LOCAL_PROTOCOL_VERSION) {
        params.fallback = extra.fallback;
      }
      return params;
    }
    const cloudSave = {
      load: (slot, extra) => mapped("cloudSave.load", withFallback({ slot }, extra), orNull(cloudSaveOf), 0),
      save(payload, slot, rawExtra) {
        const extra = rawExtra ?? {};
        const params = { payload, slot };
        if (typeof extra.baseRevision === "number") params.baseRevision = extra.baseRevision;
        return mapped("cloudSave.save", withFallback(params, extra), required(cloudSaveOf), 0);
      },
      remove: (slot, extra) => mapped("cloudSave.remove", withFallback({ slot }, extra), () => true, 0)
    };
    const share = {
      share(rawOptions) {
        if (rawOptions !== void 0 && rawOptions !== null && typeof rawOptions !== "object") {
          return Promise.resolve(
            failure(CODES.invalidParams, "Share options must be an object like { text, image }.")
          );
        }
        const opts = rawOptions ?? {};
        const params = {};
        if (opts.text !== void 0) params.text = opts.text;
        if (opts.image !== void 0) params.image = opts.image;
        const withLaunchParams = hasLaunchParams(opts.launchParams);
        if (withLaunchParams) params.launchParams = opts.launchParams;
        return mapped(
          "share.open",
          params,
          required(shareResultOf),
          withLaunchParams ? SHARE_LAUNCH_PROTOCOL_VERSION : SHARE_PROTOCOL_VERSION
        );
      },
      async isAvailable() {
        const result = await call("share.getAvailability", void 0, SHARE_PROTOCOL_VERSION);
        return result.ok && result.value === true;
      }
    };
    const locale = {
      get: () => mapped("locale.get", void 0, required(localeOf), LOCALE_PROTOCOL_VERSION),
      current() {
        const active = backend();
        if (!active.isAvailable() || active.protocolVersion() < LOCALE_PROTOCOL_VERSION) return null;
        try {
          return localeOf(active.localeCurrent?.());
        } catch {
          return null;
        }
      },
      onChange: (handler) => localeRelay.subscribe(handler)
    };
    const launch = {
      get: () => mapped("launch.get", void 0, required(launchOf), LAUNCH_PROTOCOL_VERSION),
      current() {
        const active = backend();
        if (!active.isAvailable() || active.protocolVersion() < LAUNCH_PROTOCOL_VERSION) return null;
        try {
          return launchOf(active.launchCurrent?.());
        } catch {
          return null;
        }
      }
    };
    function analyticsBackend() {
      const active = backend();
      if (!active.isAvailable() || active.protocolVersion() < ANALYTICS_PROTOCOL_VERSION) return null;
      return active;
    }
    function logAnalytics(kind, build) {
      try {
        const active = analyticsBackend();
        if (!active?.logAnalytics) return false;
        return active.logAnalytics(kind, build()) === true;
      } catch {
        return false;
      }
    }
    const fieldsOf = (options2) => options2?.fields;
    const analytics = {
      logOnboardingStep: (step, stepName, options2) => logAnalytics("onboarding", () => ({ step, stepName, fields: fieldsOf(options2) })),
      logFunnelStep: (funnel, funnelSessionId, step, stepName, options2) => logAnalytics("funnel", () => ({
        funnel,
        funnelSessionId,
        step,
        stepName,
        fields: fieldsOf(options2)
      })),
      logCustomEvent: (name, value, options2) => logAnalytics("custom", () => ({ name, value, fields: fieldsOf(options2) })),
      logEconomyEvent: (flowType, currency, amount, endingBalance, transactionType, options2) => logAnalytics("economy", () => ({
        flowType,
        currency,
        amount,
        endingBalance,
        transactionType,
        itemSku: options2?.itemSku,
        fields: fieldsOf(options2)
      })),
      isAvailable() {
        try {
          return analyticsBackend()?.analyticsAvailable?.() === true;
        } catch {
          return false;
        }
      }
    };
    const net = {
      async join(rawOptions) {
        const opts = rawOptions ?? {};
        const active = backend();
        if (!active.isAvailable() || active.protocolVersion() < REQUIRED_PROTOCOL_VERSION) {
          return unsupported();
        }
        closeCurrentRoom("replaced");
        const params = { mode: typeof opts.mode === "string" && opts.mode ? opts.mode : "default" };
        if (typeof opts.roomCode === "string" && opts.roomCode) params.roomCode = opts.roomCode;
        const result = await active.call("net.join", params);
        if (!result.ok) return result;
        const { source, info } = result.value ?? {};
        if (!source || !info || typeof info.roomId !== "string" || !info.roomId) {
          return failure(CODES.internal, "GameRush returned an unreadable room.");
        }
        const room = createRoom(source, info, (closedRoom) => {
          if (currentRoom === closedRoom) currentRoom = null;
        });
        currentRoom = room;
        return ok(room);
      },
      get room() {
        return currentRoom;
      }
    };
    return {
      VERSION,
      CODES,
      CHANNEL_RELIABLE: "reliable",
      CHANNEL_UNRELIABLE: "unreliable",
      EVERYONE: -1,
      MAX_MESSAGE_BYTES,
      get backend() {
        return backend().kind;
      },
      configure(settings) {
        if (!BACKENDS.has(settings?.backend) || settings.backend === selection) return;
        const previous = currentRoom;
        currentRoom = null;
        previous?.leave();
        selection = settings.backend;
        localeRelay.bind();
        previewRelay.bind();
      },
      isAvailable() {
        const active = backend();
        return active.isAvailable() && active.protocolVersion() >= REQUIRED_PROTOCOL_VERSION;
      },
      protocolVersion: () => backend().protocolVersion(),
      player,
      leaderboards,
      playerState,
      inbox,
      trade,
      cloudSave,
      share,
      locale,
      launch,
      analytics,
      net,
      mock: mockBackend.controls
    };
  }
  function previewStateOf(raw) {
    try {
      return playerStateOf(structuredClone(raw));
    } catch {
      return null;
    }
  }
  function createRelay(backend, { minProtocol, subscribe, copyOf, rethrow }) {
    const handlers = /* @__PURE__ */ new Set();
    let binding = null;
    function bind() {
      const active = backend();
      const target = handlers.size > 0 && active.isAvailable() && active.protocolVersion() >= minProtocol ? active : null;
      if ((binding?.backend ?? null) === target) return;
      const previous = binding;
      binding = null;
      previous?.off();
      if (!target) return;
      let off = null;
      try {
        off = subscribe(target, dispatch);
      } catch {
      }
      binding = { backend: target, off: typeof off === "function" ? off : () => {
      } };
    }
    function dispatch(raw) {
      if (!copyOf(raw)) return;
      let first = null;
      for (const entry of [...handlers]) {
        if (!handlers.has(entry)) continue;
        try {
          entry.handler(copyOf(raw));
        } catch (error) {
          if (rethrow && !first) {
            first = { error };
            continue;
          }
          queueMicrotask(() => {
            throw error;
          });
        }
      }
      if (first) throw first.error;
    }
    return {
      bind,
      subscribe(handler) {
        if (typeof handler !== "function") return () => {
        };
        const entry = { handler };
        handlers.add(entry);
        bind();
        return () => {
          if (!handlers.delete(entry)) return;
          bind();
        };
      }
    };
  }
  function pageParams(key, options, names) {
    const params = { key };
    for (const name of names) {
      if (typeof options?.[name] === "number") params[name] = options[name];
    }
    return params;
  }

  // src/index.js
  var GRush = createGRush();

  // src/global.js
  globalThis.GRushSdk = GRush;
  if (globalThis.GRush === void 0) globalThis.GRush = GRush;
})();
