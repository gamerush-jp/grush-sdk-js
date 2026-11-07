import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { createGRush } from "../src/sdk.js";

const RUNTIME_NAMES = ["Info", "Player", "PlayerState", "Inbox", "Trade"];

const TRADE = {
  id: "t1",
  from: "p2",
  to: null,
  taker: null,
  offer: { item: "sword" },
  want: { item: "gem" },
  offerKey: "sword",
  wantKey: null,
  give: null,
  status: "open",
  createdAt: "c",
  expiresAt: "e",
  settledAt: null,
};

let calls;
let runtime;
let sdk;

// The runtime may resolve with the bare value or with the RPC result; `wrapped` picks which.
function installRuntime(protocolVersion, wrapped) {
  calls = [];
  const record =
    (name, bare, envelope) =>
    (...args) => {
      calls.push([name, ...args]);
      return Promise.resolve(wrapped ? envelope : bare);
    };
  runtime = {
    Info: { protocolVersion },
    Player: { getSelf: () => Promise.resolve({ pseudoId: "p1" }) },
    PlayerState: {
      setMine: record("setMine", { pseudoId: "p1", payload: {}, revision: 1, rating: 7 }),
      sample: record(
        "sample",
        [{ pseudoId: "p2", payload: { a: 1 }, revision: 2, rating: null, updatedAt: "u" }],
        {
          states: [
            { pseudoId: "p2", payload: { a: 1 }, revision: 2, rating: null, updatedAt: "u" },
          ],
        },
      ),
    },
    Inbox: {
      send: record("send", true, { sent: true }),
      list: record(
        "list",
        {
          messages: [{ id: "m1", from: "p2", kind: "k", payload: { a: 1 } }],
          unreadCount: 1,
          nextCursor: null,
        },
        {
          messages: [{ id: "m1", from: "p2", kind: "k", payload: { a: 1 } }],
          unreadCount: 1,
          nextCursor: null,
        },
      ),
      markRead: record("markRead", 2, { updated: 2 }),
      remove: record("remove", 1, { updated: 1 }),
      report: record("report", true, { reported: true }),
    },
    Trade: {
      create: record("create", TRADE, { trade: TRADE }),
      list: record(
        "list",
        { trades: [TRADE], nextCursor: "n" },
        { trades: [TRADE], nextCursor: "n" },
      ),
      mine: record(
        "mine",
        {
          open: [],
          pending: [{ ...TRADE, status: "matched", role: "offerer", action: "receiveGive" }],
        },
        {
          open: [],
          pending: [{ ...TRADE, status: "matched", role: "offerer", action: "receiveGive" }],
        },
      ),
      accept: record("accept", { outcome: "taken" }, { outcome: "taken" }),
      cancel: record(
        "cancel",
        { ...TRADE, status: "cancelled" },
        { trade: { ...TRADE, status: "cancelled" } },
      ),
      ack: record("ack", 1, { acked: 1 }),
      report: record("report", false, { reported: false }),
    },
  };
  for (const name of RUNTIME_NAMES) globalThis[`GRush${name}`] = runtime[name];
}

beforeEach(() => {
  installRuntime(7, false);
  sdk = createGRush();
});

afterEach(() => {
  for (const name of RUNTIME_NAMES) delete globalThis[`GRush${name}`];
});

