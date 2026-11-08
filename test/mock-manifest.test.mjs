import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";

import { parseLeaderboardManifest } from "../src/mock-manifest.js";
import { createGRush } from "../src/sdk.js";

const HIGH_SCORE = {
  key: "high_score",
  title: "ハイスコア",
  sort: "desc",
  valueType: "int",
  aggregation: "best",
  period: "all_time",
  minValue: 0,
  maxValue: 1000,
};

let sdk;
let warnings;
const originalWarn = console.warn;

beforeEach(() => {
  globalThis.location = { protocol: "http:", hostname: "localhost" };
  warnings = [];
  console.warn = (message) => warnings.push(message);
  sdk = createGRush();
});

afterEach(() => {
  delete globalThis.location;
  delete globalThis.fetch;
  console.warn = originalWarn;
});

function serve(files) {
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    const body = files[new URL(url).pathname];
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(body, { headers: { "content-type": "application/json" } });
  };
  return requested;
}

test("the manifest parser follows the upload rules", () => {
  const parsed = parseLeaderboardManifest(
    `\uFEFF${JSON.stringify({ leaderboards: [HIGH_SCORE] })}`,
  );
  assert.deepEqual(parsed, { ok: true, leaderboards: [{ ...HIGH_SCORE, enabled: true }] });
  assert.deepEqual(parseLeaderboardManifest({ $schema: "x" }), { ok: true, leaderboards: [] });

  const error = (source) => parseLeaderboardManifest(source).error;
  assert.equal(error("not json"), "grush.json can't be read as a JSON object.");
  assert.equal(error("[]"), "grush.json can't be read as a JSON object.");
  assert.equal(error({ boards: [] }), "grush.json has an unknown field: boards");
  assert.equal(
    error({ leaderboards: [{ ...HIGH_SCORE, minvalue: 0 }] }),
    "grush.json has an unknown field: leaderboards[0].minvalue",
  );
  assert.equal(
    error({ leaderboards: [HIGH_SCORE, HIGH_SCORE] }),
    "grush.json declares the leaderboard key more than once: high_score",
  );
  const many = Array.from({ length: 21 }, (_, index) => ({ ...HIGH_SCORE, key: `b${index}` }));
  assert.equal(error({ leaderboards: many }), "grush.json can declare up to 20 leaderboards.");
  assert.equal(error("x".repeat(64 * 1024 + 1)), "grush.json is too large (64KB at most).");

  const invalid = (patch) => error({ leaderboards: [{ ...HIGH_SCORE, ...patch }] });
  assert.equal(invalid({ key: "a b" }), "grush.json has an invalid value: leaderboards[0].key");
  assert.equal(
    invalid({ title: " \n " }),
    "grush.json has an invalid value: leaderboards[0].title",
  );
  assert.equal(
    invalid({ sort: undefined }),
    "grush.json has an invalid value: leaderboards[0].sort",
  );
  assert.equal(
    invalid({ period: "yearly" }),
    "grush.json has an invalid value: leaderboards[0].period",
  );
  assert.equal(
    invalid({ enabled: "no" }),
    "grush.json has an invalid value: leaderboards[0].enabled",
  );
  assert.equal(
    invalid({ minValue: "0" }),
    "grush.json has an invalid value: leaderboards[0].minValue",
  );
  assert.equal(
    invalid({ maxValue: undefined }),
    "grush.json has an invalid value: leaderboards[0].minValue / maxValue",
  );
  assert.equal(
    invalid({ minValue: 5, maxValue: 5 }),
    "grush.json has an invalid value: leaderboards[0].minValue / maxValue",
  );
  assert.equal(
    parseLeaderboardManifest({ leaderboards: [{ ...HIGH_SCORE, title: "a\nb" }] }).leaderboards[0]
      .title,
    "a b",
  );
});

