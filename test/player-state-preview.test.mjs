import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { createGRush } from "../src/sdk.js";

const RUNTIME_NAMES = ["Info", "Player", "PlayerState"];

const STATE = {
  pseudoId: "p2",
  payload: { deck: "fire", level: 12 },
  revision: 3,
  rating: 1520,
  updatedAt: "2026-10-01T00:00:00.000Z",
};

let sdk;

function installRuntime(playerState, protocolVersion = 10) {
  globalThis.GRushInfo = { protocolVersion };
  globalThis.GRushPlayer = { getSelf: () => Promise.resolve({ pseudoId: "p1", isGuest: true }) };
  if (playerState) globalThis.GRushPlayerState = playerState;
}

// Like the runtime, it holds one handler and replaces it on the next registration.
function fakePlayerState() {
  const runtime = {
    handler: null,
    registrations: 0,
    onPreview(handler) {
      if (typeof handler !== "function") throw new TypeError("not a function");
      runtime.registrations += 1;
      runtime.handler = handler;
      return () => {
        if (runtime.handler === handler) runtime.handler = null;
      };
    },
  };
  return runtime;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

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

test("onPreview registers on the runtime from protocol 10 and hands over a player state", () => {
  const runtime = fakePlayerState();
  installRuntime(runtime);
  const seen = [];
  sdk.playerState.onPreview((state) => seen.push(state));
  assert.equal(runtime.registrations, 1);
  runtime.handler(structuredClone(STATE));
  assert.deepEqual(seen, [STATE]);
});

test("onPreview fills a missing rating the same way as the other player state calls", () => {
  const runtime = fakePlayerState();
  installRuntime(runtime);
  const seen = [];
  sdk.playerState.onPreview((state) => seen.push(state));
  runtime.handler({ pseudoId: "p2", payload: { level: 1 }, revision: 1, updatedAt: "t" });
  runtime.handler(null);
  assert.deepEqual(seen, [
    { pseudoId: "p2", payload: { level: 1 }, revision: 1, rating: null, updatedAt: "t" },
  ]);
});

test("onPreview unsubscribes with the returned function", () => {
  const runtime = fakePlayerState();
  installRuntime(runtime);
  const seen = [];
  const stop = sdk.playerState.onPreview((state) => seen.push(state));
  stop();
  assert.equal(runtime.handler, null);
  stop();
  assert.equal(seen.length, 0);
});

test("onPreview holds one runtime registration for several handlers, each with its own copy", () => {
  const runtime = fakePlayerState();
  installRuntime(runtime);
  const first = [];
  const second = [];
  const stopFirst = sdk.playerState.onPreview((state) => {
    state.payload.level = 99;
    first.push(state);
  });
  sdk.playerState.onPreview((state) => second.push(state));
  assert.equal(runtime.registrations, 1);

  runtime.handler(structuredClone(STATE));
  assert.equal(first[0].payload.level, 99);
  assert.deepEqual(second, [STATE]);

  stopFirst();
  assert.notEqual(runtime.handler, null);
});

test("onPreview reports every error to the console and throws the first back to the runtime", () => {
  const runtime = fakePlayerState();
  installRuntime(runtime);
  const seen = [];
  sdk.playerState.onPreview(() => {
    throw new Error("first");
  });
  sdk.playerState.onPreview(() => {
    throw new Error("second");
  });
  sdk.playerState.onPreview((state) => seen.push(state));

  const deferred = [];
  const original = globalThis.queueMicrotask;
  globalThis.queueMicrotask = (task) => deferred.push(task);
  try {
    assert.throws(() => runtime.handler(structuredClone(STATE)), /first/);
  } finally {
    globalThis.queueMicrotask = original;
  }
  assert.deepEqual(seen, [STATE]);
  assert.equal(deferred.length, 2);
  assert.throws(deferred[0], /first/);
  assert.throws(deferred[1], /second/);
});

test("onPreview does nothing below protocol 10", () => {
  const runtime = fakePlayerState();
  installRuntime(runtime, 9);
  const stop = sdk.playerState.onPreview(() => assert.fail("must not subscribe"));
  assert.equal(typeof stop, "function");
  assert.equal(runtime.registrations, 0);
  stop();
});

test("onPreview does nothing when the runtime has no onPreview or the handler is not a function", () => {
  installRuntime({});
  sdk.playerState.onPreview(() => {})();
  const runtime = fakePlayerState();
  globalThis.GRushPlayerState = runtime;
  assert.equal(typeof sdk.playerState.onPreview("nope"), "function");
  assert.equal(runtime.registrations, 0);
});

test("onPreview does nothing outside GameRush", () => {
  globalThis.location = { protocol: "https:", hostname: "example.com" };
  assert.equal(sdk.backend, "none");
  const stop = sdk.playerState.onPreview(() => assert.fail("must not be called"));
  assert.equal(typeof stop, "function");
  stop();
});

test("onPreview moves between the mock and the runtime when configure switches the backend", () => {
  const runtime = fakePlayerState();
  installRuntime(runtime);
  sdk.configure({ backend: "mock" });
  const seen = [];
  const stop = sdk.playerState.onPreview((state) => seen.push(state));
  assert.equal(runtime.registrations, 0);

  sdk.configure({ backend: "web" });
  assert.equal(runtime.registrations, 1);
  runtime.handler(structuredClone(STATE));
  assert.deepEqual(seen, [STATE]);

  sdk.configure({ backend: "mock" });
  assert.equal(runtime.handler, null);
  stop();
});

test("the mock hands a preview to the handler once, after the call returns", async () => {
  globalThis.location = { protocol: "http:", hostname: "localhost" };
  assert.equal(sdk.backend, "mock");
  assert.equal(sdk.protocolVersion(), 10);
  const seen = [];
  sdk.playerState.onPreview((state) => seen.push(state));

  assert.equal(
    sdk.mock.previewPlayerState("p2", { level: 3 }, { rating: 1200, revision: 4 }),
    true,
  );
  assert.equal(seen.length, 0);
  await flush();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].pseudoId, "p2");
  assert.deepEqual(seen[0].payload, { level: 3 });
  assert.equal(seen[0].revision, 4);
  assert.equal(seen[0].rating, 1200);
  assert.equal(typeof seen[0].updatedAt, "string");

  sdk.playerState.onPreview(() => {});
  await flush();
  assert.equal(seen.length, 1);
});

