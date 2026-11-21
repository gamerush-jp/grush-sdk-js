import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { createGRush } from "../src/sdk.js";

const RUNTIME_NAMES = ["Info", "Player", "Launch"];

let sdk;

function installRuntime(launch, protocolVersion = 8) {
  globalThis.GRushInfo = { protocolVersion };
  globalThis.GRushPlayer = { getSelf: () => Promise.resolve({ pseudoId: "p1", isGuest: true }) };
  if (launch) globalThis.GRushLaunch = launch;
}

function fakeLaunch(state) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    current: () => state,
    get() {
      calls += 1;
      return Promise.resolve(state ?? { params: {} });
    },
  };
}

beforeEach(() => {
  sdk = createGRush();
});

afterEach(() => {
  for (const name of RUNTIME_NAMES) {
    delete globalThis[`GRush${name}`];
    delete globalThis[`GameRush${name}`];
  }
  delete globalThis.location;
});

test("launch.get and current read the runtime and copy the params", async () => {
  const runtime = fakeLaunch({ params: { item: "sword", dungeon: "3" } });
  installRuntime(runtime);
  const result = await sdk.launch.get();
  assert.deepEqual(result, {
    ok: true,
    value: { params: { item: "sword", dungeon: "3" }, invite: null },
    code: "",
    message: "",
  });
  result.value.params.item = "shield";
  const current = sdk.launch.current();
  assert.deepEqual(current, { params: { item: "sword", dungeon: "3" }, invite: null });
  current.params.extra = "x";
  assert.deepEqual(runtime.current().params, { item: "sword", dungeon: "3" });
});

test("launch.current is null until the runtime has the params", () => {
  installRuntime(fakeLaunch(null));
  assert.equal(sdk.launch.current(), null);
});

test("launch keeps a __proto__ key as a plain param", async () => {
  const params = Object.fromEntries([["__proto__", "x"]]);
  installRuntime(fakeLaunch({ params }));
  const result = await sdk.launch.get();
  assert.equal(Object.getPrototypeOf(result.value.params), Object.prototype);
  assert.deepEqual(Object.keys(result.value.params), ["__proto__"]);
  assert.equal(Object.getOwnPropertyDescriptor(result.value.params, "__proto__").value, "x");
});

test("launch.get fails as internal when the runtime answers an unreadable value", async () => {
  installRuntime({ current: () => ({ params: [] }), get: () => Promise.resolve("nope") });
  assert.equal((await sdk.launch.get()).code, "internal");
  assert.equal(sdk.launch.current(), null);
});

test("launch is unsupported below protocol 8 without breaking the rest", async () => {
  const runtime = fakeLaunch({ params: { item: "sword" } });
  installRuntime(runtime, 7);
  assert.equal((await sdk.launch.get()).code, "unsupported");
  assert.equal(sdk.launch.current(), null);
  assert.equal(runtime.calls, 0);
  assert.equal((await sdk.player.getSelf()).ok, true);
});

test("launch is unsupported when the runtime has no GRushLaunch", async () => {
  installRuntime(null);
  assert.equal((await sdk.launch.get()).code, "unsupported");
  assert.equal(sdk.launch.current(), null);
});

test("the GameRushLaunch alias is accepted too", async () => {
  installRuntime(null);
  globalThis.GameRushLaunch = fakeLaunch({ params: { item: "sword" } });
  assert.equal(sdk.launch.current().params.item, "sword");
  assert.equal((await sdk.launch.get()).value.params.item, "sword");
});

test("the mock returns the configured params", async () => {
  globalThis.location = { protocol: "http:", hostname: "localhost" };
  assert.equal(sdk.backend, "mock");
  assert.deepEqual((await sdk.launch.get()).value, { params: {}, invite: null });
  assert.deepEqual(sdk.launch.current(), { params: {}, invite: null });

  sdk.mock.config.launchParams = { item: "sword", count: 3 };
  assert.deepEqual((await sdk.launch.get()).value, { params: { item: "sword" }, invite: null });
  const current = sdk.launch.current();
  current.params.item = "shield";
  assert.equal(sdk.mock.config.launchParams.item, "sword");

  sdk.mock.reset();
  assert.deepEqual(sdk.mock.config.launchParams, {});
});

test("launch passes the invite room from the runtime", async () => {
  const runtime = fakeLaunch({ params: {}, invite: { mode: "duel", roomCode: "ABCD23" } });
  installRuntime(runtime, 13);
  const result = await sdk.launch.get();
  assert.deepEqual(result.value, { params: {}, invite: { mode: "duel", roomCode: "ABCD23" } });
  result.value.invite.roomCode = "XXXX";
  assert.deepEqual(sdk.launch.current().invite, { mode: "duel", roomCode: "ABCD23" });
});

test("launch reads an invite it cannot use as null", async () => {
  for (const invite of [
    null,
    "duel:ABCD",
    { mode: "duel" },
    { mode: "", roomCode: "ABCD" },
    { mode: 1, roomCode: "ABCD" },
  ]) {
    installRuntime(fakeLaunch({ params: { item: "sword" }, invite }), 13);
    const result = await sdk.launch.get();
    assert.deepEqual(result.value, { params: { item: "sword" }, invite: null });
  }
});

test("an older runtime without invites reads as no invite", async () => {
  installRuntime(fakeLaunch({ params: { item: "sword" } }), 12);
  assert.equal((await sdk.launch.get()).value.invite, null);
  assert.equal(sdk.launch.current().invite, null);
});

test("the mock returns the configured invite room", async () => {
  globalThis.location = { protocol: "http:", hostname: "localhost" };
  sdk.mock.config.launchInvite = { mode: "duel", roomCode: "ABCD23" };
  assert.deepEqual((await sdk.launch.get()).value.invite, { mode: "duel", roomCode: "ABCD23" });
  const joined = await sdk.net.join(sdk.launch.current().invite);
  assert.equal(joined.value.roomCode, "ABCD23");

  sdk.mock.config.launchInvite = { mode: "duel", roomCode: "ab" };
  assert.equal(sdk.launch.current().invite, null);
  sdk.mock.reset();
  assert.equal(sdk.mock.config.launchInvite, null);
});

test("outside GameRush launch degrades to unsupported", async () => {
  globalThis.location = { protocol: "https:", hostname: "example.com" };
  assert.equal((await sdk.launch.get()).code, "unsupported");
  assert.equal(sdk.launch.current(), null);
});
