import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { createGRush } from "../src/sdk.js";

let sdk;

beforeEach(() => {
  globalThis.location = { protocol: "http:", hostname: "localhost" };
  sdk = createGRush();
  sdk.mock.reset();
});

afterEach(() => {
  delete globalThis.location;
});

test("the mock speaks protocol 8", () => {
  assert.equal(sdk.protocolVersion(), 10);
});

test("matchmaking samples rivals, filters by rating and never returns yourself", async () => {
  const [low, mid, high] = sdk.mock.rivals;
  const all = await sdk.playerState.sample();
  assert.deepEqual(all.value.map((state) => state.pseudoId).sort(), [low, mid, high].sort());
  assert.ok(all.value.every((state) => typeof state.rating === "number"));

  const ranged = await sdk.playerState.sample({ count: 5, minRating: 1100, maxRating: 1300 });
  assert.deepEqual(
    ranged.value.map((state) => [state.pseudoId, state.rating]),
    [[mid, 1200]],
  );
  assert.equal((await sdk.playerState.sample({ count: 1 })).value.length, 1);

  sdk.mock.definePlayerState("unrated", { level: 1 });
  sdk.mock.definePlayerState("hidden", { level: 1 }, { hidden: true, rating: 1200 });
  const wide = await sdk.playerState.sample({ count: 20 });
  assert.ok(wide.value.some((state) => state.pseudoId === "unrated" && state.rating === null));
  assert.ok(!wide.value.some((state) => state.pseudoId === "hidden"));
  const filtered = await sdk.playerState.sample({ minRating: -10, maxRating: 1e8 });
  assert.ok(!filtered.value.some((state) => state.pseudoId === "unrated"));

  await sdk.playerState.setMine({ level: 2 }, undefined, { rating: 1200 });
  const self = (await sdk.player.getSelf()).value.pseudoId;
  const again = await sdk.playerState.sample({ count: 20, minRating: 0, maxRating: 2000 });
  assert.ok(!again.value.some((state) => state.pseudoId === self));
});

test("matchmaking rejects what GameRush rejects", async () => {
  for (const options of [
    { count: 0 },
    { count: 21 },
    { count: 1.5 },
    { minRating: 1 },
    { minRating: 5, maxRating: 1 },
    { minRating: -1e9, maxRating: 1 },
  ]) {
    assert.equal(
      (await sdk.playerState.sample(options)).code,
      "invalidParams",
      JSON.stringify(options),
    );
  }
  assert.equal((await sdk.playerState.sample(3)).code, "invalidParams");
});

test("setMine keeps the rating when it is omitted and clears it with null", async () => {
  const rated = await sdk.playerState.setMine({ level: 1 }, undefined, { rating: 1500 });
  assert.equal(rated.value.rating, 1500);
  const kept = await sdk.playerState.setMine({ level: 2 });
  assert.equal(kept.value.rating, 1500);
  const cleared = await sdk.playerState.setMine({ level: 3 }, undefined, { rating: null });
  assert.equal(cleared.value.rating, null);
  assert.equal((await sdk.playerState.getMine()).value.rating, null);
  assert.equal(
    (await sdk.playerState.setMine({ level: 4 }, undefined, { rating: 1e9 })).code,
    "invalidParams",
  );
});

test("the inbox sends, echoes, lists newest first and pages", async () => {
  const [rival] = sdk.mock.rivals;
  const first = await sdk.inbox.list();
  assert.equal(first.value.messages.length, 1);
  assert.equal(first.value.unreadCount, 1);
  assert.equal(first.value.nextCursor, null);

  assert.equal((await sdk.inbox.send(rival, "result", { stage: 1, win: true })).value, true);
  const listed = await sdk.inbox.list();
  assert.equal(listed.value.messages[0].from, rival);
  assert.equal(listed.value.messages[0].kind, "result");
  assert.deepEqual(listed.value.messages[0].payload, { stage: 1, win: true });
  assert.equal(listed.value.unreadCount, 2);

  const page = await sdk.inbox.list({ limit: 1 });
  assert.equal(page.value.messages.length, 1);
  assert.equal(typeof page.value.nextCursor, "string");
  const next = await sdk.inbox.list({ limit: 1, cursor: page.value.nextCursor });
  assert.equal(next.value.messages[0].kind, "challenge");
  assert.equal(next.value.nextCursor, null);
  assert.equal((await sdk.inbox.list({ cursor: "nope" })).code, "invalidParams");
});