test("the manifest parser checks in the upload's order and reads bytes as strict UTF-8", () => {
  const error = (source) => parseLeaderboardManifest(source).error;
  // GameRush checks the key, then duplicates, then the type of minValue / maxValue, then the title.
  assert.equal(
    error({ leaderboards: [HIGH_SCORE, { ...HIGH_SCORE, title: "", minValue: "0" }] }),
    "grush.json declares the leaderboard key more than once: high_score",
  );
  assert.equal(
    error({ leaderboards: [{ ...HIGH_SCORE, title: "", sort: "up", minValue: "0" }] }),
    "grush.json has an invalid value: leaderboards[0].minValue",
  );
  assert.equal(
    error({ leaderboards: [{ ...HIGH_SCORE, title: "", sort: "up" }] }),
    "grush.json has an invalid value: leaderboards[0].title",
  );
  assert.equal(
    error({ leaderboards: [{ ...HIGH_SCORE, enabled: "no", minValue: 9 }] }),
    "grush.json has an invalid value: leaderboards[0].enabled",
  );

  const encoded = new TextEncoder().encode(JSON.stringify({ leaderboards: [HIGH_SCORE] }));
  const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...encoded]);
  assert.equal(parseLeaderboardManifest(withBom).ok, true);
  assert.equal(
    error(new Uint8Array([...encoded.slice(0, 20), 0xff, ...encoded.slice(20)])),
    "grush.json can't be read as a JSON object.",
  );
  assert.equal(error(new Uint8Array([0xff, 0xfe, 0x7b, 0x00, 0x7d, 0x00])), error("not json"));
  // The limit is in bytes: 30,000 three-byte characters are over 64KB.
  assert.equal(
    error(JSON.stringify({ $schema: "あ".repeat(30_000) })),
    "grush.json is too large (64KB at most).",
  );
  // Whitespace that String.prototype.trim removes, as on GameRush.
  assert.equal(
    parseLeaderboardManifest({ leaderboards: [{ ...HIGH_SCORE, title: "\u3000スコア\u00a0" }] })
      .leaderboards[0].title,
    "スコア",
  );
});

test("the title drops lone surrogates before collapsing and counting, as GameRush does", () => {
  const high = String.fromCharCode(0xd83d);
  const low = String.fromCharCode(0xde00);
  const title = (value) =>
    parseLeaderboardManifest({ leaderboards: [{ ...HIGH_SCORE, title: value }] });
  assert.equal(title(high).error, "grush.json has an invalid value: leaderboards[0].title");
  assert.equal(title(`${high}スコア`).leaderboards[0].title, "スコア");
  assert.equal(title(`a\n${low}\tb`).leaderboards[0].title, "a b");
  assert.equal(title(`${"あ".repeat(60)}${high}`).leaderboards[0].title, "あ".repeat(60));
  assert.equal(title(`${high}${low}`).leaderboards[0].title, String.fromCodePoint(0x1f600));
  // Read from the file, the escape becomes the same lone surrogate.
  const text = JSON.stringify({ leaderboards: [{ ...HIGH_SCORE, title: `${high}スコア` }] });
  assert.match(text, /\\ud83d/);
  assert.equal(parseLeaderboardManifest(text).leaderboards[0].title, "スコア");
});

test("loadLeaderboards declares the boards and reports mistakes as invalidParams", async () => {
  const loaded = sdk.mock.loadLeaderboards(JSON.stringify({ leaderboards: [HIGH_SCORE] }));
  assert.deepEqual(loaded, { ok: true, value: ["high_score"], code: "", message: "" });
  assert.equal((await sdk.leaderboards.submit("high_score", 1001)).code, "invalidParams");
  assert.equal((await sdk.leaderboards.submit("high_score", 10)).value.rank, 1);
  const [board] = (await sdk.leaderboards.list()).value;
  assert.equal(board.title, "ハイスコア");

  const failed = sdk.mock.loadLeaderboards({ leaderboards: [{ key: "x" }] });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, "invalidParams");
  assert.equal(failed.message, "grush.json has an invalid value: leaderboards[0].title");
});

