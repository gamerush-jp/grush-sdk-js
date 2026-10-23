import { createMockBackend, defaultMockConfig } from "./backend-mock.js";
import { createWebBackend, isRuntimePresent } from "./backend-web.js";
import { MAX_MESSAGE_BYTES } from "./bytes.js";
import {
  acceptResultOf,
  cloudSaveOf,
  countOf,
  flagOf,
  inboxPageOf,
  launchOf,
  leaderboardDefinitionOf,
  leaderboardPageOf,
  localeOf,
  myTradesOf,
  playerOf,
  playerStateOf,
  shareResultOf,
  submitResultOf,
  tradeOf,
  tradePageOf,
  unwrap,
} from "./normalize.js";
import { CODES, failure, ok, unsupported } from "./result.js";
import { createRoom } from "./room.js";

export const VERSION = "0.12.0";
const REQUIRED_PROTOCOL_VERSION = 1;
const PLAYER_STATE_PROTOCOL_VERSION = 2;
const SHARE_PROTOCOL_VERSION = 3;
const LOCALE_PROTOCOL_VERSION = 4;
const CLOUD_SAVE_LOCAL_PROTOCOL_VERSION = 5;
const ANALYTICS_PROTOCOL_VERSION = 6;
// playerState.sample and the rating of playerState.setMine.
const MATCHMAKING_PROTOCOL_VERSION = 7;
const INBOX_PROTOCOL_VERSION = 7;
const TRADE_PROTOCOL_VERSION = 7;
const LAUNCH_PROTOCOL_VERSION = 8;
// launchParams on share. Older runtimes drop them and would share a link without them.
const SHARE_LAUNCH_PROTOCOL_VERSION = 9;
const PLAYER_STATE_PREVIEW_PROTOCOL_VERSION = 10;
const BACKENDS = new Set(["auto", "web", "mock", "none"]);
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const noneBackend = {
  kind: "none",
  isAvailable: () => false,
  protocolVersion: () => 0,
  call: async () => unsupported(),
};