test("the mock hands a preview sent before registration when the handler registers", async () => {
  globalThis.location = { protocol: "http:", hostname: "localhost" };
  assert.equal(sdk.mock.previewPlayerState("p2", { level: 3 }), true);
  await flush();
  const seen = [];
  const stop = sdk.playerState.onPreview((state) => seen.push(state));
  await flush();
  assert.deepEqual(
    seen.map(({ revision, rating }) => ({ revision, rating })),
    [{ revision: 1, rating: null }],
  );

  stop();
  assert.equal(sdk.mock.previewPlayerState("p2", { level: 4 }), true);
  await flush();
  assert.equal(seen.length, 1);
});

test("the mock rejects a preview whose shape GameRush would not hand over", async () => {
  globalThis.location = { protocol: "http:", hostname: "localhost" };
  const seen = [];
  sdk.playerState.onPreview((state) => seen.push(state));
  assert.equal(sdk.mock.previewPlayerState("", { level: 1 }), false);
  assert.equal(sdk.mock.previewPlayerState("p2", [1]), false);
  assert.equal(sdk.mock.previewPlayerState("p2", { level: 1 }, { rating: Number.NaN }), false);
  assert.equal(sdk.mock.previewPlayerState("p2", { level: 1 }, { rating: "1" }), false);
  assert.equal(sdk.mock.previewPlayerState("p2", { level: 1 }, { revision: -1 }), false);
  assert.equal(sdk.mock.previewPlayerState("p2", { big: 1n }), false);
  await flush();
  assert.equal(seen.length, 0);
});

test("the mock takes any finite rating, as GameRush does", async () => {
  globalThis.location = { protocol: "http:", hostname: "localhost" };
  const seen = [];
  sdk.playerState.onPreview((state) => seen.push(state));
  assert.equal(sdk.mock.previewPlayerState("p2", { level: 1 }, { rating: 5e9 }), true);
  await flush();
  assert.equal(seen[0].rating, 5e9);
});

test("mock.reset drops a preview not handed over yet", async () => {
  globalThis.location = { protocol: "http:", hostname: "localhost" };
  sdk.mock.previewPlayerState("p2", { level: 3 });
  sdk.mock.reset();
  const seen = [];
  sdk.playerState.onPreview((state) => seen.push(state));
  await flush();
  assert.equal(seen.length, 0);
});
