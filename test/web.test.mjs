import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { createGRush } from "../src/sdk.js";

const RUNTIME_NAMES = ["Info", "Player", "Leaderboards", "PlayerState", "Net", "CloudSave"];

function rejection(code, message, extra = {}) {
  return Promise.reject(Object.assign(new Error(message), { code }, extra));
}

function createRuntimeRoom() {
  const listeners = {};
  const sent = [];
  const room = {
    left: false,
    sent,
    fire(name, event) {
      for (const handler of listeners[name] ?? []) handler(event);
    },
    on(name, handler) {
      listeners[name] = [...(listeners[name] ?? []), handler];
      return () => {
        listeners[name] = listeners[name].filter((h) => h !== handler);
      };
    },
    listenerCount: (name) => (listeners[name] ?? []).length,
    send: (payload, options) => sent.push([payload, options]),
    leave: async () => {
      room.left = true;
      return true;
    },
    describe: () => ({
      roomId: "room-1",
      roomCode: "ABCD",
      epoch: 3,
      localPeerIndex: 1,
      hostIndex: 0,
      peers: [
        { index: 0, pseudoId: "p0", displayName: "Host", avatarUrl: null },
        { index: 1, pseudoId: "p1", displayName: null, avatarUrl: null },
      ],
      transport: "ws",
      serverTimeMs: Date.now() + 1000,
    }),
  };
  return room;
}

function installRuntime(protocolVersion = 2) {
  const calls = [];
  const record =
    (name, value) =>
    (...args) => {
      calls.push([name, ...args]);
      return typeof value === "function" ? value(...args) : Promise.resolve(value);
    };
  const runtime = {
    Info: { protocolVersion },
    Player: {
      getSelf: record("getSelf", {
        pseudoId: "p1",
        isGuest: false,
        profileConsent: false,
        profile: { displayName: "Hidden", avatarUrl: null },
      }),
      requestProfile: record("requestProfile", () => rejection("consentDeclined", "no")),
      revokeProfile: record("revokeProfile", () => rejection("mystery", "odd")),
    },
    Leaderboards: {
      list: record("list", [{ key: "score", title: "Score", sort: "asc" }]),
      submit: record("submit", {
        accepted: true,
        updated: true,
        value: 5,
        rank: 2,
        verified: true,
      }),
      top: record("top", {
        key: "score",
        entries: [{ rank: 1, value: 9 }],
        total: 1,
        verified: true,
      }),
      aroundMe: record("aroundMe", () =>
        rejection("rateLimited", "slow down", { retryAfterMs: 500 }),
      ),
      friends: record("friends", () => rejection("unsupportedMethod", "nope")),
    },
    PlayerState: {
      getMine: record("getMine", null),
      setMine: record("setMine", {
        pseudoId: "p1",
        payload: { a: 1 },
        revision: 2,
        updatedAt: "t",
      }),
      get: record("get", [{ pseudoId: "p2", payload: { b: 2 }, revision: 1, updatedAt: "t" }]),
      report: record("report", true),
    },
    Net: {
      room: null,
      join: record("join", () => {
        runtime.Net.room = createRuntimeRoom();
        return Promise.resolve(runtime.Net.room);
      }),
    },
    CloudSave: {
      loadWithMetadata: record("load", { slot: "default", payload: { c: 1 }, revision: 4 }),
      save: record("save", () =>
        Promise.reject(Object.assign(new Error("conflict"), { status: 409 })),
      ),
      remove: record("remove", () => Promise.reject(new Error("Cloud save request timed out."))),
    },
  };
  for (const name of RUNTIME_NAMES) globalThis[`GRush${name}`] = runtime[name];
  return { runtime, calls };
}

let sdk;
let runtime;
let calls;

beforeEach(() => {
  ({ runtime, calls } = installRuntime());
  sdk = createGRush();
});

afterEach(() => {
  for (const name of RUNTIME_NAMES) {
    delete globalThis[`GRush${name}`];
    delete globalThis[`GameRush${name}`];
  }
});

test("auto picks the injected runtime", () => {
  assert.equal(sdk.backend, "web");
  assert.equal(sdk.protocolVersion(), 2);
  assert.equal(sdk.isAvailable(), true);
});

