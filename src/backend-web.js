import { failure, failureFromCloudSaveError, failureFromError, ok, unsupported } from "./result.js";

function runtimeApi(name) {
  return globalThis[`GRush${name}`] ?? globalThis[`GameRush${name}`] ?? null;
}

export function isRuntimePresent() {
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
    serverTimeMs: typeof room.serverTimeMs === "function" ? room.serverTimeMs() : Date.now(),
  };
}

function roomSourceOf(room) {
  return {
    on: (name, handler) => room.on(name, handler),
    send: (bytes, options) => room.send(bytes, options),
    leave: () => room.leave(),
  };
}

const INVOKERS = {
  "player.getSelf": (apis) => apis.Player?.getSelf(),
  "player.requestProfile": (apis) => apis.Player?.requestProfile(),
  "player.revokeProfile": (apis) => apis.Player?.revokeProfile(),
  "leaderboard.list": (apis) => apis.Leaderboards?.list(),
  "leaderboard.submit": (apis, p) =>
    apis.Leaderboards?.submit(p.key, p.value, p.metadata, p.operationId),
  "leaderboard.top": (apis, p) => apis.Leaderboards?.top(p.key, p),
  "leaderboard.aroundMe": (apis, p) => apis.Leaderboards?.aroundMe(p.key, p),
  "leaderboard.friends": (apis, p) => apis.Leaderboards?.friends(p.key, p),
  "playerState.getMine": (apis) => apis.PlayerState?.getMine(),
  // `rating` is in the params only when the runtime is new enough to read it (see sdk.js).
  "playerState.setMine": (apis, p) =>
    "rating" in p
      ? apis.PlayerState?.setMine(p.payload, p.baseRevision, { rating: p.rating })
      : apis.PlayerState?.setMine(p.payload, p.baseRevision),
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
  "net.join": (apis, p) =>
    apis.Net?.join(p).then((room) =>
      room ? { source: roomSourceOf(room), info: describeRoom(room) } : null,
    ),
};

// `fallback` is in the params only when the runtime is new enough to read it (see sdk.js).
function fallbackOptions(p) {
  return "fallback" in p ? { fallback: p.fallback } : {};
}

const CLOUD_SAVE_INVOKERS = {
  "cloudSave.load": (api, p) => api.loadWithMetadata(p.slot, fallbackOptions(p)),
  "cloudSave.save": (api, p) => {
    const options = fallbackOptions(p);
    if (typeof p.baseRevision === "number") options.baseRevision = p.baseRevision;
    return api.save(p.payload, p.slot, options);
  },
  "cloudSave.remove": (api, p) => api.remove(p.slot, fallbackOptions(p)),
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
    Trade: runtimeApi("Trade"),
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

export function createWebBackend() {
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
      return typeof unsubscribe === "function" ? unsubscribe : () => {};
    },
    // The runtime holds one handler and replaces it on the next call, so sdk.js registers only once.
    playerStateOnPreview(handler) {
      const unsubscribe = runtimeApi("PlayerState")?.onPreview?.(handler);
      return typeof unsubscribe === "function" ? unsubscribe : () => {};
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
        if (pending === undefined) return unsupported();
        return ok(await pending);
      } catch (error) {
        return failureFromError(error);
      }
    },
  };
}