test("the keys . and .. are refused like on GameRush", async () => {
  for (const key of [".", ".."]) {
    assert.equal(
      parseLeaderboardManifest({ leaderboards: [{ ...HIGH_SCORE, key }] }).error,
      "grush.json has an invalid value: leaderboards[0].key",
    );
    // defineLeaderboard does not check the key, so the calls must refuse it themselves.
    sdk.mock.defineLeaderboard(key);
    for (const result of [
      await sdk.leaderboards.submit(key, 1),
      await sdk.leaderboards.top(key),
      await sdk.leaderboards.aroundMe(key),
    ]) {
      assert.equal(result.code, "invalidParams");
      assert.equal(result.message, "Invalid leaderboard key.");
    }
  }
  assert.equal(
    parseLeaderboardManifest({ leaderboards: [{ ...HIGH_SCORE, key: "..." }] }).ok,
    true,
  );
});

test("disabled boards and boards without a range behave like GameRush", async () => {
  sdk.mock.loadLeaderboards({
    leaderboards: [
      { ...HIGH_SCORE, key: "off", enabled: false },
      { ...HIGH_SCORE, key: "open", minValue: null, maxValue: null },
    ],
  });
  assert.deepEqual(
    (await sdk.leaderboards.list()).value.map((board) => board.key),
    ["open"],
  );
  const disabled = await sdk.leaderboards.submit("off", 1);
  assert.equal(disabled.code, "invalidParams");
  assert.equal(disabled.message, "The mock leaderboard off is disabled.");
  assert.equal((await sdk.leaderboards.top("off")).code, "invalidParams");
  assert.equal((await sdk.leaderboards.submit("open", 1)).code, "invalidParams");

  // defineLeaderboard keeps accepting any value when no range is given.
  sdk.mock.defineLeaderboard("free");
  assert.equal((await sdk.leaderboards.submit("free", 123456789)).ok, true);
});

test("period boards report the period key and start over when it changes", async () => {
  sdk.mock.loadLeaderboards({
    leaderboards: [
      { ...HIGH_SCORE, key: "daily", period: "daily" },
      { ...HIGH_SCORE, key: "weekly", period: "weekly" },
    ],
  });
  await sdk.leaderboards.submit("daily", 10);
  const today = new Date().toISOString().slice(0, 10);
  const page = await sdk.leaderboards.top("daily");
  assert.equal(page.value.period, "daily");
  assert.equal(page.value.periodKey, today);
  assert.equal(page.value.total, 1);
  assert.match((await sdk.leaderboards.top("weekly")).value.periodKey, /^\d{4}-W\d{2}$/);
});

test("the mock reads grush.json next to the page before the first leaderboard call", async () => {
  globalThis.location = {
    protocol: "http:",
    hostname: "localhost",
    href: "http://localhost:8080/game/index.html",
  };
  const requested = serve({ "/game/grush.json": JSON.stringify({ leaderboards: [HIGH_SCORE] }) });
  sdk.mock.defineLeaderboard("high_score", { title: "Mine" });
  sdk.mock.defineLeaderboard("extra");

  const keys = (await sdk.leaderboards.list()).value.map((board) => [board.key, board.title]);
  assert.deepEqual(keys, [
    ["high_score", "Mine"],
    ["extra", "extra"],
  ]);
  await sdk.leaderboards.list();
  assert.deepEqual(requested, ["http://localhost:8080/game/grush.json"]);
  assert.deepEqual(warnings, []);
});

