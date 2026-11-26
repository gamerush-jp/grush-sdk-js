import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { createGRush } from "../src/sdk.js";

// The mock relays each hop on its own setTimeout(0). A fixed-delay wait loses to a hop
// that was scheduled late on a busy runner, so drain timer turns instead: each turn is
// queued after the hops already pending and runs strictly after them.
const flush = async () => {
  for (let turn = 0; turn < 10; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

let sdk;

beforeEach(() => {
  globalThis.location = { protocol: "http:", hostname: "localhost" };
  sdk = createGRush();
});

afterEach(() => {
  delete globalThis.location;
});

test("the mock room relays messages to and from a mock peer", async () => {
  sdk.mock.reset();
  const bot = sdk.mock.addPeer("Bot");
  const heard = [];
  bot.on("message", (message) => {
    heard.push(message.json());
    bot.send(JSON.stringify({ reply: message.json().n }));
  });

  const joined = await sdk.net.join({ mode: "duel" });
  assert.equal(joined.ok, true);
  const room = joined.value;
  assert.equal(sdk.net.room, room);
  assert.deepEqual(
    room.peers.map((peer) => peer.index),
    [0, 1],
  );
  assert.equal(room.hostPeerId, 0);
  assert.equal(room.isHost(), false);

  const received = [];
  room.on("message", (message) => received.push([message.from, message.json(), message.isStale]));
  assert.equal(room.sendJson({ n: 1 }).ok, true);
  await flush();
  assert.deepEqual(heard, [{ n: 1 }]);
  assert.deepEqual(received, [[0, { reply: 1 }, false]]);
  assert.equal(room.lastSeqFrom(0), 1);

  const events = [];
  room.on("peerleave", (event) => events.push(["leave", event.index]));
  room.on("host", (event) => events.push(["host", event.index]));
  sdk.mock.removePeer(bot);
  await flush();
  assert.deepEqual(events, [
    ["leave", 0],
    ["host", 1],
  ]);
  assert.equal(room.isHost(), true);

  assert.equal((await room.leave()).ok, true);
  assert.equal(room.isClosed, true);
  assert.equal(sdk.net.room, null);
  assert.equal(room.send("late").code, "unavailable");
});

test("unreliable messages can be dropped and oversized ones are refused", async () => {
  sdk.mock.reset();
  const bot = sdk.mock.addPeer("Bot");
  const heard = [];
  bot.on("message", (message) => heard.push(message.channel));
  const room = (await sdk.net.join()).value;

  sdk.mock.config.unreliableDropRate = 1;
  room.send("a", { channel: sdk.CHANNEL_UNRELIABLE });
  room.send("b", { channel: sdk.CHANNEL_RELIABLE });
  await flush();
  assert.deepEqual(heard, ["reliable"]);

  assert.equal(room.send(new Uint8Array(sdk.MAX_MESSAGE_BYTES + 1)).code, "invalidParams");
  assert.equal(room.send({ not: "bytes" }).code, "invalidParams");
});

test("raiseRoomError reaches the room later and leaves it open", async () => {
  sdk.mock.reset();
  assert.equal(sdk.mock.raiseRoomError("rateLimited", "outside"), false);
  const room = (await sdk.net.join()).value;
  const errors = [];
  room.on("error", (event) => errors.push(event));
  assert.equal(sdk.mock.raiseRoomError("messageTooLarge", "too big"), true);
  assert.deepEqual(errors, []);
  await flush();
  assert.deepEqual(errors, [{ code: "messageTooLarge", message: "too big" }]);
  assert.equal(room.isClosed, false);
  assert.equal(room.send("still open").ok, true);
  await room.leave();
  assert.equal(sdk.mock.raiseRoomError("rateLimited", "after leave"), false);
});

test("joining again closes the previous room with reason replaced", async () => {
  sdk.mock.reset();
  const first = (await sdk.net.join()).value;
  const reasons = [];
  first.on("close", (event) => reasons.push(event.reason));
  const second = (await sdk.net.join()).value;
  assert.deepEqual(reasons, ["replaced"]);
  assert.equal(first.isClosed, true);
  assert.equal(sdk.net.room, second);
});

test("a peer that reuses a freed index is not treated as stale", async () => {
  sdk.mock.reset();
  const room = (await sdk.net.join()).value;
  const first = sdk.mock.addPeer("First");
  const seen = [];
  room.on("message", (message) => seen.push([message.text(), message.isStale]));
  first.send("a");
  first.send("b");
  await flush();
  sdk.mock.removePeer(first);
  await flush();
  const second = sdk.mock.addPeer("Second");
  assert.equal(second.index, first.index);
  await flush();
  assert.equal(room.lastSeqFrom(second.index), 0);
  second.send("c");
  await flush();
  assert.deepEqual(seen, [
    ["a", false],
    ["b", false],
    ["c", false],
  ]);
});

test("mock rooms follow the server's room code rules", async () => {
  sdk.mock.reset();
  assert.equal((await sdk.net.join({ roomCode: "abcd" })).value.roomCode, "ABCD");
  assert.equal((await sdk.net.join({ roomCode: "WXYZ" })).value.roomCode, "WXYZ");
  assert.equal((await sdk.net.join({ roomCode: "my room" })).code, "invalidParams");
  assert.equal((await sdk.net.join({ roomCode: "ABC" })).code, "invalidParams");
  assert.equal((await sdk.net.join({ roomCode: "ABCDEFGHIJKLM" })).code, "invalidParams");
  assert.equal((await sdk.net.join({ roomCode: "ABCD\n" })).code, "invalidParams");
  assert.equal((await sdk.net.join({ mode: "bad mode" })).code, "invalidParams");
  assert.equal((await sdk.net.join({ mode: "m".repeat(33) })).code, "invalidParams");
  assert.equal((await sdk.net.join({ mode: "ranked:v2.1_a-b" })).ok, true);
  assert.equal((await sdk.net.join({ mode: "m".repeat(32), roomCode: "A1B2C3D4E5F6" })).ok, true);
  assert.equal(sdk.net.room.roomCode, "A1B2C3D4E5F6");
});

test("a room at the target leaves its bots behind and starts a new room", async () => {
  sdk.mock.reset();
  const bots = [1, 2, 3, 4].map((n) => sdk.mock.addPeer(`Bot ${n}`));
  const heard = [];
  bots[0].on("message", (message) => heard.push(message.text()));

  const joined = await sdk.net.join({ targetRoomSize: 4 });

  assert.equal(joined.ok, true);
  const room = joined.value;
  assert.equal(room.roomCode, "MOCKROOM2");
  assert.deepEqual(
    room.peers.map((peer) => peer.index),
    [0],
  );
  assert.equal(room.isHost(), true);

  const received = [];
  room.on("message", (message) => received.push(message.text()));
  bots[0].send("from the old room");
  room.send("to the new room");
  await flush();
  assert.deepEqual(received, []);
  assert.deepEqual(heard, []);

  // Removing a bot that was left behind must not touch the new room.
  sdk.mock.removePeer(bots[1]);
  await flush();
  assert.equal(room.isClosed, false);
  assert.equal((await sdk.net.join({ targetRoomSize: 4 })).value.roomCode, "MOCKROOM2");
});

test("a room below the target keeps its bots", async () => {
  sdk.mock.reset();
  sdk.mock.addPeer("Bot");
  const room = (await sdk.net.join({ targetRoomSize: 2 })).value;
  assert.equal(room.roomCode, "MOCKROOM");
  assert.equal(room.peers.length, 2);
});

test("a requested room ignores the target", async () => {
  sdk.mock.reset();
  sdk.mock.addPeer("Bot");
  const room = (await sdk.net.join({ roomCode: "ABCD", targetRoomSize: 1 })).value;
  assert.equal(room.roomCode, "ABCD");
  assert.equal(room.peers.length, 2);
});

test("the target follows GameRush's range, not maxPeers", async () => {
  sdk.mock.reset();
  sdk.mock.config.maxPeers = 16;
  for (const targetRoomSize of [0, 9, 4.5, "4", null, Number.NaN]) {
    assert.equal((await sdk.net.join({ targetRoomSize })).code, "invalidParams");
  }
  assert.equal((await sdk.net.join({ targetRoomSize: 8 })).ok, true);
});

test("reset starts room names over", async () => {
  sdk.mock.reset();
  sdk.mock.addPeer("Bot");
  assert.equal((await sdk.net.join({ targetRoomSize: 1 })).value.roomCode, "MOCKROOM2");
  sdk.mock.reset();
  sdk.mock.addPeer("Bot");
  assert.equal((await sdk.net.join({ targetRoomSize: 1 })).value.roomCode, "MOCKROOM2");
});

test("a target below the room's limit moves on before the room is full", async () => {
  sdk.mock.reset();
  sdk.mock.config.maxPeers = 2;
  sdk.mock.addPeer("Bot");
  sdk.mock.addPeer("Bot 2");
  const room = (await sdk.net.join({ targetRoomSize: 8 })).value;
  assert.equal(room.roomCode, "MOCKROOM2");
});

test("a full mock room refuses to join with unavailable", async () => {
  sdk.mock.reset();
  sdk.mock.config.maxPeers = 2;
  sdk.mock.addPeer("Bot");
  sdk.mock.addPeer("Bot 2");
  const refused = await sdk.net.join();
  assert.equal(refused.code, "unavailable");
  assert.equal(sdk.net.room, null);
});

test("switching backends leaves the current room instead of abandoning it", async () => {
  sdk.mock.reset();
  const room = (await sdk.net.join()).value;
  const reasons = [];
  room.on("close", (event) => reasons.push(event.reason));
  sdk.configure({ backend: "none" });
  await flush();
  assert.deepEqual(reasons, ["left"]);
  assert.equal(sdk.net.room, null);
});

test("removing a stale peer handle does not evict the peer that reused its index", async () => {
  sdk.mock.reset();
  const room = (await sdk.net.join()).value;
  const first = sdk.mock.addPeer("First");
  sdk.mock.removePeer(first);
  const second = sdk.mock.addPeer("Second");
  sdk.mock.removePeer(first);
  await flush();
  assert.ok(room.peers.some((peer) => peer.index === second.index));
  const heard = [];
  second.on("message", (message) => heard.push(message.isStale));
  room.send("hi");
  await flush();
  assert.deepEqual(heard, [false]);
  sdk.mock.definePlayerState("gone", { a: 1 }, { hidden: true });
  assert.equal((await sdk.playerState.report("gone")).code, "invalidParams");
});

test("mock rooms take the capacity and topology GameRush takes", async () => {
  sdk.mock.reset();
  assert.equal(sdk.protocolVersion(), 15);
  const room = (await sdk.net.join()).value;
  assert.equal(room.maxPeers, 8);
  assert.equal(room.topology, "mesh");
  for (const options of [
    { maxPeers: 0 },
    { maxPeers: 101 },
    { maxPeers: 4.5 },
    { maxPeers: "8" },
    { topology: "star" },
    { maxPeers: 17 },
    { maxPeers: 17, topology: "mesh" },
    { maxPeers: 12, targetRoomSize: 13 },
  ]) {
    assert.equal((await sdk.net.join(options)).code, "invalidParams", JSON.stringify(options));
  }
  const mesh = (await sdk.net.join({ maxPeers: 16, targetRoomSize: 16 })).value;
  assert.equal(mesh.maxPeers, 16);
  const hub = (await sdk.net.join({ maxPeers: 100, topology: "hub", hostSelection: "auto" })).value;
  assert.equal(hub.maxPeers, 100);
  assert.equal(hub.topology, "hub");
});

test("the room's capacity bounds the mock room, and config.maxPeers can make it smaller", async () => {
  sdk.mock.reset();
  const bots = Array.from({ length: 11 }, (_, n) => sdk.mock.addPeer(`Bot ${n}`));
  assert.ok(bots.every((bot) => bot !== null));
  assert.equal((await sdk.net.join({ maxPeers: 12, topology: "hub" })).value.peers.length, 12);
  assert.equal(sdk.mock.addPeer("Late"), null);

  sdk.mock.reset();
  sdk.mock.config.maxPeers = 3;
  sdk.mock.addPeer("A");
  sdk.mock.addPeer("B");
  const room = (await sdk.net.join({ maxPeers: 12 })).value;
  assert.equal(room.maxPeers, 12);
  assert.equal(room.peers.length, 3);
  assert.equal(sdk.mock.addPeer("C"), null);
  await room.leave();
  assert.notEqual(sdk.mock.addPeer("C"), null);
  assert.equal((await sdk.net.join({ maxPeers: 12 })).code, "unavailable");
});

test("a room code with other settings is refused, and without a code the bots stay behind", async () => {
  sdk.mock.reset();
  const bot = sdk.mock.addPeer("Bot");
  const first = (await sdk.net.join({ roomCode: "ABCD", maxPeers: 4 })).value;
  assert.equal(first.peers.length, 2);
  assert.equal(
    (await sdk.net.join({ roomCode: "ABCD", topology: "hub", maxPeers: 4 })).code,
    "invalidParams",
  );
  assert.equal((await sdk.net.join({ roomCode: "ABCD" })).code, "invalidParams");
  assert.equal((await sdk.net.join({ roomCode: "ABCD", maxPeers: 4 })).value.peers.length, 2);

  const other = (await sdk.net.join({ maxPeers: 6 })).value;
  assert.equal(other.roomCode, "MOCKROOM2");
  assert.deepEqual(
    other.peers.map((peer) => peer.index),
    [0],
  );
  const heard = [];
  other.on("message", (message) => heard.push(message.text()));
  bot.send("left behind");
  await flush();
  assert.deepEqual(heard, []);
});

test("in a hub room only the host sends to other players", async () => {
  sdk.mock.reset();
  const host = sdk.mock.addPeer("Host");
  const other = sdk.mock.addPeer("Other");
  const room = (await sdk.net.join({ maxPeers: 4, topology: "hub" })).value;
  assert.equal(room.hostPeerId, host.index);
  const heard = { host: [], other: [] };
  host.on("message", (message) => heard.host.push([message.from, message.text()]));
  other.on("message", (message) => heard.other.push([message.from, message.text()]));
  const received = [];
  room.on("message", (message) => received.push([message.from, message.text()]));
  const errors = [];
  room.on("error", (event) => errors.push(event.code));

  assert.equal(room.send("all").ok, true);
  assert.equal(room.send("host", { to: host.index }).ok, true);
  assert.equal(room.send("other", { to: other.index }).ok, true);
  other.send("bot to me", { to: room.localPeerId });
  other.send("bot to all");
  host.send("from host");
  await flush();

  assert.deepEqual(heard.host, [
    [room.localPeerId, "all"],
    [room.localPeerId, "host"],
    [other.index, "bot to all"],
  ]);
  assert.deepEqual(heard.other, [[host.index, "from host"]]);
  assert.deepEqual(received, [[host.index, "from host"]]);
  assert.deepEqual(errors, ["targetNotAllowed"]);
  assert.equal(room.isClosed, false);
});
