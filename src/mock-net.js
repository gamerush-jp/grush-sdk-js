import { decodeJson, decodeText, toBytes } from "./bytes.js";
import { CODES, failure, ok } from "./result.js";

const MODE_PATTERN = /^[A-Za-z0-9._:-]{1,32}$/;
const ROOM_CODE_PATTERN = /^[A-Za-z0-9]{4,12}$/;
// GameRush's room settings, not config.maxPeers: the mock refuses what GameRush refuses.
const DEFAULT_ROOM = { maxPeers: 8, topology: "mesh" };
const MAX_PEERS_LIMIT = 100;
const MESH_MAX_PEERS = 16;

// Same rules as GameRush: an integer capacity of 1 to 100, "mesh" or "hub", and a mesh of at most 16.
function roomSettingsOf(params) {
  const maxPeers = params.maxPeers === undefined ? DEFAULT_ROOM.maxPeers : params.maxPeers;
  if (!Number.isInteger(maxPeers) || maxPeers < 1 || maxPeers > MAX_PEERS_LIMIT) return null;
  const topology = params.topology === undefined ? DEFAULT_ROOM.topology : params.topology;
  if (topology !== "mesh" && topology !== "hub") return null;
  if (topology === "mesh" && maxPeers > MESH_MAX_PEERS) return null;
  return { maxPeers, topology };
}

function sameSettings(a, b) {
  return a.maxPeers === b.maxPeers && a.topology === b.topology;
}

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
  let roomMode = "";
  let roomCode = "";
  let hostIndex = -1;
  let peerSerial = 0;
  let roomSerial = 1;
  // The settings of the room the bots are in. null until the game joins, so bots added before the
  // first join wait in whatever room the game asks for.
  let settings = null;

  // config.maxPeers lets the author try a full room without filling the room's capacity.
  function capacity() {
    return Math.min(settings?.maxPeers ?? MAX_PEERS_LIMIT, config.maxPeers);
  }

  function nextFreeIndex() {
    for (let index = 0; index < capacity(); index += 1) {
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
    let to = typeof options.to === "number" ? options.to : -1;
    // In a hub room, everyone but the host sends only to the host. A message to everyone goes to the
    // host, and one to anyone else is dropped with targetNotAllowed, as GameRush does.
    if (settings?.topology === "hub" && from !== hostIndex) {
      if (to !== -1 && to !== hostIndex) {
        if (from === localIndex) {
          announceToLocal("error", {
            code: "targetNotAllowed",
            message: "In a hub room, only the host can send to other players.",
          });
        }
        return;
      }
      to = hostIndex;
    }
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
    if (members.size === 0) settings = null;
  }

  // The mock holds one room, so a room at the target stands for every room being at the target.
  // The game moves to a new room and the bots stay behind.
  function startNextRoom() {
    for (const peer of members.values()) peer.listeners.clear();
    members.clear();
    outgoingSeq.clear();
    roomSerial += 1;
    roomCode = `MOCKROOM${roomSerial}`;
    settings = null;
  }

  function join(params) {
    leave();
    const mode = params.mode ?? "default";
    const requested = params.roomCode;
    const target = params.targetRoomSize;
    // Same codes as GameRush: a malformed mode, room code or target is the game's to fix, a full
    // room is worth retrying later.
    if (!MODE_PATTERN.test(mode)) return failure(CODES.invalidParams, "Invalid mode.");
    if (requested !== undefined && !ROOM_CODE_PATTERN.test(requested)) {
      return failure(CODES.invalidParams, "Invalid room code.");
    }
    const wanted = roomSettingsOf(params);
    if (!wanted) return failure(CODES.invalidParams, "Invalid room capacity or topology.");
    if (
      target !== undefined &&
      !(Number.isInteger(target) && target >= 1 && target <= wanted.maxPeers)
    ) {
      return failure(CODES.invalidParams, "Invalid target room size.");
    }
    if (settings && !sameSettings(settings, wanted)) {
      // A requested room already exists with other settings. Without a code, GameRush would pick a
      // room with the asked settings, which is a different room from the one the bots are in.
      if (requested !== undefined) {
        return failure(CODES.invalidParams, "The room exists with another capacity or topology.");
      }
      startNextRoom();
    }
    settings = wanted;
    if (
      requested === undefined &&
      target !== undefined &&
      members.size >= Math.min(target, capacity())
    ) {
      startNextRoom();
      settings = wanted;
    }
    const index = nextFreeIndex();
    if (index < 0) return failure(CODES.unavailable, "The mock room is full.");
    roomCode = requested ? requested.toUpperCase() : roomCode || "MOCKROOM";
    roomMode = mode;
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
      maxPeers: wanted.maxPeers,
      topology: wanted.topology,
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

  // The room the game is in, with its free seats, or null outside a room. GameRush invites to this room.
  function current() {
    if (localIndex < 0) return null;
    const seats = Math.max(0, capacity() - members.size - 1);
    return { mode: roomMode, roomCode, seats };
  }

  function reset() {
    for (const peer of members.values()) peer.listeners.clear();
    members.clear();
    outgoingSeq.clear();
    leave();
    roomCode = "";
    roomMode = "";
    roomSerial = 1;
    hostIndex = -1;
    settings = null;
  }

  return { join, current, addPeer, removePeer, raiseError, reset };
}

function withDecoders(message) {
  return {
    ...message,
    isStale: false,
    text: () => decodeText(message.payload),
    json: () => decodeJson(message.payload),
  };
}
