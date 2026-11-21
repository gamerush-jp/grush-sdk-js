import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { createGRush } from "../src/sdk.js";

const RUNTIME_NAMES = ["Info", "Player", "Net"];

function rejection(code, message) {
  return Promise.reject(Object.assign(new Error(message), { code }));
}

function installRuntime(protocolVersion, invite) {
  const calls = [];
  globalThis.GRushInfo = { protocolVersion };
  globalThis.GRushPlayer = { getSelf: () => Promise.resolve({ pseudoId: "p1", isGuest: false }) };
  globalThis.GRushNet = {
    room: null,
    join: () => Promise.resolve(null),
    ...(invite
      ? {
          invite: (...args) => {
            calls.push(args);
            return invite();
          },
        }
      : {}),
  };
  return calls;
}

let sdk;

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

test("net.invite asks the runtime without arguments and returns how many were invited", async () => {
  const calls = installRuntime(13, () => Promise.resolve({ status: "sent", count: 3 }));
  assert.deepEqual(await sdk.net.invite(), {
    ok: true,
    value: { status: "sent", count: 3 },
    code: "",
    message: "",
  });
  assert.deepEqual(calls, [[]]);
});

test("net.invite reads anything but a send to someone as cancelled", async () => {
  for (const answer of [
    { status: "cancelled", count: 0 },
    { status: "sent", count: 0 },
    { status: "sent", count: 1.5 },
    { status: "sent" },
    { status: "opened", count: 2 },
  ]) {
    installRuntime(13, () => Promise.resolve(answer));
    assert.deepEqual((await sdk.net.invite()).value, { status: "cancelled", count: 0 });
  }
});

test("net.invite fails as internal when the runtime answers an unreadable value", async () => {
  installRuntime(13, () => Promise.resolve(null));
  assert.equal((await sdk.net.invite()).code, "internal");
});

test("net.invite maps the runtime's rejections to codes", async () => {
  for (const [raw, code] of [
    ["unavailable", "unavailable"],
    ["signInRequired", "signInRequired"],
    ["rateLimited", "rateLimited"],
    ["unsupportedMethod", "unsupported"],
    ["timeout", "timeout"],
    ["mystery", "internal"],
  ]) {
    installRuntime(13, () => rejection(raw, "no"));
    assert.equal((await sdk.net.invite()).code, code);
  }
});

test("net.invite is unsupported below protocol 13 and without a runtime invite", async () => {
  const calls = installRuntime(12, () => Promise.resolve({ status: "sent", count: 1 }));
  assert.equal((await sdk.net.invite()).code, "unsupported");
  assert.equal(calls.length, 0);

  installRuntime(13, null);
  assert.equal((await sdk.net.invite()).code, "unsupported");
});

test("outside GameRush net.invite degrades to unsupported", async () => {
  globalThis.location = { protocol: "https:", hostname: "example.com" };
  assert.equal((await sdk.net.invite()).code, "unsupported");
});

test("the mock invites to the room the game is in", async () => {
  globalThis.location = { protocol: "http:", hostname: "localhost" };
  sdk.mock.reset();
  assert.equal((await sdk.net.invite()).code, "unavailable");

  await sdk.net.join({ mode: "duel", maxPeers: 4 });
  assert.deepEqual((await sdk.net.invite()).value, { status: "sent", count: 1 });

  // The sheet lets the player pick only as many friends as the room has free seats.
  sdk.mock.config.inviteCount = 10;
  assert.deepEqual((await sdk.net.invite()).value, { status: "sent", count: 3 });
  sdk.mock.addPeer("Bot");
  sdk.mock.addPeer("Bot");
  assert.deepEqual((await sdk.net.invite()).value, { status: "sent", count: 1 });
  sdk.mock.addPeer("Bot");
  assert.deepEqual((await sdk.net.invite()).value, { status: "cancelled", count: 0 });

  sdk.mock.reset();
  await sdk.net.join({ maxPeers: 100, topology: "hub" });
  sdk.mock.config.inviteCount = 50;
  assert.deepEqual((await sdk.net.invite()).value, { status: "sent", count: 30 });

  sdk.mock.config.inviteStatus = "cancelled";
  assert.deepEqual((await sdk.net.invite()).value, { status: "cancelled", count: 0 });
  // "cancelled" のほかは、知らない値でも送ったことにする（Godot のモックと同じ）。
  sdk.mock.config.inviteStatus = "mystery";
  assert.deepEqual((await sdk.net.invite()).value, { status: "sent", count: 30 });

  sdk.mock.config.inviteStatus = "sent";
  sdk.mock.config.signedIn = false;
  assert.equal((await sdk.net.invite()).code, "signInRequired");

  await sdk.net.room.leave();
  assert.equal((await sdk.net.invite()).code, "unavailable");

  sdk.mock.reset();
  assert.equal(sdk.mock.config.inviteStatus, "sent");
  assert.equal(sdk.mock.config.inviteCount, 1);
});