for (const wrapped of [false, true]) {
  test(`social calls reach the runtime and read ${wrapped ? "RPC results" : "bare values"}`, async () => {
    installRuntime(7, wrapped);

    const sampled = await sdk.playerState.sample({
      count: 3,
      minRating: 1,
      maxRating: 2,
      extra: 1,
    });
    assert.deepEqual(calls.at(-1), ["sample", { count: 3, minRating: 1, maxRating: 2 }]);
    assert.deepEqual(sampled.value, [
      { pseudoId: "p2", payload: { a: 1 }, revision: 2, rating: null, updatedAt: "u" },
    ]);

    assert.equal((await sdk.inbox.send("p2", "k", { a: 1 })).value, true);
    assert.deepEqual(calls.at(-1), ["send", "p2", "k", { a: 1 }]);
    const page = await sdk.inbox.list({ unreadOnly: true, limit: 5 });
    assert.deepEqual(calls.at(-1), ["list", { unreadOnly: true, limit: 5 }]);
    assert.deepEqual(page.value.messages[0], {
      id: "m1",
      from: "p2",
      kind: "k",
      payload: { a: 1 },
      createdAt: "",
      readAt: null,
    });
    assert.equal((await sdk.inbox.markRead(["m1", "m2"])).value, 2);
    assert.deepEqual(calls.at(-1), ["markRead", ["m1", "m2"]]);
    assert.equal((await sdk.inbox.remove(["m1"])).value, 1);
    assert.equal((await sdk.inbox.report("m1")).value, true);
    assert.deepEqual(calls.at(-1), ["report", "m1"]);

    const created = await sdk.trade.create({
      offer: { item: "sword" },
      want: { item: "gem" },
      offerKey: "sword",
      operationId: "op-1",
    });
    assert.deepEqual(calls.at(-1), [
      "create",
      { offer: { item: "sword" }, want: { item: "gem" }, offerKey: "sword", operationId: "op-1" },
    ]);
    assert.equal(created.value.id, "t1");
    assert.equal(created.value.wantKey, null);
    const listed = await sdk.trade.list({ wantKey: "gem" });
    assert.deepEqual(calls.at(-1), ["list", { wantKey: "gem" }]);
    assert.equal(listed.value.nextCursor, "n");
    const mine = await sdk.trade.mine();
    assert.deepEqual(calls.at(-1), ["mine"]);
    assert.equal(mine.value.pending[0].action, "receiveGive");
    const accepted = await sdk.trade.accept("t1", { item: "gem" });
    assert.deepEqual(calls.at(-1), ["accept", "t1", { item: "gem" }]);
    assert.deepEqual(accepted.value, { outcome: "taken", trade: null });
    assert.equal((await sdk.trade.cancel("t1")).value.status, "cancelled");
    assert.equal((await sdk.trade.ack(["t1"])).value, 1);
    assert.deepEqual(calls.at(-1), ["ack", ["t1"]]);
    assert.equal((await sdk.trade.report("t1")).value, false);
  });
}

test("setMine passes rating only to a runtime of protocol 7 or later", async () => {
  await sdk.playerState.setMine({ a: 1 }, 2, { rating: 7 });
  assert.deepEqual(calls.at(-1), ["setMine", { a: 1 }, 2, { rating: 7 }]);
  await sdk.playerState.setMine({ a: 1 }, undefined, { rating: null });
  assert.deepEqual(calls.at(-1), ["setMine", { a: 1 }, undefined, { rating: null }]);
  await sdk.playerState.setMine({ a: 1 });
  assert.deepEqual(calls.at(-1), ["setMine", { a: 1 }, undefined]);
  assert.equal((await sdk.playerState.setMine({ a: 1 })).value.rating, 7);

  runtime.Info.protocolVersion = 6;
  await sdk.playerState.setMine({ a: 1 }, 2, { rating: 7 });
  assert.deepEqual(calls.at(-1), ["setMine", { a: 1 }, 2]);
});

test("matchmaking, the inbox and trades are unsupported before protocol 7", async () => {
  runtime.Info.protocolVersion = 6;
  calls.length = 0;
  assert.equal((await sdk.playerState.sample()).code, "unsupported");
  assert.equal((await sdk.inbox.list()).code, "unsupported");
  assert.equal((await sdk.inbox.send("p2", "k", {})).code, "unsupported");
  assert.equal((await sdk.trade.mine()).code, "unsupported");
  assert.equal(
    (await sdk.trade.create({ offer: {}, want: {}, operationId: "x" })).code,
    "unsupported",
  );
  assert.deepEqual(calls, []);
});

test("a runtime without the social APIs is unsupported, and unreadable answers are failures", async () => {
  delete globalThis.GRushInbox;
  delete globalThis.GRushTrade;
  delete runtime.PlayerState.sample;
  assert.equal((await sdk.playerState.sample()).code, "unsupported");
  assert.equal((await sdk.inbox.list()).code, "unsupported");
  assert.equal((await sdk.trade.ack(["t1"])).code, "unsupported");

  globalThis.GRushTrade = {
    mine: () => Promise.resolve({ open: null }),
    create: () => Promise.resolve({ trade: null }),
    accept: () =>
      Promise.reject(Object.assign(new Error("slow"), { code: "rateLimited", retryAfterMs: 9 })),
  };
  assert.equal((await sdk.trade.mine()).code, "internal");
  assert.equal(
    (await sdk.trade.create({ offer: {}, want: {}, operationId: "x" })).code,
    "internal",
  );
  const limited = await sdk.trade.accept("t1", {});
  assert.equal(limited.code, "rateLimited");
  assert.equal(limited.retryAfterMs, 9);
});

test("sample passes previewRequired through with its message", async () => {
  const error = new Error("Register a player state preview first.");
  error.code = "previewRequired";
  runtime.PlayerState.sample = () => Promise.reject(error);

  const result = await sdk.playerState.sample();
  assert.equal(result.ok, false);
  assert.equal(result.code, "previewRequired");
  assert.equal(result.message, "Register a player state preview first.");
});
