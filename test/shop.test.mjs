import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { createGRush } from "../src/sdk.js";

const RUNTIME_NAMES = ["Info", "Player", "Shop"];
const GRANT_ID = "0b6f3d2e-6a4b-4c1e-9f7a-2d5c8e1a3b4f";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  for (const name of RUNTIME_NAMES) {
    delete globalThis[`GRush${name}`];
    delete globalThis[`GameRush${name}`];
  }
  delete globalThis.location;
});

// Like the runtime, it holds one onPending handler and replaces it on the next registration.
function installRuntime(protocolVersion, results) {
  const calls = [];
  const shop = {
    handler: null,
    registrations: 0,
    onPending(handler) {
      shop.registrations += 1;
      shop.handler = handler;
      return () => {
        if (shop.handler === handler) shop.handler = null;
      };
    },
  };
  for (const name of ["products", "purchase", "pending", "ack", "owned"]) {
    shop[name] = (...args) => {
      calls.push([name, ...args]);
      return Promise.resolve(results[name]);
    };
  }
  globalThis.GRushInfo = { protocolVersion };
  globalThis.GRushPlayer = { getSelf: () => Promise.resolve({ pseudoId: "p1" }) };
  globalThis.GRushShop = shop;
  return { calls, shop };
}

const RESULTS = {
  products: {
    enabled: true,
    products: [{ sku: "gem_pack", name: "Gems", priceJpy: 120 }, { name: "no sku" }],
  },
  purchase: { status: "redirecting" },
  pending: { grants: [{ id: GRANT_ID, sku: "gem_pack", createdAt: "c" }, { sku: "no id" }] },
  ack: { acked: 1 },
  owned: { grants: [{ id: GRANT_ID, sku: "gem_pack", createdAt: "c", acked: true }] },
};

test("shop calls GRushShop from protocol 11 and reads its results", async () => {
  const { calls } = installRuntime(11, RESULTS);
  const sdk = createGRush();

  const products = await sdk.shop.products();
  assert.deepEqual(products.value, {
    enabled: true,
    products: [{ sku: "gem_pack", name: "Gems", priceJpy: 120 }],
  });
  assert.deepEqual((await sdk.shop.purchase("gem_pack")).value, { status: "redirecting" });
  assert.deepEqual((await sdk.shop.pending()).value, [
    { id: GRANT_ID, sku: "gem_pack", createdAt: "c" },
  ]);
  assert.equal((await sdk.shop.ack([GRANT_ID])).value, 1);
  assert.deepEqual((await sdk.shop.owned()).value, [
    { id: GRANT_ID, sku: "gem_pack", createdAt: "c", acked: true },
  ]);
  assert.deepEqual(calls, [
    ["products"],
    ["purchase", "gem_pack"],
    ["pending"],
    ["ack", [GRANT_ID]],
    ["owned"],
  ]);
});

test("shop reads bare results too", async () => {
  installRuntime(11, {
    ...RESULTS,
    pending: [{ id: GRANT_ID, sku: "gem_pack", createdAt: "c" }],
    ack: 2,
    owned: [{ id: GRANT_ID, sku: "gem_pack", createdAt: "c" }],
  });
  const sdk = createGRush();
  assert.equal((await sdk.shop.pending()).value.length, 1);
  assert.equal((await sdk.shop.ack([GRANT_ID])).value, 2);
  assert.equal((await sdk.shop.owned()).value[0].acked, false);
});

test("a closed shop lists no products", async () => {
  installRuntime(11, { products: { enabled: false, products: [{ sku: "a", name: "A" }] } });
  const result = await createGRush().shop.products();
  assert.deepEqual(result.value, { enabled: false, products: [] });
});

test("an unreadable result is internal", async () => {
  installRuntime(11, { products: null, purchase: {} });
  const sdk = createGRush();
  assert.equal((await sdk.shop.products()).code, "internal");
  assert.equal((await sdk.shop.purchase("gem")).code, "internal");
});

test("a malformed sku is invalidParams and never reaches GameRush", async () => {
  const { calls } = installRuntime(11, RESULTS);
  const sdk = createGRush();
  for (const sku of ["", "Gem", "_gem", "gem|1", "a".repeat(65), 3, undefined]) {
    const result = await sdk.shop.purchase(sku);
    assert.equal(result.code, "invalidParams", String(sku));
  }
  assert.equal((await sdk.shop.purchase("a".repeat(64))).ok, true);
  assert.equal(calls.length, 1);
});

test("every shop call is unsupported below protocol 11", async () => {
  const { calls, shop } = installRuntime(10, RESULTS);
  const sdk = createGRush();
  for (const result of [
    await sdk.shop.products(),
    await sdk.shop.purchase("gem_pack"),
    await sdk.shop.purchase("Bad sku"),
    await sdk.shop.pending(),
    await sdk.shop.ack([GRANT_ID]),
    await sdk.shop.owned(),
  ]) {
    assert.equal(result.code, "unsupported");
  }
  sdk.shop.onPending(() => {});
  assert.equal(shop.registrations, 0);
  assert.equal(calls.length, 0);
});