test("markRead, remove and unreadOnly agree", async () => {
  const [message] = (await sdk.inbox.list()).value.messages;
  assert.equal((await sdk.inbox.markRead([message.id])).value, 1);
  assert.equal((await sdk.inbox.markRead([message.id])).value, 0);
  const read = await sdk.inbox.list();
  assert.equal(read.value.unreadCount, 0);
  assert.equal(typeof read.value.messages[0].readAt, "string");
  assert.deepEqual((await sdk.inbox.list({ unreadOnly: true })).value.messages, []);
  assert.equal((await sdk.inbox.remove([message.id])).value, 1);
  assert.deepEqual((await sdk.inbox.list()).value.messages, []);
  assert.equal((await sdk.inbox.markRead([])).code, "invalidParams");
  assert.equal((await sdk.inbox.markRead(["not-a-uuid"])).code, "invalidParams");
});

test("inbox payloads carry identifiers and numbers, never text", async () => {
  const [rival] = sdk.mock.rivals;
  const self = (await sdk.player.getSelf()).value.pseudoId;
  const rejected = [
    [rival, "result", { note: "hello world" }],
    [rival, "result", { note: "こんにちは" }],
    [rival, "result", ["not", "an", "object"]],
    [rival, "result", { a: { b: { c: { d: { e: 1 } } } } }],
    [rival, "result", { list: Array.from({ length: 65 }, (_, index) => index) }],
    // 60 values of 32 characters: within the 64 values, over 1KB.
    [
      rival,
      "result",
      Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`key_${i}`, "a".repeat(32)])),
    ],
    [rival, "bad kind", { a: 1 }],
    [self, "result", { a: 1 }],
    ["stranger", "result", { a: 1 }],
  ];
  for (const [to, kind, payload] of rejected) {
    assert.equal(
      (await sdk.inbox.send(to, kind, payload)).code,
      "invalidParams",
      JSON.stringify(payload),
    );
  }
  assert.equal((await sdk.inbox.send(rival, "result", { a: { b: { c: 1 } }, ok: null })).ok, true);
});

test("reporting a message blocks its sender in the inbox and the trades", async () => {
  const [rival] = sdk.mock.rivals;
  const [message] = (await sdk.inbox.list()).value.messages;
  sdk.mock.config.signedIn = false;
  assert.equal((await sdk.inbox.report(message.id)).code, "signInRequired");
  sdk.mock.config.signedIn = true;
  sdk.mock.config.confirmInboxReport = false;
  assert.equal((await sdk.inbox.report(message.id)).value, false);
  sdk.mock.config.confirmInboxReport = true;
  assert.equal((await sdk.inbox.report(message.id)).value, true);
  assert.deepEqual((await sdk.inbox.list()).value.messages, []);
  assert.equal(sdk.mock.receiveInbox(rival, "result", { a: 1 }), false);
  const trades = (await sdk.trade.list()).value.trades;
  assert.ok(!trades.some((trade) => trade.from === rival));
});

test("a trade goes from listing to pending to ack for the taker", async () => {
  const listed = await sdk.trade.list({ wantKey: "gem" });
  assert.equal(listed.value.trades.length, 1);
  const [offer] = listed.value.trades;
  assert.equal(offer.give, null);

  const accepted = await sdk.trade.accept(offer.id, { item: "gem", count: 3 });
  assert.equal(accepted.value.outcome, "matched");
  assert.equal(accepted.value.trade.status, "matched");
  assert.deepEqual(accepted.value.trade.give, { item: "gem", count: 3 });
  // A retry of the same accept is idempotent.
  assert.equal(
    (await sdk.trade.accept(offer.id, { item: "gem", count: 3 })).value.outcome,
    "matched",
  );

  const mine = await sdk.trade.mine();
  assert.deepEqual(
    mine.value.pending.map((trade) => [trade.id, trade.role, trade.action]),
    [[offer.id, "taker", "receiveOffer"]],
  );
  assert.equal((await sdk.trade.ack([offer.id])).value, 1);
  assert.equal((await sdk.trade.ack([offer.id])).value, 0);
  assert.deepEqual((await sdk.trade.mine()).value.pending, []);
  assert.equal((await sdk.trade.list({ wantKey: "gem" })).value.trades.length, 0);
});