test("the GameRush-prefixed aliases are accepted too", () => {
  for (const name of RUNTIME_NAMES) {
    globalThis[`GameRush${name}`] = globalThis[`GRush${name}`];
    delete globalThis[`GRush${name}`];
  }
  assert.equal(sdk.backend, "web");
});

test("player results hide the profile until consent", async () => {
  const self = await sdk.player.getSelf();
  assert.deepEqual(self.value, {
    pseudoId: "p1",
    isGuest: false,
    profileConsent: false,
    displayName: null,
    avatarUrl: null,
  });
  assert.equal((await sdk.player.requestProfile()).code, "consentDeclined");
  assert.equal((await sdk.player.revokeProfile()).code, "internal");
});

test("leaderboard calls reach the runtime with the documented arguments", async () => {
  const submitted = await sdk.leaderboards.submit("score", 5, {
    metadata: { m: 1 },
    operationId: "op-1",
  });
  assert.deepEqual(calls.at(-1), ["submit", "score", 5, { m: 1 }, "op-1"]);
  assert.equal(submitted.value.verified, false);

  const top = await sdk.leaderboards.top("score", { limit: 3, offset: 1, range: 9 });
  assert.deepEqual(calls.at(-1), ["top", "score", { key: "score", limit: 3, offset: 1 }]);
  assert.equal(top.value.verified, false);
  assert.equal(top.value.entries[0].isGuest, true);

  const around = await sdk.leaderboards.aroundMe("score");
  assert.equal(around.code, "rateLimited");
  assert.equal(around.retryAfterMs, 500);
  assert.equal((await sdk.leaderboards.friends("score")).code, "unsupported");
  assert.equal((await sdk.leaderboards.list()).value[0].sort, "asc");
});

test("player state needs protocol 2 while the rest keeps working", async () => {
  assert.equal((await sdk.playerState.setMine({ a: 1 }, 1)).value.revision, 2);
  assert.deepEqual(calls.at(-1), ["setMine", { a: 1 }, 1]);
  assert.equal((await sdk.playerState.get(["p2"])).value[0].pseudoId, "p2");
  assert.equal((await sdk.playerState.getMine()).value, null);

  runtime.Info.protocolVersion = 1;
  assert.equal((await sdk.playerState.report("p2")).code, "unsupported");
  assert.equal((await sdk.player.getSelf()).ok, true);
});

test("cloud save failures map to codes", async () => {
  assert.equal((await sdk.cloudSave.load()).value.revision, 4);
  assert.equal(
    (await sdk.cloudSave.save({ c: 2 }, "default", { baseRevision: 1 })).code,
    "conflict",
  );
  assert.deepEqual(calls.at(-1), ["save", { c: 2 }, "default", { baseRevision: 1 }]);
  assert.equal((await sdk.cloudSave.remove()).code, "timeout");

  delete globalThis.GRushCloudSave;
  assert.equal((await sdk.cloudSave.load()).code, "unsupported");
});

test("cloud save passes fallback only to a runtime of protocol 5 or later", async () => {
  runtime.CloudSave.save = (...args) => {
    calls.push(["save", ...args]);
    return Promise.resolve({ slot: "default", payload: args[0], revision: 1 });
  };
  runtime.CloudSave.remove = (...args) => {
    calls.push(["remove", ...args]);
    return Promise.resolve(true);
  };

  runtime.Info.protocolVersion = 4;
  await sdk.cloudSave.load("default", { fallback: "local" });
  assert.deepEqual(calls.at(-1), ["load", "default", {}]);
  const old = await sdk.cloudSave.save({ c: 2 }, "default", { baseRevision: 0, fallback: "local" });
  assert.equal(old.ok, true);
  assert.deepEqual(calls.at(-1), ["save", { c: 2 }, "default", { baseRevision: 0 }]);
  await sdk.cloudSave.remove("default", { fallback: "local" });
  assert.deepEqual(calls.at(-1), ["remove", "default", {}]);

  runtime.Info.protocolVersion = 5;
  await sdk.cloudSave.load("default", { fallback: "local" });
  assert.deepEqual(calls.at(-1), ["load", "default", { fallback: "local" }]);
  await sdk.cloudSave.save({ c: 2 }, "default", { baseRevision: 0, fallback: "local" });
  assert.deepEqual(calls.at(-1), [
    "save",
    { c: 2 },
    "default",
    { fallback: "local", baseRevision: 0 },
  ]);
  await sdk.cloudSave.remove("default", { fallback: "local" });
  assert.deepEqual(calls.at(-1), ["remove", "default", { fallback: "local" }]);

  await sdk.cloudSave.save({ c: 2 }, "default", { baseRevision: 3 });
  assert.deepEqual(calls.at(-1), ["save", { c: 2 }, "default", { baseRevision: 3 }]);
  await sdk.cloudSave.load("default", null);
  assert.deepEqual(calls.at(-1), ["load", "default", {}]);
});

