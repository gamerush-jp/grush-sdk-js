import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { MOCK_ANALYTICS_MAX_EVENTS } from "../src/backend-mock.js";
import { createGRush } from "../src/sdk.js";

const RUNTIME_NAMES = ["Info", "Player", "Analytics"];

let sdk;
let printed;
let originalInfo;
let originalWarn;

function installRuntime({ protocolVersion = 6, analytics } = {}) {
  globalThis.GRushInfo = { protocolVersion };
  globalThis.GRushPlayer = { getSelf: () => Promise.resolve({ pseudoId: "p1", isGuest: true }) };
  if (analytics) globalThis.GRushAnalytics = analytics;
}

function fakeAnalytics(answer = true) {
  const calls = [];
  return {
    calls,
    available: true,
    log(kind, params) {
      calls.push([kind, params]);
      return typeof answer === "function" ? answer(kind, params) : answer;
    },
    isAvailable() {
      return this.available;
    },
  };
}

function useMock() {
  globalThis.location = { protocol: "http:", hostname: "localhost" };
  assert.equal(sdk.backend, "mock");
}

beforeEach(() => {
  printed = { info: [], warn: [] };
  originalInfo = console.info;
  originalWarn = console.warn;
  console.info = (message) => printed.info.push(message);
  console.warn = (message) => printed.warn.push(message);
  sdk = createGRush();
});

afterEach(() => {
  console.info = originalInfo;
  console.warn = originalWarn;
  for (const name of RUNTIME_NAMES) {
    delete globalThis[`GRush${name}`];
    delete globalThis[`GameRush${name}`];
  }
  delete globalThis.location;
});

test("each function passes its kind and arguments to the runtime's log", () => {
  const runtime = fakeAnalytics();
  installRuntime({ analytics: runtime });
  const fields = { route: "a" };
  assert.equal(sdk.analytics.logOnboardingStep(1, "tutorial", { fields }), true);
  assert.equal(sdk.analytics.logFunnelStep("shop", "visit-1", 2, "open"), true);
  assert.equal(sdk.analytics.logCustomEvent("boss"), true);
  assert.equal(
    sdk.analytics.logEconomyEvent("sink", "coin", 50, 120, "Shop", { itemSku: "sword", fields }),
    true,
  );
  assert.deepEqual(runtime.calls, [
    ["onboarding", { step: 1, stepName: "tutorial", fields }],
    [
      "funnel",
      { funnel: "shop", funnelSessionId: "visit-1", step: 2, stepName: "open", fields: undefined },
    ],
    ["custom", { name: "boss", value: undefined, fields: undefined }],
    [
      "economy",
      {
        flowType: "sink",
        currency: "coin",
        amount: 50,
        endingBalance: 120,
        transactionType: "Shop",
        itemSku: "sword",
        fields,
      },
    ],
  ]);
});

test("the runtime's answer is returned as a boolean", () => {
  installRuntime({ analytics: fakeAnalytics((kind) => (kind === "custom" ? "yes" : false)) });
  assert.equal(sdk.analytics.logCustomEvent("boss"), false);
  assert.equal(sdk.analytics.logOnboardingStep(1), false);
});

test("isAvailable follows the runtime", () => {
  const runtime = fakeAnalytics();
  installRuntime({ analytics: runtime });
  assert.equal(sdk.analytics.isAvailable(), true);
  runtime.available = false;
  assert.equal(sdk.analytics.isAvailable(), false);
});

test("the GameRushAnalytics alias is accepted too", () => {
  const runtime = fakeAnalytics();
  installRuntime();
  globalThis.GameRushAnalytics = runtime;
  assert.equal(sdk.analytics.logCustomEvent("boss"), true);
  assert.equal(runtime.calls.length, 1);
});

test("below protocol 6 every call is false and nothing reaches the runtime", async () => {
  const runtime = fakeAnalytics();
  installRuntime({ protocolVersion: 5, analytics: runtime });
  assert.equal(sdk.analytics.isAvailable(), false);
  assert.equal(sdk.analytics.logOnboardingStep(1), false);
  assert.equal(sdk.analytics.logFunnelStep("shop", null, 1), false);
  assert.equal(sdk.analytics.logCustomEvent("boss"), false);
  assert.equal(sdk.analytics.logEconomyEvent("source", "coin", 1, 1, "Shop"), false);
  assert.equal(runtime.calls.length, 0);
  assert.equal((await sdk.player.getSelf()).ok, true);
});