test("a missing or broken grush.json does not stop the mock", async () => {
  globalThis.location = { protocol: "http:", hostname: "localhost", href: "http://localhost/" };
  serve({});
  sdk.mock.defineLeaderboard("score");
  assert.deepEqual(
    (await sdk.leaderboards.list()).value.map((board) => board.key),
    ["score"],
  );
  assert.deepEqual(warnings, []);

  sdk.mock.reset();
  serve({ "/grush.json": JSON.stringify({ leaderboards: [{ ...HIGH_SCORE, sort: "up" }] }) });
  assert.deepEqual((await sdk.leaderboards.list()).value, []);
  assert.deepEqual(warnings, [
    "[GRush mock] grush.json has an invalid value: leaderboards[0].sort",
  ]);

  sdk.mock.reset();
  globalThis.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  assert.deepEqual((await sdk.leaderboards.list()).value, []);
});

test("file:// pages and an explicit loadLeaderboards skip the automatic read", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("{}");
  };
  globalThis.location = { protocol: "file:", hostname: "", href: "file:///game/index.html" };
  await sdk.leaderboards.list();
  assert.equal(calls, 0);

  globalThis.location = { protocol: "http:", hostname: "localhost", href: "http://localhost/" };
  const local = createGRush();
  local.mock.loadLeaderboards({ leaderboards: [] });
  await local.leaderboards.list();
  assert.equal(calls, 0);
});

test("loadLeaderboards replaces a board declared with defineLeaderboard", async () => {
  sdk.mock.defineLeaderboard("high_score", { title: "Mine" });
  sdk.mock.loadLeaderboards({ leaderboards: [HIGH_SCORE] });
  const [board] = (await sdk.leaderboards.list()).value;
  assert.equal(board.title, "ハイスコア");
});

test("grush.json read later replaces a board addRival created and keeps its rivals", async () => {
  globalThis.location = { protocol: "http:", hostname: "localhost", href: "http://localhost/" };
  serve({
    "/grush.json": JSON.stringify({
      leaderboards: [{ ...HIGH_SCORE, sort: "asc", period: "daily", minValue: 1, maxValue: 500 }],
    }),
  });
  sdk.mock.addRival("high_score", "Alice", 100);
  sdk.mock.addRival("high_score", "Bob", 50);

  const [board] = (await sdk.leaderboards.list()).value;
  assert.equal(board.sort, "asc");
  assert.equal(board.period, "daily");
  assert.equal(board.title, "ハイスコア");
  const page = (await sdk.leaderboards.top("high_score")).value;
  assert.deepEqual(
    page.entries.map((entry) => entry.displayName),
    ["Bob", "Alice"],
  );
  assert.equal(page.periodKey, new Date().toISOString().slice(0, 10));
  assert.equal((await sdk.leaderboards.submit("high_score", 501)).code, "invalidParams");
});

test("a grush.json read that does not finish in time counts as no file", async () => {
  globalThis.location = { protocol: "http:", hostname: "localhost", href: "http://localhost/" };
  let aborted = false;
  globalThis.fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  sdk.mock.defineLeaderboard("score");
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let settled = null;
    sdk.leaderboards.list().then((result) => {
      settled = result;
    });
    mock.timers.tick(2999);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, null);
    mock.timers.tick(1);
    while (settled === null) {
      await new Promise((resolve) => setImmediate(resolve));
      mock.timers.tick(1);
    }
    assert.equal(aborted, true);
    assert.deepEqual(
      settled.value.map((board) => board.key),
      ["score"],
    );
    assert.deepEqual(warnings, []);
  } finally {
    mock.timers.reset();
  }
});

test("a grush.json that is not UTF-8 is reported like on upload", async () => {
  globalThis.location = { protocol: "http:", hostname: "localhost", href: "http://localhost/" };
  const encoded = new TextEncoder().encode(JSON.stringify({ leaderboards: [HIGH_SCORE] }));
  serve({ "/grush.json": new Uint8Array([...encoded.slice(0, 20), 0xc3, ...encoded.slice(20)]) });
  assert.deepEqual((await sdk.leaderboards.list()).value, []);
  assert.deepEqual(warnings, ["[GRush mock] grush.json can't be read as a JSON object."]);
});
