import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { gameJsonError } from "../src/backend-mock.js";
import { createGRush } from "../src/sdk.js";

let sdk;

beforeEach(() => {
  globalThis.location = { protocol: "http:", hostname: "localhost" };
  sdk = createGRush();
});

afterEach(() => {
  delete globalThis.location;
});

test("auto picks the mock on localhost and file://", () => {
  assert.equal(sdk.backend, "mock");
  globalThis.location = { protocol: "file:", hostname: "" };
  assert.equal(sdk.backend, "mock");
});

test("auto degrades to unsupported on the author's own site", async () => {
  globalThis.location = { protocol: "https:", hostname: "example.com" };
  assert.equal(sdk.backend, "none");
  assert.equal(sdk.isAvailable(), false);
  const result = await sdk.player.getSelf();
  assert.deepEqual(result, {
    ok: false,
    value: null,
    code: "unsupported",
    message: "GameRush GameAPI is not available here.",
  });
  assert.equal((await sdk.net.join()).code, "unsupported");
});

test("configure forces a backend", () => {
  sdk.configure({ backend: "none" });
  assert.equal(sdk.backend, "none");
  sdk.configure({ backend: "unknown" });
  assert.equal(sdk.backend, "none");
});

test("profile consent follows the mock config", async () => {
  sdk.mock.reset();
  const before = await sdk.player.getSelf();
  assert.equal(before.value.profileConsent, false);
  assert.equal(before.value.displayName, null);

  const granted = await sdk.player.requestProfile();
  assert.equal(granted.value.displayName, "Local Player");

  sdk.mock.config.grantProfileConsent = false;
  await sdk.player.revokeProfile();
  assert.equal((await sdk.player.requestProfile()).code, "consentDeclined");

  sdk.mock.config.signedIn = false;
  const guest = await sdk.player.requestProfile();
  assert.equal(guest.code, "signInRequired");
  assert.equal((await sdk.player.getSelf()).value.isGuest, true);
});

test("leaderboards reject undeclared keys and out-of-range scores", async () => {
  sdk.mock.reset();
  assert.equal((await sdk.leaderboards.submit("score", 10)).code, "invalidParams");
  sdk.mock.defineLeaderboard("score", { minValue: 0, maxValue: 100 });
  assert.equal((await sdk.leaderboards.submit("score", 101)).code, "invalidParams");

  sdk.mock.addRival("score", "Rival", 50);
  sdk.mock.addRival("score", "Guest", 40, { isGuest: true });
  const first = await sdk.leaderboards.submit("score", 30, { metadata: { stage: 1 } });
  assert.deepEqual(first.value, {
    accepted: true,
    updated: true,
    value: 30,
    rank: 3,
    verified: false,
  });
  const worse = await sdk.leaderboards.submit("score", 20);
  assert.equal(worse.value.updated, false);

  const top = await sdk.leaderboards.top("score", { limit: 2 });
  assert.deepEqual(
    top.value.entries.map((entry) => [entry.rank, entry.displayName, entry.value]),
    [
      [1, "Rival", 50],
      [2, null, 40],
    ],
  );
  assert.equal(top.value.total, 3);
  assert.equal(top.value.verified, false);

  const around = await sdk.leaderboards.aroundMe("score", { range: 1 });
  assert.deepEqual(
    around.value.entries.map((entry) => entry.isSelf),
    [false, true],
  );
  assert.equal((await sdk.leaderboards.friends("score")).code, "consentDeclined");
  assert.deepEqual(
    (await sdk.leaderboards.list()).value.map((board) => board.key),
    ["score"],
  );
});

test("sum leaderboards add up and aroundMe is empty before the first score", async () => {
  sdk.mock.reset();
  sdk.mock.defineLeaderboard("coins", { aggregation: "sum" });
  assert.deepEqual((await sdk.leaderboards.aroundMe("coins")).value.entries, []);
  await sdk.leaderboards.submit("coins", 5);
  const second = await sdk.leaderboards.submit("coins", 7);
  assert.equal(second.value.value, 12);
});