test("a runtime without GRushAnalytics answers false", () => {
  installRuntime();
  assert.equal(sdk.analytics.isAvailable(), false);
  assert.equal(sdk.analytics.logCustomEvent("boss"), false);
});

test("a throwing runtime or options object never throws into the game", () => {
  const runtime = fakeAnalytics(() => {
    throw new Error("boom");
  });
  runtime.isAvailable = () => {
    throw new Error("boom");
  };
  installRuntime({ analytics: runtime });
  assert.equal(sdk.analytics.logCustomEvent("boss"), false);
  assert.equal(sdk.analytics.isAvailable(), false);
  const hostile = {
    get fields() {
      throw new Error("boom");
    },
  };
  installRuntime({ analytics: fakeAnalytics() });
  assert.equal(sdk.analytics.logOnboardingStep(1, null, hostile), false);
});

test("outside GameRush every call is false", () => {
  globalThis.location = { protocol: "https:", hostname: "example.com" };
  assert.equal(sdk.backend, "none");
  assert.equal(sdk.analytics.isAvailable(), false);
  assert.equal(sdk.analytics.logOnboardingStep(1), false);
  assert.equal(sdk.analytics.logEconomyEvent("source", "coin", 1, 1, "Shop"), false);
});

test("the mock reports protocol 10, checks, prints and keeps each event", () => {
  useMock();
  assert.equal(sdk.protocolVersion(), 10);
  assert.equal(sdk.analytics.isAvailable(), true);
  assert.equal(
    sdk.analytics.logOnboardingStep(1, "  tutorial\n", { fields: { route: "a" } }),
    true,
  );
  assert.equal(sdk.analytics.logFunnelStep("shop", "", 2, "   "), true);
  assert.equal(sdk.analytics.logCustomEvent("boss"), true);
  assert.equal(
    sdk.analytics.logEconomyEvent("sink", "coin", 50, -3, "Shop", { itemSku: "sword" }),
    true,
  );
  const events = sdk.mock.analyticsEvents();
  assert.deepEqual(events, [
    { kind: "onboarding", step: 1, stepName: "tutorial", fields: { route: "a" } },
    { kind: "funnel", funnel: "shop", step: 2 },
    { kind: "custom", name: "boss", value: 1 },
    {
      kind: "economy",
      flowType: "sink",
      currency: "coin",
      amount: 50,
      endingBalance: -3,
      transactionType: "Shop",
      itemSku: "sword",
    },
  ]);
  assert.equal(printed.info.length, 4);
  assert.match(printed.info[2], /^\[GRush mock\] analytics \{"kind":"custom"/);

  events[0].step = 99;
  assert.equal(sdk.mock.analyticsEvents()[0].step, 1);
  sdk.mock.reset();
  assert.deepEqual(sdk.mock.analyticsEvents(), []);
});

test("the mock rejects what GameRush rejects and says why", () => {
  useMock();
  const tooLong = "a".repeat(41);
  const cases = [
    ["step", () => sdk.analytics.logOnboardingStep(0)],
    ["step", () => sdk.analytics.logOnboardingStep(101)],
    ["step", () => sdk.analytics.logOnboardingStep(1.5)],
    ["text", () => sdk.analytics.logOnboardingStep(1, tooLong)],
    ["text", () => sdk.analytics.logOnboardingStep(1, "\uD800")],
    [
      "fields",
      () =>
        sdk.analytics.logOnboardingStep(1, null, { fields: { a: "1", b: "2", c: "3", d: "4" } }),
    ],
    ["fields", () => sdk.analytics.logOnboardingStep(1, null, { fields: { "bad-key": "1" } })],
    ["fields", () => sdk.analytics.logOnboardingStep(1, null, { fields: { blank: " \u200B " } })],
    ["fields", () => sdk.analytics.logOnboardingStep(1, null, { fields: { n: 3 } })],
    ["fields", () => sdk.analytics.logOnboardingStep(1, null, { fields: "a" })],
    ["name", () => sdk.analytics.logFunnelStep("has space", null, 1)],
    ["name", () => sdk.analytics.logFunnelStep("shop", "has space", 1)],
    ["name", () => sdk.analytics.logCustomEvent("x".repeat(65))],
    ["value", () => sdk.analytics.logCustomEvent("boss", 1e9 + 1)],
    ["value", () => sdk.analytics.logCustomEvent("boss", Number.NaN)],
    ["flowType", () => sdk.analytics.logEconomyEvent("spend", "coin", 1, 1, "Shop")],
    ["currency", () => sdk.analytics.logEconomyEvent("source", "c".repeat(33), 1, 1, "Shop")],
    ["amount", () => sdk.analytics.logEconomyEvent("source", "coin", 0, 1, "Shop")],
    ["amount", () => sdk.analytics.logEconomyEvent("source", "coin", 1e12 + 1, 1, "Shop")],
    ["endingBalance", () => sdk.analytics.logEconomyEvent("source", "coin", 1, undefined, "Shop")],
    ["endingBalance", () => sdk.analytics.logEconomyEvent("source", "coin", 1, 1e15 + 1, "Shop")],
    ["transactionType", () => sdk.analytics.logEconomyEvent("source", "coin", 1, 1, "")],
    [
      "text",
      () => sdk.analytics.logEconomyEvent("source", "coin", 1, 1, "Shop", { itemSku: tooLong }),
    ],
  ];
  for (const [reason, log] of cases) {
    // reset() lets each reason warn again, so every case shows its own reason.
    sdk.mock.reset();
    printed.warn.length = 0;
    assert.equal(log(), false, reason);
    assert.deepEqual(printed.warn, [`[GRush mock] analytics event rejected (${reason}).`]);
  }
  assert.deepEqual(sdk.mock.analyticsEvents(), []);
});

test("the mock warns once per reason like GameRush", () => {
  useMock();
  assert.equal(sdk.analytics.logOnboardingStep(0), false);
  assert.equal(sdk.analytics.logOnboardingStep(101), false);
  assert.equal(sdk.analytics.logCustomEvent("has space"), false);
  assert.deepEqual(printed.warn, [
    "[GRush mock] analytics event rejected (step).",
    "[GRush mock] analytics event rejected (name).",
  ]);
  sdk.mock.reset();
  assert.equal(sdk.analytics.logOnboardingStep(0), false);
  assert.equal(printed.warn.length, 3);
});

test("the mock counts code points and keeps text on one line like GameRush", () => {
  useMock();
  const emoji = "😀".repeat(40);
  assert.equal(sdk.analytics.logOnboardingStep(1, emoji), true);
  assert.equal(sdk.analytics.logOnboardingStep(2, `a\r\n\u2028b\u202Ec`), true);
  assert.equal(sdk.analytics.logOnboardingStep(3, "\u3164"), true);
  assert.equal(sdk.analytics.logCustomEvent("score", -1e9, { fields: { stage: " 1 " } }), true);
  assert.deepEqual(sdk.mock.analyticsEvents(), [
    { kind: "onboarding", step: 1, stepName: emoji },
    { kind: "onboarding", step: 2, stepName: "a b c" },
    { kind: "onboarding", step: 3 },
    { kind: "custom", name: "score", value: -1e9, fields: { stage: "1" } },
  ]);
});

test(`the mock keeps only the latest ${MOCK_ANALYTICS_MAX_EVENTS} events`, () => {
  useMock();
  for (let index = 1; index <= MOCK_ANALYTICS_MAX_EVENTS + 5; index += 1) {
    assert.equal(sdk.analytics.logCustomEvent("tick", index), true);
  }
  const events = sdk.mock.analyticsEvents();
  assert.equal(events.length, MOCK_ANALYTICS_MAX_EVENTS);
  assert.equal(events[0].value, 6);
  assert.equal(events.at(-1).value, MOCK_ANALYTICS_MAX_EVENTS + 5);
});