// Only undefined, null and a plain object with no own keys count as "no launch params". Anything else,
// such as a Map or an object whose keys are inherited, is passed on so GameRush answers invalidParams
// instead of the share opening without them.
function hasLaunchParams(value) {
  if (value === undefined || value === null) return false;
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

export function createGRush(options = {}) {
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
    if (value === undefined)
      return failure(CODES.internal, `GameRush returned an unreadable ${method} result.`);
    return ok(value);
  }

  const orNull = (normalize) => (raw) => (raw == null ? null : normalize(raw));
  const required = (normalize) => (raw) => normalize(raw) ?? undefined;
  const listOf = (normalize) => (raw) =>
    Array.isArray(raw) ? raw.map(normalize).filter((item) => item !== null) : [];
  const playerCall = (method) => () => mapped(method, undefined, required(playerOf));
  const statesCall = (method, params, pick) =>
    mapped(method, params, pick, PLAYER_STATE_PROTOCOL_VERSION);

  const player = {
    getSelf: playerCall("player.getSelf"),
    requestProfile: playerCall("player.requestProfile"),
    revokeProfile: playerCall("player.revokeProfile"),
  };

  const leaderboards = {
    list: () => mapped("leaderboard.list", undefined, listOf(leaderboardDefinitionOf)),
    submit(key, value, rawExtra) {
      const extra = rawExtra ?? {};
      const params = { key, value };
      if (extra.metadata !== undefined) params.metadata = extra.metadata;
      if (typeof extra.operationId === "string") params.operationId = extra.operationId;
      return mapped("leaderboard.submit", params, required(submitResultOf));
    },
    top: (key, opts) =>
      mapped(
        "leaderboard.top",
        pageParams(key, opts, ["limit", "offset"]),
        required(leaderboardPageOf),
      ),
    aroundMe: (key, opts) =>
      mapped("leaderboard.aroundMe", pageParams(key, opts, ["range"]), required(leaderboardPageOf)),
    friends: (key, opts) =>
      mapped("leaderboard.friends", pageParams(key, opts, ["limit"]), required(leaderboardPageOf)),
  };

  const definedOf = (source, names) => {
    const params = {};
    for (const name of names) {
      if (source?.[name] !== undefined) params[name] = source[name];
    }
    return params;
  };
  const listIn = (key, normalize) => (raw) => {
    const list = unwrap(raw, key);
    return Array.isArray(list) ? list.map(normalize).filter((item) => item !== null) : undefined;
  };
  const tradeIn = (raw) => tradeOf(unwrap(raw, "trade")) ?? undefined;
  const optionsError = (options, label) =>
    options !== undefined && options !== null && typeof options !== "object"
      ? Promise.resolve(failure(CODES.invalidParams, `${label} options must be an object.`))
      : null;

  const localeRelay = createRelay(backend, {
    minProtocol: LOCALE_PROTOCOL_VERSION,
    subscribe: (target, dispatch) => target.localeOnChange?.(dispatch),
    copyOf: localeOf,
    rethrow: false,
  });
  const previewRelay = createRelay(backend, {
    minProtocol: PLAYER_STATE_PREVIEW_PROTOCOL_VERSION,
    subscribe: (target, dispatch) => target.playerStateOnPreview?.(dispatch),
    copyOf: previewStateOf,
    rethrow: true,
  });

  const playerState = {
    getMine: () => statesCall("playerState.getMine", undefined, orNull(playerStateOf)),
    setMine(payload, baseRevision, rawExtra) {
      const params = { payload };
      if (typeof baseRevision === "number") params.baseRevision = baseRevision;
      // A GameRush older than protocol 7 does not know `rating`. It is dropped there instead of failing
      // the call, so the payload is still written.
      if (
        rawExtra?.rating !== undefined &&
        backend().protocolVersion() >= MATCHMAKING_PROTOCOL_VERSION
      ) {
        params.rating = rawExtra.rating;
      }
      return statesCall("playerState.setMine", params, required(playerStateOf));
    },
    get: (pseudoIds) => statesCall("playerState.get", { pseudoIds }, listOf(playerStateOf)),
    report: (pseudoId) => statesCall("playerState.report", { pseudoId }, (raw) => raw === true),
    sample(options) {
      const error = optionsError(options, "Sample");
      if (error) return error;
      return mapped(
        "playerState.sample",
        definedOf(options, ["count", "minRating", "maxRating"]),
        listIn("states", playerStateOf),
        MATCHMAKING_PROTOCOL_VERSION,
      );
    },
    onPreview: (handler) => previewRelay.subscribe(handler),
  };

  const inbox = {
    send: (to, kind, payload) =>
      mapped(
        "inbox.send",
        { to, kind, payload },
        (raw) => flagOf(raw, "sent"),
        INBOX_PROTOCOL_VERSION,
      ),
    list(options) {
      const error = optionsError(options, "Inbox list");
      if (error) return error;
      return mapped(
        "inbox.list",
        definedOf(options, ["unreadOnly", "limit", "cursor"]),
        required(inboxPageOf),
        INBOX_PROTOCOL_VERSION,
      );
    },
    markRead: (ids) =>
      mapped("inbox.markRead", { ids }, (raw) => countOf(raw, "updated"), INBOX_PROTOCOL_VERSION),
    remove: (ids) =>
      mapped("inbox.remove", { ids }, (raw) => countOf(raw, "updated"), INBOX_PROTOCOL_VERSION),
    report: (messageId) =>
      mapped(
        "inbox.report",
        { messageId },
        (raw) => flagOf(raw, "reported"),
        INBOX_PROTOCOL_VERSION,
      ),
  };

  const trade = {
    create(options) {
      if (!options || typeof options !== "object") {
        return Promise.resolve(
          failure(CODES.invalidParams, "Trade options must be an object like { offer, want }."),
        );
      }
      const params = definedOf(options, [
        "offer",
        "want",
        "offerKey",
        "wantKey",
        "to",
        "expiresInSec",
        "operationId",
      ]);
      return mapped("trade.create", params, tradeIn, TRADE_PROTOCOL_VERSION);
    },
    list(options) {
      const error = optionsError(options, "Trade list");
      if (error) return error;
      return mapped(
        "trade.list",
        definedOf(options, ["offerKey", "wantKey", "limit", "cursor"]),
        required(tradePageOf),
        TRADE_PROTOCOL_VERSION,
      );
    },
    mine: () => mapped("trade.mine", undefined, required(myTradesOf), TRADE_PROTOCOL_VERSION),
    accept: (tradeId, give) =>
      mapped("trade.accept", { tradeId, give }, required(acceptResultOf), TRADE_PROTOCOL_VERSION),
    cancel: (tradeId) => mapped("trade.cancel", { tradeId }, tradeIn, TRADE_PROTOCOL_VERSION),
    ack: (ids) =>
      mapped("trade.ack", { ids }, (raw) => countOf(raw, "acked"), TRADE_PROTOCOL_VERSION),
    report: (tradeId) =>
      mapped("trade.report", { tradeId }, (raw) => flagOf(raw, "reported"), TRADE_PROTOCOL_VERSION),
  };

  // A GameRush older than protocol 5 does not know `fallback`. The option is dropped there instead of
  // failing the call, so signed-in players keep saving to the cloud as before.
  function withFallback(params, extra) {
    if (
      extra?.fallback !== undefined &&
      backend().protocolVersion() >= CLOUD_SAVE_LOCAL_PROTOCOL_VERSION
    ) {
      params.fallback = extra.fallback;
    }
    return params;
  }

  const cloudSave = {
    load: (slot, extra) =>
      mapped("cloudSave.load", withFallback({ slot }, extra), orNull(cloudSaveOf), 0),
    save(payload, slot, rawExtra) {
      const extra = rawExtra ?? {};
      const params = { payload, slot };
      if (typeof extra.baseRevision === "number") params.baseRevision = extra.baseRevision;
      return mapped("cloudSave.save", withFallback(params, extra), required(cloudSaveOf), 0);
    },
    remove: (slot, extra) =>
      mapped("cloudSave.remove", withFallback({ slot }, extra), () => true, 0),
  };

  const share = {
    share(rawOptions) {
      if (rawOptions !== undefined && rawOptions !== null && typeof rawOptions !== "object") {
        return Promise.resolve(
          failure(CODES.invalidParams, "Share options must be an object like { text, image }."),
        );
      }
      const opts = rawOptions ?? {};
      const params = {};
      if (opts.text !== undefined) params.text = opts.text;
      if (opts.image !== undefined) params.image = opts.image;
      // GameRush checks the keys and values. Anything but an empty object is passed on, so a malformed
      // value comes back as invalidParams instead of being dropped here.
      const withLaunchParams = hasLaunchParams(opts.launchParams);
      if (withLaunchParams) params.launchParams = opts.launchParams;
      return mapped(
        "share.open",
        params,
        required(shareResultOf),
        withLaunchParams ? SHARE_LAUNCH_PROTOCOL_VERSION : SHARE_PROTOCOL_VERSION,
      );
    },
    async isAvailable() {
      const result = await call("share.getAvailability", undefined, SHARE_PROTOCOL_VERSION);
      return result.ok && result.value === true;
    },
  };

  const locale = {
    get: () => mapped("locale.get", undefined, required(localeOf), LOCALE_PROTOCOL_VERSION),
    current() {
      const active = backend();
      if (!active.isAvailable() || active.protocolVersion() < LOCALE_PROTOCOL_VERSION) return null;
      try {
        return localeOf(active.localeCurrent?.());
      } catch {
        return null;
      }
    },
    onChange: (handler) => localeRelay.subscribe(handler),
  };

  // Launch parameters arrive once, with the slide the player opened first, so there is no onChange.
  const launch = {
    get: () => mapped("launch.get", undefined, required(launchOf), LAUNCH_PROTOCOL_VERSION),
    current() {
      const active = backend();
      if (!active.isAvailable() || active.protocolVersion() < LAUNCH_PROTOCOL_VERSION) return null;
      try {
        return launchOf(active.launchCurrent?.());
      } catch {
        return null;
      }
    },
  };

  // Analytics answers synchronously with a boolean and never throws, so a game can log from anywhere
  // without awaiting. An older GameRush or a page outside GameRush answers false.
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

  const fieldsOf = (options) => options?.fields;

  const analytics = {
    logOnboardingStep: (step, stepName, options) =>
      logAnalytics("onboarding", () => ({ step, stepName, fields: fieldsOf(options) })),
    logFunnelStep: (funnel, funnelSessionId, step, stepName, options) =>
      logAnalytics("funnel", () => ({
        funnel,
        funnelSessionId,
        step,
        stepName,
        fields: fieldsOf(options),
      })),
    logCustomEvent: (name, value, options) =>
      logAnalytics("custom", () => ({ name, value, fields: fieldsOf(options) })),
    logEconomyEvent: (flowType, currency, amount, endingBalance, transactionType, options) =>
      logAnalytics("economy", () => ({
        flowType,
        currency,
        amount,
        endingBalance,
        transactionType,
        itemSku: options?.itemSku,
        fields: fieldsOf(options),
      })),
    isAvailable() {
      try {
        return analyticsBackend()?.analyticsAvailable?.() === true;
      } catch {
        return false;
      }
    },
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
    },
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
    mock: mockBackend.controls,
  };
}