test("player state keeps the server's shape rules", async () => {
  sdk.mock.reset();
  assert.equal((await sdk.playerState.getMine()).value, null);
  assert.equal((await sdk.playerState.setMine([1, 2])).code, "invalidParams");
  assert.equal((await sdk.playerState.setMine({ blob: "A".repeat(300) })).code, "invalidParams");

  const saved = await sdk.playerState.setMine({ level: 3 });
  assert.equal(saved.value.revision, 1);
  assert.equal((await sdk.playerState.setMine({ level: 4 }, 0)).code, "invalidParams");
  assert.equal((await sdk.playerState.setMine({ level: 4 }, 1)).value.revision, 2);

  sdk.mock.definePlayerState("friend", { level: 9 });
  sdk.mock.definePlayerState("hidden", { level: 1 }, { hidden: true });
  const states = await sdk.playerState.get(["friend", "hidden", "missing"]);
  assert.deepEqual(
    states.value.map((state) => [state.pseudoId, state.payload]),
    [["friend", { level: 9 }]],
  );
  assert.equal((await sdk.playerState.report("friend")).value, true);
});

test("player state counts its 4KB limit in UTF-8 bytes, like the server", async () => {
  sdk.mock.reset();
  // {"note":"…"} は 11 バイト。「あ」は UTF-8 で 3 バイトなので、1,361 文字と ASCII 2 文字でちょうど 4,096 バイト。
  const fits = { note: `${"あ".repeat(1361)}ab` };
  const over = { note: `${"あ".repeat(1361)}abc` };
  assert.equal(JSON.stringify(over).length, 1375);
  assert.equal((await sdk.playerState.setMine(fits)).ok, true);
  assert.equal((await sdk.playerState.setMine(over)).code, "invalidParams");
});

// A value nested `depth` levels deep: `[]` is 1, `[[]]` is 2. inner, an array, is the innermost level.
function nested(depth, inner = []) {
  let value = inner;
  for (let level = 1; level < depth; level += 1) value = [value];
  return value;
}

const LONE_HIGH = String.fromCharCode(0xd83d);
const LONE_LOW = String.fromCharCode(0xde00);
const EMOJI = String.fromCodePoint(0x1f600);

test("player state refuses deep nesting and lone surrogates, like the server", async () => {
  sdk.mock.reset();
  const setMine = (payload) => sdk.playerState.setMine(payload);
  assert.equal((await setMine({ a: nested(999) })).ok, true);
  // Up to 3000 levels the depth passes and the next check speaks. Over 3000 levels the depth is
  // reported first.
  assert.equal(
    (await setMine({ a: nested(2999, [LONE_HIGH]) })).message,
    "Player state payload must not contain lone surrogates.",
  );
  const tooDeep = await setMine({ a: nested(3000, [LONE_HIGH]) });
  assert.equal(tooDeep.code, "invalidParams");
  assert.equal(tooDeep.message, "Player state payload is nested too deeply.");
  assert.equal(
    (await setMine({ a: nested(3000) })).message,
    "Player state payload is nested too deeply.",
  );

  for (const payload of [
    { name: LONE_HIGH },
    { name: `a${LONE_LOW}b` },
    { [`k${LONE_HIGH}`]: 1 },
    { list: [{ deep: [LONE_LOW] }] },
  ]) {
    const result = await setMine(payload);
    assert.equal(result.code, "invalidParams");
    assert.equal(result.message, "Player state payload must not contain lone surrogates.");
  }
  // A paired surrogate is one character and is kept.
  const paired = await setMine({ [EMOJI]: `${LONE_HIGH}${LONE_LOW}` });
  assert.deepEqual(paired.value.payload, { [EMOJI]: EMOJI });

  // A value that contains itself is not JSON, and the walk stops on it.
  const loop = { level: 1 };
  loop.self = loop;
  assert.equal((await setMine(loop)).message, "Player state payload must be JSON.");
  // A part shared by several places counts once for each, as JSON.stringify writes it.
  let shared = [0];
  for (let level = 0; level < 20; level += 1) shared = [shared, shared];
  assert.equal((await setMine({ shared })).message, "Player state payload must be JSON.");
});

