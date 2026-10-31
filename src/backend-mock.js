import { sanitizeAnalyticsEvent } from "./analytics-rules.js";
import { createMockLeaderboards } from "./mock-leaderboards.js";
import { MANIFEST_PATH, parseLeaderboardManifest } from "./mock-manifest.js";
import { createMockNet } from "./mock-net.js";
import { MOCK_RIVALS, createMockSocial } from "./mock-social.js";
import { CODES, failure, ok } from "./result.js";

const MANIFEST_TIMEOUT_MS = 3000;
// How many analytics events mock.analyticsEvents() keeps, newest last.
export const MOCK_ANALYTICS_MAX_EVENTS = 200;
// The newest protocol the mock implements (playerState.onPreview needs 10).
const MOCK_PROTOCOL_VERSION = 10;

const STORAGE_KEY = "grush-sdk-mock";
const SLOT_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const PLAYER_STATE_MAX_BYTES = 4 * 1024;
const SAMPLE_DEFAULT_COUNT = 10;
const SAMPLE_MAX_COUNT = 20;
const RATING_LIMIT = 1e9;
const RIVAL_RATINGS = [1000, 1200, 1500];
const CLOUD_SAVE_MAX_BYTES = 256 * 1024;
const OPAQUE_STRING_MIN_LENGTH = 256;
const LOCALE_FALLBACK = "ja";
const BASE64_LIKE = /^[A-Za-z0-9+/\-_]+={0,2}$/;

function containsOpaqueString(value) {
  if (typeof value === "string") {
    return value.length >= OPAQUE_STRING_MIN_LENGTH && BASE64_LIKE.test(value);
  }
  if (Array.isArray(value)) return value.some(containsOpaqueString);
  if (value && typeof value === "object") return Object.values(value).some(containsOpaqueString);
  return false;
}

// The mock hands the configured parameters over as they are. GameRush drops keys and values that do not fit
// its limits, so check them in GameRush before relying on them.
function mockLaunch(config) {
  const params = config.launchParams;
  if (!params || typeof params !== "object") return { params: {} };
  return {
    params: Object.fromEntries(
      Object.entries(params).filter(([, value]) => typeof value === "string"),
    ),
  };
}

// The same limits GameRush applies to the launch parameters a game attaches to a share. Unlike the parameters a
// game reads, one bad key or value rejects the whole share.
const SHARE_LAUNCH_KEY = /^[A-Za-z0-9_-]{1,32}$/;
const SHARE_LAUNCH_VALUE = /^[A-Za-z0-9._~:,-]{0,128}$/;
const SHARE_LAUNCH_MAX_PARAMS = 8;

function shareLaunchParamsValid(value) {
  if (value === undefined || value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  const keys = Object.keys(value);
  // Symbol and non-enumerable keys are not in Object.keys, so reject them instead of dropping them.
  if (Reflect.ownKeys(value).length !== keys.length) return false;
  if (keys.length > SHARE_LAUNCH_MAX_PARAMS) return false;
  return keys.every(
    (key) =>
      SHARE_LAUNCH_KEY.test(key) &&
      key !== "__proto__" &&
      typeof value[key] === "string" &&
      SHARE_LAUNCH_VALUE.test(value[key]),
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
    languages: device.length ? device : [LOCALE_FALLBACK],
  };
}

export function defaultMockConfig() {
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
    launchParams: {},
  };
}

let memoryStore = null;

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
  } catch {}
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

function invalid(message) {
  return failure(CODES.invalidParams, message);
}

// Mirrors GameRush: no option or null keeps the cloud-only behavior, "local" opts in, anything else
// is rejected.
function fallbackOf(value) {
  if (value === undefined || value === null) return { ok: true, local: false };
  if (value === "local") return { ok: true, local: true };
  return { ok: false };
}

function isRating(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > -RATING_LIMIT &&
    value < RATING_LIMIT
  );
}

function shuffled(items) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}

