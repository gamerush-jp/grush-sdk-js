import { decodeJson, decodeText, MAX_MESSAGE_BYTES, toBytes } from "./bytes.js";
import { peerOf } from "./normalize.js";
import { CODES, failure, failureFromError, ok } from "./result.js";

const DEFAULT_MAX_PEERS = 8;
const EVENTS = ["message", "peerjoin", "peerleave", "host", "transportchange", "error", "close"];

export function createRoom(source, info, onClosed) {
  const listeners = new Map(EVENTS.map((name) => [name, []]));
  const lastSeq = new Map();
  const serverOffsetMs =
    (typeof info.serverTimeMs === "number" ? info.serverTimeMs : Date.now()) - Date.now();
  let peers = Array.isArray(info.peers) ? info.peers.map(peerOf) : [];
  let hostPeerId = typeof info.hostIndex === "number" ? info.hostIndex : 0;
  let transport = typeof info.transport === "string" ? info.transport : "ws";
  let closed = false;
  const unsubscribers = [];

  function emit(name, event) {
    for (const handler of listeners.get(name) ?? []) {
      try {
        handler(event);
      } catch {}
    }
  }

  function markClosed(reason) {
    if (closed) return;
    closed = true;
    peers = [];
    for (const unsubscribe of unsubscribers.splice(0)) {
      try {
        unsubscribe?.();
      } catch {}
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
        json: () => decodeJson(payload),
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
        message: typeof raw?.message === "string" ? raw.message : "",
      });
    },
    close(raw) {
      markClosed(typeof raw?.reason === "string" ? raw.reason : "");
    },
  };

  const room = {
    roomId: typeof info.roomId === "string" ? info.roomId : "",
    roomCode: typeof info.roomCode === "string" ? info.roomCode : "",
    roomEpoch: typeof info.epoch === "number" ? info.epoch : 0,
    localPeerId: typeof info.localPeerIndex === "number" ? info.localPeerIndex : 0,
    // GameRush before protocol 11 has no room settings and puts every game in an 8-player mesh room.
    maxPeers: typeof info.maxPeers === "number" ? info.maxPeers : DEFAULT_MAX_PEERS,
    topology: info.topology === "hub" ? "hub" : "mesh",
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
      if (!list || typeof handler !== "function") return () => {};
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
          "Payload must be an ArrayBuffer, a typed array, or a string.",
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
          error instanceof Error ? error.message : "Value is not JSON.",
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
    closeLocally: (reason) => markClosed(reason),
  };

  for (const name of EVENTS) {
    unsubscribers.push(source.on(name, (event) => handlers[name](event)));
  }

  return room;
}
