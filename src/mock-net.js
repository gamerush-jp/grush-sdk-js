import { decodeJson, decodeText, toBytes } from "./bytes.js";
import { CODES, failure, ok } from "./result.js";

const MODE_PATTERN = /^[A-Za-z0-9._:-]{1,32}$/;
const ROOM_CODE_PATTERN = /^[A-Za-z0-9]{4,12}$/;

function later(callback) {
  setTimeout(callback, 0);
}

function createListeners() {
  const handlers = new Map();
  return {
    on(name, handler) {
      if (typeof handler !== "function") return () => {};
      const list = handlers.get(name) ?? [];
      handlers.set(name, [...list, handler]);
      return () =>
        handlers.set(
          name,
          (handlers.get(name) ?? []).filter((h) => h !== handler),
        );
    },
    emit(name, event) {
      for (const handler of handlers.get(name) ?? []) {
        try {
          handler(event);
        } catch {}
      }
    },
    clear: () => handlers.clear(),
  };
}

export function createMockNet(config, localPeerWire) {
  const members = new Map();
  const outgoingSeq = new Map();
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
      avatarUrl: peer.avatarUrl,
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
      if (index === from || (to !== -1 && index !== to)) continue;
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
      listeners,
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
      },
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
    // Same codes as GameRush: a malformed mode or room code is the game's to fix, a full room
    // is worth retrying later.
    if (!MODE_PATTERN.test(mode)) return failure(CODES.invalidParams, "Invalid mode.");
    if (requested !== undefined && !ROOM_CODE_PATTERN.test(requested)) {
      return failure(CODES.invalidParams, "Invalid room code.");
    }
    const index = nextFreeIndex();
    if (index < 0) return failure(CODES.unavailable, "The mock room is full.");
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
      },
    };
    const info = {
      roomId: `mock:${mode}:${roomCode}`,
      roomCode,
      epoch: 1,
      localPeerIndex: index,
      hostIndex,
      peers: [...peers, localPeerWire(index)],
      transport: "ws",
      serverTimeMs: Date.now(),
    };
    return ok({ source, info });
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
    json: () => decodeJson(message.payload),
  };
}