function stateWire({ hidden: _hidden, ...state }) {
  return state;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Mirrors GameRush: one handler, replaced by the next registration. A preview is handed over once,
// after the current call returns, and a handler registered later still gets a preview not handed
// over yet.
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
    // Like GameRush, only note the failure. sdk.js has already sent the error to the console.
    try {
      handler(JSON.parse(json));
    } catch {}
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
    },
  };
}

export function createMockBackend(config) {
  const otherStates = new Map();
  const cloudSaves = new Map();
  const localSaves = new Map();
  let analyticsEvents = [];
  const analyticsWarned = new Set();
  let myState = null;
  const preview = createMockPreview();

  // Checks the shape GameRush checks before it hands a preview to the game.
  function previewPlayerState(pseudoId, payload, options) {
    const extra = options ?? {};
    if (typeof pseudoId !== "string" || !pseudoId) return false;
    if (!isPlainObject(payload)) return false;
    const rating = extra.rating ?? null;
    if (rating !== null && !Number.isFinite(rating)) return false;
    const revision = extra.revision ?? 1;
    if (!Number.isInteger(revision) || revision < 0) return false;
    let json;
    try {
      json = JSON.stringify({
        pseudoId,
        payload,
        revision,
        rating,
        updatedAt: new Date().toISOString(),
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
      updatedAt: new Date().toISOString(),
      hidden: options.hidden === true,
    });
  }

  // Each rival has a public state with a rating, so matchmaking has someone to find. The payloads are
  // fresh literals, so creating the mock needs no structuredClone.
  function seedRivals() {
    MOCK_RIVALS.forEach((pseudoId, index) => {
      putState(pseudoId, { level: (index + 1) * 5 }, { rating: RIVAL_RATINGS[index] });
    });
  }

  seedRivals();

  const social = createMockSocial({
    config,
    selfId: () => localPseudoId(),
    isKnownPlayer: (pseudoId) => otherStates.has(pseudoId),
  });

  const consented = () => config.signedIn && readStored().consent === true;

  function playerWire() {
    return {
      pseudoId: localPseudoId(),
      isGuest: !config.signedIn,
      profileConsent: consented(),
      profile: { displayName: config.displayName, avatarUrl: config.avatarUrl },
    };
  }

  function localPeerWire(index) {
    return {
      index,
      pseudoId: localPseudoId(),
      displayName: consented() ? config.displayName : null,
      avatarUrl: consented() ? config.avatarUrl : null,
    };
  }

  const net = createMockNet(config, localPeerWire);
  const leaderboards = createMockLeaderboards(() => {
    const { index: _index, ...identity } = localPeerWire(-1);
    return { ...identity, isGuest: !config.signedIn };
  });

  // grush.json next to the page is read once, before the first leaderboard call. loadLeaderboards and
  // reset bump the generation so a read still in flight does not apply over them.
  let manifestRead = null;
  let manifestGeneration = 0;

  async function readManifestFile(generation) {
    const location = globalThis.location;
    // fetch cannot read file:// pages, and the browser would log the refusal as an error.
    if (
      typeof globalThis.fetch !== "function" ||
      !location?.href ||
      location.protocol === "file:"
    ) {
      return;
    }
    // A dev server that never answers would hold every leaderboard call, so a slow read counts as no
    // file.
    const controller = new AbortController();
    let timer;
    // Also raced, so a fetch that ignores the signal cannot hold the calls either.
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("grush.json took too long."));
      }, MANIFEST_TIMEOUT_MS);
    });
    let bytes;
    try {
      const response = await Promise.race([
        globalThis.fetch(new URL(MANIFEST_PATH, location.href), {
          cache: "no-store",
          signal: controller.signal,
        }),
        deadline,
      ]);
      // A dev server that answers every path with index.html has no grush.json either.
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
    manifestRead ??= readManifestFile(manifestGeneration);
    return manifestRead;
  }

  function loadLeaderboards(manifest) {
    manifestGeneration += 1;
    manifestRead = Promise.resolve();
    const parsed = parseLeaderboardManifest(manifest);
    if (!parsed.ok) return invalid(parsed.error);
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
      return invalid("Player state payload must be a JSON object.");
    }
    if (jsonBytes(payload) > PLAYER_STATE_MAX_BYTES) return invalid("Player state is too large.");
    if (containsOpaqueString(payload)) {
      return invalid("Player state must not contain opaque encoded strings.");
    }
    // No rating keeps the current one, null clears it.
    const ratingGiven = "rating" in params && params.rating !== undefined;
    if (ratingGiven && params.rating !== null && !isRating(params.rating)) {
      return invalid("Invalid rating.");
    }
    const current = myState ? myState.revision : 0;
    if (typeof baseRevision === "number" && baseRevision !== current) {
      return failure(CODES.invalidParams, "Player state was updated elsewhere.");
    }
    myState = {
      pseudoId: localPseudoId(),
      payload: structuredClone(payload),
      revision: current + 1,
      rating: ratingGiven ? params.rating : (myState?.rating ?? null),
      updatedAt: new Date().toISOString(),
    };
    return ok(myState);
  }

  function getMany({ pseudoIds }) {
    if (!Array.isArray(pseudoIds) || pseudoIds.length === 0 || pseudoIds.length > 50) {
      return invalid("pseudoIds must be an array of at most 50 ids.");
    }
    const states = pseudoIds
      .map((id) => otherStates.get(id))
      .filter((state) => state && !state.hidden)
      .map(stateWire);
    return ok(states);
  }

  // Mirrors GameRush's matchmaking: random visible states of other players, optionally within a rating
  // range. States without a rating only come back when no range is given.
  function sample({ count, minRating, maxRating }) {
    let size = SAMPLE_DEFAULT_COUNT;
    if (count !== undefined && count !== null) {
      if (!Number.isInteger(count) || count < 1 || count > SAMPLE_MAX_COUNT) {
        return invalid(`count must be an integer from 1 to ${SAMPLE_MAX_COUNT}.`);
      }
      size = count;
    }
    const minGiven = minRating !== undefined && minRating !== null;
    const maxGiven = maxRating !== undefined && maxRating !== null;
    if (minGiven !== maxGiven) return invalid("minRating and maxRating must be given together.");
    if (minGiven && (!isRating(minRating) || !isRating(maxRating))) {
      return invalid("Invalid rating range.");
    }
    if (minGiven && minRating > maxRating) return invalid("minRating must not exceed maxRating.");
    const self = localPseudoId();
    const candidates = [...otherStates.values()].filter(
      (state) =>
        !state.hidden &&
        state.pseudoId !== self &&
        (!minGiven ||
          (state.rating !== null && state.rating >= minRating && state.rating <= maxRating)),
    );
    return ok(shuffled(candidates).slice(0, size).map(stateWire));
  }

  function saveCloud({ payload, slot, baseRevision, fallback }) {
    const key = slot || "default";
    if (!SLOT_PATTERN.test(key)) return invalid("Invalid cloud save slot.");
    if (payload === undefined || payload === null)
      return invalid("Cloud save payload is required.");
    if (jsonBytes(payload) > CLOUD_SAVE_MAX_BYTES)
      return invalid("Cloud save payload is too large.");
    const mode = fallbackOf(fallback);
    if (!mode.ok) return invalid("Invalid cloud save fallback.");
    if (!config.signedIn) {
      if (!mode.local) return failure(CODES.signInRequired, "Cloud save requires sign-in.");
      // A device save has no revision history, so baseRevision is not checked and the last write wins.
      const now = new Date().toISOString();
      const previous = localSaves.get(key);
      const save = {
        slot: key,
        payload: structuredClone(payload),
        revision: 0,
        createdAt: previous ? previous.createdAt : now,
        updatedAt: now,
        storage: "local",
      };
      localSaves.set(key, save);
      return ok(save);
    }
    const current = cloudSaves.get(key);
    const revision = current ? current.revision : 0;
    if (typeof baseRevision === "number" && baseRevision !== revision) {
      return failure(CODES.conflict, "Cloud save was updated elsewhere.");
    }
    const now = new Date().toISOString();
    const save = {
      slot: key,
      payload: structuredClone(payload),
      revision: revision + 1,
      createdAt: current ? current.createdAt : now,
      updatedAt: now,
    };
    cloudSaves.set(key, save);
    if (mode.local) localSaves.delete(key);
    return ok(save);
  }

  function loadCloud({ slot, fallback }) {
    const key = slot || "default";
    if (!SLOT_PATTERN.test(key)) return invalid("Invalid cloud save slot.");
    const mode = fallbackOf(fallback);
    if (!mode.ok) return invalid("Invalid cloud save fallback.");
    if (!config.signedIn) {
      if (!mode.local) return failure(CODES.signInRequired, "Cloud save requires sign-in.");
      return ok(localSaves.get(key) ?? null);
    }
    const save = cloudSaves.get(key);
    if (save) return ok(save);
    return ok(mode.local ? (localSaves.get(key) ?? null) : null);
  }

  function removeCloud({ slot, fallback }) {
    const key = slot || "default";
    if (!SLOT_PATTERN.test(key)) return invalid("Invalid cloud save slot.");
    const mode = fallbackOf(fallback);
    if (!mode.ok) return invalid("Invalid cloud save fallback.");
    if (!config.signedIn && !mode.local) {
      return failure(CODES.signInRequired, "Cloud save requires sign-in.");
    }
    if (config.signedIn) cloudSaves.delete(key);
    if (mode.local) localSaves.delete(key);
    return ok(true);
  }

  // Checks the event the way GameRush does, prints it and keeps the most recent ones. Nothing is sent.
  // Like GameRush, a rejection is warned about once per reason.
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
    return outcome.error ? invalid(outcome.error) : ok(pick(outcome));
  }

  const handlers = {
    "player.getSelf": () => ok(playerWire()),
    "player.requestProfile": requestProfile,
    "player.revokeProfile": () => {
      writeStored({ consent: false });
      return ok(playerWire());
    },
    "leaderboard.list": () => ok(leaderboards.list()),
    "leaderboard.submit": (p) =>
      fromBoard(leaderboards.submit(p.key, p.value, p.metadata), (o) => o.result),
    "leaderboard.top": (p) => fromBoard(leaderboards.page(p.key, p, false), (o) => o.page),
    "leaderboard.aroundMe": (p) => fromBoard(leaderboards.page(p.key, p, true), (o) => o.page),
    "leaderboard.friends": () =>
      failure(CODES.consentDeclined, "Friend leaderboards require per-game friend consent."),
    "playerState.getMine": () => ok(myState),
    "playerState.setMine": setMine,
    "playerState.get": getMany,
    "playerState.report": (p) => {
      if (!config.signedIn) return failure(CODES.signInRequired, "Reporting requires sign-in.");
      const target = otherStates.get(p.pseudoId);
      if (!target || target.hidden) return invalid("No player state for that id.");
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
    "net.join": (p) => net.join(p),
  };

  const controls = {
    config,
    defineLeaderboard: (key, options) => leaderboards.define(key, options),
    loadLeaderboards,
    addRival: (key, displayName, value, options) =>
      leaderboards.addRival(key, displayName, value, options),
    definePlayerState: (pseudoId, payload, options) =>
      putState(pseudoId, structuredClone(payload), options ?? {}),
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
    },
  };

  return {
    kind: "mock",
    controls,
    isAvailable: () => true,
    protocolVersion: () => MOCK_PROTOCOL_VERSION,
    localeCurrent: () => mockLocale(config),
    localeOnChange: () => () => {},
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
        return invalid(error instanceof Error ? error.message : "The mock rejected the call.");
      }
    },
  };
}