test("a listing is idempotent by operationId and settles for the offerer", async () => {
  const [rival, other] = sdk.mock.rivals;
  const options = {
    offer: { item: "potion", count: 2 },
    want: { item: "gem", count: 1 },
    offerKey: "potion",
    operationId: "listing-1",
  };
  const created = await sdk.trade.create(options);
  assert.equal(created.value.status, "open");
  const retried = await sdk.trade.create({ ...options, offer: { item: "other" } });
  assert.equal(retried.value.id, created.value.id);
  assert.deepEqual(retried.value.offer, { item: "potion", count: 2 });
  assert.deepEqual(
    (await sdk.trade.mine()).value.open.map((trade) => trade.id),
    [created.value.id],
  );
  assert.ok(!(await sdk.trade.list()).value.trades.some((trade) => trade.id === created.value.id));

  assert.equal(sdk.mock.acceptTrade(created.value.id, { item: "gem", count: 1 }, rival), "matched");
  assert.equal(sdk.mock.acceptTrade(created.value.id, { item: "gem", count: 1 }, other), "taken");
  const pending = (await sdk.trade.mine()).value.pending;
  assert.deepEqual(
    pending.map((trade) => [trade.role, trade.action, trade.taker]),
    [["offerer", "receiveGive", rival]],
  );
  assert.deepEqual(pending[0].give, { item: "gem", count: 1 });
  assert.equal((await sdk.trade.ack([created.value.id])).value, 1);
});

test("cancelled and expired listings come back as returnOffer", async () => {
  const base = { offer: { item: "rune" }, want: { item: "gem" } };
  const cancelled = (await sdk.trade.create({ ...base, operationId: "c-1" })).value;
  const expired = (await sdk.trade.create({ ...base, operationId: "e-1" })).value;
  assert.equal((await sdk.trade.cancel(cancelled.id)).value.status, "cancelled");
  assert.equal((await sdk.trade.cancel(cancelled.id)).value.status, "cancelled");
  assert.equal(sdk.mock.expireTrade(expired.id), true);
  const pending = (await sdk.trade.mine()).value.pending;
  assert.deepEqual(
    pending.map((trade) => [trade.id, trade.status, trade.action]).sort(),
    [
      [cancelled.id, "cancelled", "returnOffer"],
      [expired.id, "expired", "returnOffer"],
    ].sort(),
  );
  assert.equal((await sdk.trade.ack([cancelled.id, expired.id])).value, 2);
});

test("accept reports taken, expired, cancelled and notFound as outcomes", async () => {
  const [rival, other] = sdk.mock.rivals;
  const give = { item: "gem" };
  const take = sdk.mock.offerTrade(rival, { item: "a" }, { item: "b" });
  const self = (await sdk.player.getSelf()).value.pseudoId;
  const named = sdk.mock.offerTrade(other, { item: "c" }, { item: "d" }, { toSelf: true });
  assert.equal(named.to, self);
  assert.ok((await sdk.trade.list()).value.trades.some((trade) => trade.id === named.id));

  const expiring = sdk.mock.offerTrade(rival, { item: "e" }, { item: "f" });
  sdk.mock.expireTrade(expiring.id);
  assert.equal((await sdk.trade.accept(expiring.id, give)).value.outcome, "expired");
  assert.equal((await sdk.trade.accept("missing", give)).value.outcome, "notFound");
  const own = (await sdk.trade.create({ offer: give, want: give, operationId: "own" })).value;
  assert.equal((await sdk.trade.accept(own.id, give)).value.outcome, "notFound");
  assert.equal((await sdk.trade.accept(take.id, { text: "free text here" })).code, "invalidParams");
  assert.equal((await sdk.trade.accept(take.id, give)).value.outcome, "matched");
});

test("trade creation follows GameRush's limits", async () => {
  const base = { offer: { item: "x" }, want: { item: "y" } };
  assert.equal((await sdk.trade.create(base)).code, "invalidParams");
  assert.equal((await sdk.trade.create({ ...base, operationId: "bad id" })).code, "invalidParams");
  assert.equal(
    (await sdk.trade.create({ ...base, operationId: "a", expiresInSec: 60 })).code,
    "invalidParams",
  );
  assert.equal(
    (await sdk.trade.create({ ...base, operationId: "b", offerKey: "has space" })).code,
    "invalidParams",
  );
  assert.equal((await sdk.trade.create(null)).code, "invalidParams");
  for (let index = 0; index < 10; index += 1) {
    assert.equal((await sdk.trade.create({ ...base, operationId: `n-${index}` })).ok, true);
  }
  assert.equal((await sdk.trade.create({ ...base, operationId: "n-10" })).code, "invalidParams");
});

test("trade reports need sign-in and a listing you can see", async () => {
  const [listing] = (await sdk.trade.list()).value.trades;
  sdk.mock.config.signedIn = false;
  assert.equal((await sdk.trade.report(listing.id)).code, "signInRequired");
  sdk.mock.config.signedIn = true;
  assert.equal((await sdk.trade.report("missing")).code, "invalidParams");
  assert.equal((await sdk.trade.report(listing.id)).value, true);
  assert.ok(!(await sdk.trade.list()).value.trades.some((trade) => trade.from === listing.from));
});