test("a cloud save refuses deep nesting and lone surrogates, like the server", async () => {
  sdk.mock.reset();
  assert.equal((await sdk.cloudSave.save({ a: nested(999) })).ok, true);
  assert.deepEqual((await sdk.cloudSave.load()).value.payload, { a: nested(999) });

  for (const payload of [
    LONE_HIGH,
    [`x${LONE_LOW}`],
    { [LONE_HIGH]: 1 },
    { a: { b: LONE_HIGH } },
  ]) {
    const result = await sdk.cloudSave.save(payload);
    assert.equal(result.code, "invalidParams");
    assert.equal(result.message, "Cloud save payload must not contain lone surrogates.");
  }
  assert.equal((await sdk.cloudSave.save({ [EMOJI]: [EMOJI] })).ok, true);

  // A cloud save is measured with JSON.stringify before these checks, and in Node JSON.stringify runs
  // out of stack a few thousand levels down. The depth limit is checked on its own here.
  const label = "Cloud save payload";
  assert.equal(gameJsonError(nested(3000), label), null);
  assert.equal(
    gameJsonError(nested(3000, [LONE_HIGH]), label),
    "Cloud save payload must not contain lone surrogates.",
  );
  assert.equal(gameJsonError(nested(3001), label), "Cloud save payload is nested too deeply.");
  assert.equal(
    gameJsonError({ a: nested(3000) }, label),
    "Cloud save payload is nested too deeply.",
  );
  // A deep value with a lone surrogate is reported as too deep, as on the server.
  assert.equal(
    gameJsonError(nested(3001, [LONE_HIGH]), label),
    "Cloud save payload is nested too deeply.",
  );

  // A save on the device does not go to GameRush, so these limits do not apply to it.
  sdk.mock.config.signedIn = false;
  const local = { fallback: "local" };
  assert.equal((await sdk.cloudSave.save({ a: LONE_HIGH }, "default", local)).ok, true);
  assert.equal((await sdk.cloudSave.save({ a: LONE_HIGH })).code, "signInRequired");
});

test("cloud save round-trips and guests get signInRequired", async () => {
  sdk.mock.reset();
  assert.equal((await sdk.cloudSave.load()).value, null);
  const saved = await sdk.cloudSave.save({ coins: 3 });
  assert.equal(saved.value.slot, "default");
  assert.equal(
    (await sdk.cloudSave.save({ coins: 4 }, "default", { baseRevision: 0 })).code,
    "conflict",
  );
  assert.deepEqual((await sdk.cloudSave.load("default")).value.payload, { coins: 3 });
  assert.equal((await sdk.cloudSave.load("bad slot")).code, "invalidParams");
  assert.equal((await sdk.cloudSave.remove()).value, true);

  sdk.mock.config.signedIn = false;
  assert.equal((await sdk.cloudSave.load()).code, "signInRequired");
});

test("a guest's local save moves to the cloud after signing in", async () => {
  sdk.mock.reset();
  assert.equal(sdk.protocolVersion(), 10);
  sdk.mock.config.signedIn = false;
  const local = { fallback: "local" };
  assert.equal((await sdk.cloudSave.load("default", local)).value, null);
  const saved = await sdk.cloudSave.save({ coins: 1 }, "default", { ...local, baseRevision: 7 });
  assert.equal(saved.value.storage, "local");
  assert.equal(saved.value.revision, 0);
  const again = await sdk.cloudSave.save({ coins: 2 }, "default", local);
  assert.equal(again.value.createdAt, saved.value.createdAt);
  assert.deepEqual((await sdk.cloudSave.load("default", local)).value.payload, { coins: 2 });
  assert.equal((await sdk.cloudSave.load()).code, "signInRequired");
  assert.equal((await sdk.cloudSave.save({ coins: 3 })).code, "signInRequired");

  sdk.mock.config.signedIn = true;
  assert.equal((await sdk.cloudSave.load()).value, null);
  const found = (await sdk.cloudSave.load("default", local)).value;
  assert.equal(found.storage, "local");
  const uploaded = await sdk.cloudSave.save(found.payload, "default", {
    ...local,
    baseRevision: found.revision,
  });
  assert.equal(uploaded.value.storage, "cloud");
  assert.equal(uploaded.value.revision, 1);

  sdk.mock.config.signedIn = false;
  assert.equal((await sdk.cloudSave.load("default", local)).value, null);
});

test("a cloud save wins over a local one, and a stale local revision conflicts", async () => {
  sdk.mock.reset();
  sdk.mock.config.signedIn = false;
  const local = { fallback: "local" };
  await sdk.cloudSave.save({ coins: 1 }, "default", local);
  sdk.mock.config.signedIn = true;
  await sdk.cloudSave.save({ coins: 9 });
  const loaded = (await sdk.cloudSave.load("default", local)).value;
  assert.equal(loaded.storage, "cloud");
  assert.deepEqual(loaded.payload, { coins: 9 });
  assert.equal(
    (await sdk.cloudSave.save({ coins: 1 }, "default", { ...local, baseRevision: 0 })).code,
    "conflict",
  );
  assert.equal((await sdk.cloudSave.remove("default", local)).value, true);
  sdk.mock.config.signedIn = false;
  assert.equal((await sdk.cloudSave.load("default", local)).value, null);
});