test("errors from GRushShop keep their code", async () => {
  installRuntime(11, RESULTS);
  globalThis.GRushShop.purchase = () =>
    Promise.reject(Object.assign(new Error("not here"), { code: "unsupportedMethod" }));
  globalThis.GRushShop.pending = () =>
    Promise.reject(Object.assign(new Error("slow"), { code: "rateLimited", retryAfterMs: 2000 }));
  const sdk = createGRush();
  assert.equal((await sdk.shop.purchase("gem")).code, "unsupported");
  const limited = await sdk.shop.pending();
  assert.equal(limited.code, "rateLimited");
  assert.equal(limited.retryAfterMs, 2000);
});

test("onPending registers once on GRushShop and hands each handler a copy", () => {
  const { shop } = installRuntime(11, RESULTS);
  const sdk = createGRush();
  const first = [];
  const second = [];
  const stopFirst = sdk.shop.onPending((event) => {
    event.sku = "changed";
    first.push(event);
  });
  const stopSecond = sdk.shop.onPending((event) => second.push(event));
  assert.equal(shop.registrations, 1);

  shop.handler({ sku: "gem_pack", extra: 1 });
  shop.handler({ nope: true });
  assert.deepEqual(first, [{ sku: "changed" }]);
  assert.deepEqual(second, [{ sku: "gem_pack" }]);

  stopFirst();
  stopSecond();
  assert.equal(shop.handler, null);
});

function mockSdk() {
  globalThis.location = { protocol: "http:", hostname: "localhost" };
  const sdk = createGRush();
  sdk.mock.reset();
  return sdk;
}

test("the mock sells the configured products and grants at once", async () => {
  const sdk = mockSdk();
  assert.deepEqual((await sdk.shop.products()).value, { enabled: true, products: [] });
  sdk.mock.config.shopProducts = [
    { sku: "gem_pack", name: "Gems", priceJpy: 120 },
    { sku: "Bad", name: "Bad", priceJpy: 100 },
  ];
  assert.deepEqual((await sdk.shop.products()).value.products, [
    { sku: "gem_pack", name: "Gems", priceJpy: 120 },
  ]);

  const signals = [];
  sdk.shop.onPending((event) => signals.push(event));
  assert.deepEqual((await sdk.shop.purchase("gem_pack")).value, { status: "redirecting" });
  await flush();
  assert.deepEqual(signals, [{ sku: "gem_pack" }]);

  const pending = (await sdk.shop.pending()).value;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].sku, "gem_pack");
  assert.match(pending[0].id, /^[0-9a-f-]{36}$/);
  assert.deepEqual((await sdk.shop.purchase("gem_pack")).value, { status: "alreadyOwned" });

  assert.equal((await sdk.shop.ack([pending[0].id.toUpperCase()])).value, 1);
  assert.equal((await sdk.shop.ack([pending[0].id])).value, 0);
  assert.deepEqual((await sdk.shop.pending()).value, []);
  assert.deepEqual(
    (await sdk.shop.owned()).value.map((grant) => [grant.sku, grant.acked]),
    [["gem_pack", true]],
  );

  sdk.mock.reset();
  assert.deepEqual((await sdk.shop.owned()).value, []);
  assert.deepEqual(sdk.mock.config.shopProducts, []);
});

test("the mock hands over a signal that arrived before onPending once", async () => {
  const sdk = mockSdk();
  sdk.mock.config.shopProducts = [{ sku: "gem_pack", name: "Gems", priceJpy: 120 }];
  await sdk.shop.purchase("gem_pack");
  await flush();
  const signals = [];
  sdk.shop.onPending((event) => signals.push(event));
  await flush();
  assert.deepEqual(signals, [{ sku: "gem_pack" }]);
  const later = [];
  sdk.shop.onPending((event) => later.push(event));
  await flush();
  assert.deepEqual(later, []);
});

test("the mock refuses what GameRush refuses", async () => {
  const sdk = mockSdk();
  sdk.mock.config.shopProducts = [{ sku: "gem_pack", name: "Gems", priceJpy: 120 }];
  assert.equal((await sdk.shop.purchase("other")).code, "invalidParams");
  assert.equal((await sdk.shop.ack([])).code, "invalidParams");
  assert.equal((await sdk.shop.ack(["not-a-uuid"])).code, "invalidParams");
  assert.equal((await sdk.shop.ack(Array(101).fill(GRANT_ID))).code, "invalidParams");

  sdk.mock.config.shopPurchaseStatus = "cancelled";
  assert.deepEqual((await sdk.shop.purchase("gem_pack")).value, { status: "cancelled" });
  assert.deepEqual((await sdk.shop.pending()).value, []);

  sdk.mock.config.signedIn = false;
  sdk.mock.config.shopPurchaseStatus = "redirecting";
  assert.equal((await sdk.shop.purchase("gem_pack")).code, "signInRequired");
  assert.equal((await sdk.shop.pending()).ok, true);

  sdk.mock.config.shopEnabled = false;
  assert.deepEqual((await sdk.shop.products()).value, { enabled: false, products: [] });
  assert.equal((await sdk.shop.purchase("gem_pack")).code, "unavailable");
});