// A preview is a JSON copy, so each handler gets its own deep copy and can change it freely.
function previewStateOf(raw) {
  try {
    return playerStateOf(structuredClone(raw));
  } catch {
    return null;
  }
}

// Handlers stay registered on the SDK, and only one subscription is held on the backend. When
// configure() switches the backend, that subscription moves to the new one. Each handler gets its own
// copy, and one handler throwing does not stop the others. Every error is rethrown asynchronously so it
// reaches the console. With `rethrow`, the first error is also thrown back to the backend after every
// handler has run, so GameRush learns that the game failed to handle the event.
function createRelay(backend, { minProtocol, subscribe, copyOf, rethrow }) {
  const handlers = new Set();
  let binding = null;

  function bind() {
    const active = backend();
    const target =
      handlers.size > 0 && active.isAvailable() && active.protocolVersion() >= minProtocol
        ? active
        : null;
    if ((binding?.backend ?? null) === target) return;
    const previous = binding;
    binding = null;
    previous?.off();
    if (!target) return;
    let off = null;
    try {
      off = subscribe(target, dispatch);
    } catch {}
    binding = { backend: target, off: typeof off === "function" ? off : () => {} };
  }

  function dispatch(raw) {
    if (!copyOf(raw)) return;
    let first = null;
    for (const entry of [...handlers]) {
      if (!handlers.has(entry)) continue;
      try {
        entry.handler(copyOf(raw));
      } catch (error) {
        if (rethrow && !first) first = { error };
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
      if (typeof handler !== "function") return () => {};
      // Entries are objects so the same function registered twice stays two subscriptions.
      const entry = { handler };
      handlers.add(entry);
      bind();
      return () => {
        if (!handlers.delete(entry)) return;
        bind();
      };
    },
  };
}

function pageParams(key, options, names) {
  const params = { key };
  for (const name of names) {
    if (typeof options?.[name] === "number") params[name] = options[name];
  }
  return params;
}