test("local saves are dropped by remove and reset, and bad fallbacks are rejected", async () => {
  sdk.mock.reset();
  sdk.mock.config.signedIn = false;
  const local = { fallback: "local" };
  await sdk.cloudSave.save({ coins: 1 }, "a", local);
  await sdk.cloudSave.save({ coins: 2 }, "b", local);
  assert.equal((await sdk.cloudSave.remove("a", local)).value, true);
  assert.equal((await sdk.cloudSave.load("a", local)).value, null);
  assert.equal((await sdk.cloudSave.remove("a")).code, "signInRequired");
  assert.equal((await sdk.cloudSave.load("b", null)).code, "signInRequired");
  assert.equal((await sdk.cloudSave.load("b", { fallback: null })).code, "signInRequired");

  for (const fallback of ["cloud", "LOCAL", 1, true, {}]) {
    assert.equal((await sdk.cloudSave.load("b", { fallback })).code, "invalidParams");
    assert.equal((await sdk.cloudSave.save({ c: 1 }, "b", { fallback })).code, "invalidParams");
    assert.equal((await sdk.cloudSave.remove("b", { fallback })).code, "invalidParams");
  }
  assert.equal((await sdk.cloudSave.load("bad slot", local)).code, "invalidParams");
  assert.equal((await sdk.cloudSave.save(null, "b", local)).code, "invalidParams");

  sdk.mock.reset();
  sdk.mock.config.signedIn = false;
  assert.equal((await sdk.cloudSave.load("b", local)).value, null);
});

test("null options and unserializable values come back as results, not exceptions", async () => {
  sdk.mock.reset();
  sdk.mock.defineLeaderboard("score");
  assert.equal((await sdk.leaderboards.submit("score", 1, null)).ok, true);
  assert.equal((await sdk.leaderboards.top("score", null)).ok, true);
  assert.equal((await sdk.cloudSave.save({ a: 1 }, "default", null)).ok, true);
  assert.equal((await sdk.playerState.setMine({ a: 1n })).code, "invalidParams");
  assert.equal((await sdk.cloudSave.save({ run() {} })).code, "invalidParams");
  const room = (await sdk.net.join(null)).value;
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(room.sendJson(cyclic).code, "invalidParams");
  assert.equal(room.send("x", null).ok, true);
  sdk.configure(null);
  assert.equal(sdk.backend, "mock");
});

test("the mock checks value types like the server", async () => {
  sdk.mock.reset();
  sdk.mock.defineLeaderboard("score");
  sdk.mock.defineLeaderboard("time", { valueType: "duration_ms", sort: "asc" });
  sdk.mock.defineLeaderboard("speed", { valueType: "float", aggregation: "last" });
  assert.equal((await sdk.leaderboards.submit("score", 1.5)).code, "invalidParams");
  assert.equal((await sdk.leaderboards.submit("time", -1)).code, "invalidParams");
  assert.equal((await sdk.leaderboards.submit("speed", 1.5)).value.updated, true);
  assert.equal((await sdk.leaderboards.submit("speed", 1.5)).value.updated, false);
});

test("reports need sign-in and an existing state, and reads are copies", async () => {
  sdk.mock.reset();
  assert.equal((await sdk.playerState.get([])).code, "invalidParams");
  assert.equal((await sdk.playerState.report("nobody")).code, "invalidParams");
  sdk.mock.config.signedIn = false;
  sdk.mock.definePlayerState("friend", { level: 1 });
  assert.equal((await sdk.playerState.report("friend")).code, "signInRequired");

  sdk.mock.config.signedIn = true;
  await sdk.cloudSave.save({ coins: 1 });
  const loaded = await sdk.cloudSave.load();
  loaded.value.payload.coins = 99;
  assert.deepEqual((await sdk.cloudSave.load()).value.payload, { coins: 1 });
});

test("only whole base64-like strings count as opaque, like the server", async () => {
  sdk.mock.reset();
  assert.equal((await sdk.playerState.setMine({ note: `${"A".repeat(300)}!` })).ok, true);
  assert.equal((await sdk.playerState.setMine({ list: ["B".repeat(256)] })).code, "invalidParams");
});