test("cloud save tells where the save lives and checks fallback in the runtime", async () => {
  runtime.Info.protocolVersion = 5;
  assert.equal((await sdk.cloudSave.load()).value.storage, "cloud");

  runtime.CloudSave.loadWithMetadata = () =>
    Promise.resolve({ slot: "default", payload: { c: 1 }, revision: 0, storage: "local" });
  assert.equal((await sdk.cloudSave.load()).value.storage, "local");

  runtime.CloudSave.loadWithMetadata = () =>
    Promise.resolve({ slot: "default", payload: { c: 1 }, revision: 1, storage: "somewhere" });
  assert.equal((await sdk.cloudSave.load()).value.storage, "cloud");

  // A save GameRush only kept on the device reports synced: false. Older GameRush omits the field
  // and answers after the write, so a cloud save without it is synced. A device save never is.
  runtime.CloudSave.loadWithMetadata = () =>
    Promise.resolve({
      slot: "default",
      payload: { c: 1 },
      revision: 2,
      storage: "cloud",
      synced: false,
    });
  assert.equal((await sdk.cloudSave.load()).value.synced, false);
  runtime.CloudSave.loadWithMetadata = () =>
    Promise.resolve({ slot: "default", payload: { c: 1 }, revision: 2, storage: "cloud" });
  assert.equal((await sdk.cloudSave.load()).value.synced, true);
  runtime.CloudSave.loadWithMetadata = () =>
    Promise.resolve({ slot: "default", payload: { c: 1 }, revision: 0, storage: "local" });
  assert.equal((await sdk.cloudSave.load()).value.synced, false);

  runtime.CloudSave.save = () => Promise.reject(new Error("Invalid cloud save fallback."));
  assert.equal(
    (await sdk.cloudSave.save({ c: 1 }, "default", { fallback: "disk" })).code,
    "invalidParams",
  );
  runtime.CloudSave.save = () =>
    Promise.reject(Object.assign(new Error("Local save failed."), { status: 0 }));
  assert.equal(
    (await sdk.cloudSave.save({ c: 1 }, "default", { fallback: "local" })).code,
    "unavailable",
  );
});

test("rooms wrap the runtime room and normalize its events", async () => {
  const room = (await sdk.net.join({ mode: "duel", roomCode: "ABCD" })).value;
  assert.deepEqual(calls.at(-1), ["join", { mode: "duel", roomCode: "ABCD" }]);
  const runtimeRoom = runtime.Net.room;
  assert.equal(room.roomEpoch, 3);
  assert.equal(room.hostPeerId, 0);
  assert.ok(room.serverTimeMs() - Date.now() > 900);

  assert.equal(room.send(new Uint8Array([1, 2]), { channel: "unreliable", to: 0 }).ok, true);
  const [bytes, options] = runtimeRoom.sent[0];
  assert.deepEqual([...new Uint8Array(bytes)], [1, 2]);
  assert.deepEqual(options, { channel: "unreliable", to: 0 });

  const seen = [];
  room.on("message", (message) => seen.push([message.text(), message.isStale]));
  room.on("peerjoin", (peer) => seen.push(["join", peer.index, peer.displayName]));
  room.on("host", (event) => seen.push(["host", event.index]));
  const payload = new TextEncoder().encode("hi").buffer;
  runtimeRoom.fire("message", { from: 0, channel: "reliable", seq: 2, payload });
  runtimeRoom.fire("message", { from: 0, channel: "reliable", seq: 1, payload });
  runtimeRoom.fire("peerjoin", { index: 2, pseudoId: "p2" });
  runtimeRoom.fire("host", { index: 1 });
  runtimeRoom.fire("future-event", {});
  assert.deepEqual(seen, [
    ["hi", false],
    ["hi", true],
    ["join", 2, null],
    ["host", 1],
  ]);
  assert.equal(room.isHost(), true);
  assert.equal(room.peers.length, 3);

  const errors = [];
  room.on("error", (event) => errors.push(event));
  runtimeRoom.fire("error", { code: "rateLimited", message: "m" });
  runtimeRoom.fire("error", { code: 7, message: null });
  assert.deepEqual(errors, [
    { code: "rateLimited", message: "m" },
    { code: "", message: "" },
  ]);
  assert.equal(room.isClosed, false);
  assert.equal(sdk.net.room, room);

  const closes = [];
  room.on("close", (event) => closes.push(event.reason));
  runtimeRoom.fire("close", { reason: "kicked" });
  assert.deepEqual(closes, ["kicked"]);
  assert.equal(sdk.net.room, null);
  assert.equal(runtimeRoom.listenerCount("message"), 0);
});

test("room settings on join need protocol 11 and reach the runtime as given", async () => {
  const previous = (await sdk.net.join()).value;
  assert.equal(previous.maxPeers, 8);
  assert.equal(previous.topology, "mesh");

  runtime.Info.protocolVersion = 10;
  const joinsBefore = calls.length;
  for (const options of [{ maxPeers: 12 }, { topology: "hub" }, { hostSelection: "auto" }]) {
    assert.equal((await sdk.net.join({ mode: "arena", ...options })).code, "unsupported");
  }
  assert.equal(calls.length, joinsBefore);
  assert.equal(previous.isClosed, false);
  assert.equal((await sdk.net.join({ mode: "arena", targetRoomSize: 4 })).ok, true);

  runtime.Info.protocolVersion = 11;
  const plainJoin = runtime.Net.join;
  runtime.Net.join = (params) =>
    plainJoin(params).then((room) => {
      const info = room.describe();
      room.describe = () => ({ ...info, maxPeers: 12, topology: "hub" });
      return room;
    });
  const room = (
    await sdk.net.join({
      mode: "arena",
      targetRoomSize: 6,
      maxPeers: 12,
      topology: "hub",
      hostSelection: "auto",
    })
  ).value;
  assert.deepEqual(calls.at(-1), [
    "join",
    { mode: "arena", targetRoomSize: 6, maxPeers: 12, topology: "hub", hostSelection: "auto" },
  ]);
  assert.equal(room.maxPeers, 12);
  assert.equal(room.topology, "hub");

  // Values are GameRush's to check, so the SDK passes on even ones GameRush refuses.
  await sdk.net.join({ maxPeers: "12", topology: "star" });
  assert.deepEqual(calls.at(-1), ["join", { mode: "default", maxPeers: "12", topology: "star" }]);
});

test("leave asks the runtime and closes the room", async () => {
  const room = (await sdk.net.join()).value;
  assert.deepEqual(calls.at(-1), ["join", { mode: "default" }]);
  const runtimeRoom = runtime.Net.room;
  assert.deepEqual(await room.leave(), { ok: true, value: true, code: "", message: "" });
  assert.equal(runtimeRoom.left, true);
  assert.equal(room.isClosed, true);
});

test("unreadable runtime answers are failures, not empty successes", async () => {
  runtime.Player.getSelf = () => Promise.resolve(null);
  assert.equal((await sdk.player.getSelf()).code, "internal");
  runtime.PlayerState.get = () => Promise.resolve([null, { pseudoId: "p3", payload: {} }]);
  const states = await sdk.playerState.get(["p3"]);
  assert.deepEqual(
    states.value.map((state) => state.pseudoId),
    ["p3"],
  );
});
