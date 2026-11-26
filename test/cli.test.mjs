import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { canonicalOrigin } from "../cli/api.mjs";
import { credentialsPath, loadCredentials, saveCredentials } from "../cli/credentials.mjs";
import {
  LOGIN_SCOPES,
  authorizeUrl,
  codeChallenge,
  createState,
  createVerifier,
  login,
} from "../cli/login.mjs";
import { run } from "../cli/main.mjs";
import {
  MAX_BUILD_BYTES,
  MAX_BUILD_FILE_COUNT,
  stripSingleRootFolder,
  validateBuildFiles,
} from "../cli/rules.mjs";
import { collectBuild, precheckBuild } from "../cli/upload.mjs";
import { crc32, readZipEntries } from "../cli/zip.mjs";

const temporaryRoots = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grush-cli-"));
  temporaryRoots.push(dir);
  return dir;
}
after(() => {
  for (const dir of temporaryRoots) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * @param {{ name: string, data?: Buffer, method?: number, flags?: number }[]} entries
 * @param {{ zip64Locator?: boolean, entryCount?: number }} [options]
 */
function makeZip(entries, options = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const data = entry.data ?? Buffer.alloc(0);
    const method = entry.method ?? 8;
    const body = method === 8 ? deflateRawSync(data) : data;
    const name = Buffer.from(entry.name, "utf8");
    const flags = (entry.flags ?? 0) | 0x0800;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  const count = options.entryCount ?? entries.length;
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  const parts = [...locals, centralBuffer];
  if (options.zip64Locator) {
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    parts.push(locator);
  }
  parts.push(eocd);
  return Buffer.concat(parts);
}

/** @param {string} dir @param {Record<string, string | Buffer>} files */
function writeTree(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

describe("PKCE", () => {
  test("verifier はサーバの受ける 43 文字の base64url", () => {
    const verifier = createVerifier();
    assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(verifier, createVerifier());
    assert.match(createState(), /^[A-Za-z0-9_-]{22}$/);
  });

  test("challenge は verifier の SHA-256 の base64url（S256）", async () => {
    const verifier = createVerifier();
    const digest = Buffer.from(
      await webcrypto.subtle.digest("SHA-256", Buffer.from(verifier, "ascii")),
    );
    assert.equal(codeChallenge(verifier), digest.toString("base64url"));
    assert.match(codeChallenge(verifier), /^[A-Za-z0-9_-]{43}$/);
  });

  test("承認の URL は Unity の Editor 拡張と同じパラメータを持つ", () => {
    const url = new URL(
      authorizeUrl("https://gamerush.jp", {
        redirectUri: "http://127.0.0.1:5000",
        challenge: "c".repeat(43),
        state: "s",
        clientName: "GameRush CLI",
        scopes: LOGIN_SCOPES,
      }),
    );
    assert.equal(url.pathname, "/studio/authorize");
    assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:5000");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("client_name"), "GameRush CLI");
    assert.equal(
      url.searchParams.get("scopes"),
      "games:read,leaderboards:read,leaderboards:write,builds:write,games:create",
    );
    assert.equal(url.searchParams.get("state"), "s");
  });
});

describe("接続先", () => {
  test("以前の本番の接続先は今の本番に読み替える", () => {
    assert.equal(canonicalOrigin("https://gamerush.cc/"), "https://gamerush.jp");
    assert.equal(canonicalOrigin("http://127.0.0.1:8787"), "http://127.0.0.1:8787");
  });

  test("ループバック以外の http は断る", () => {
    assert.throws(() => canonicalOrigin("http://example.com"), /https/);
  });
});

describe("login", () => {
  /** @param {(redirect: URL) => string} query */
  async function loginWith(query, timeoutMs = 5000) {
    let browserStatus = 0;
    const pending = login({
      origin: "http://127.0.0.1:1",
      fetch: () => Promise.reject(new Error("呼ばれない")),
      log: () => {},
      timeoutMs,
      openBrowser: async (url) => {
        const redirect = new URL(String(new URL(url).searchParams.get("redirect_uri")));
        const state = String(new URL(url).searchParams.get("state"));
        const response = await fetch(
          `${redirect.origin}/?${query(new URL(url)).replace("{state}", state)}`,
        );
        browserStatus = response.status;
        await response.text();
      },
    });
    return { pending, status: () => browserStatus };
  }

  test("state が一致しない応答は断って捨て、本物の応答を待ち続ける", async () => {
    const statuses = [];
    const exchanged = [];
    const credentials = await login({
      origin: "http://127.0.0.1:1",
      fetch: async (input, init) => {
        exchanged.push({ input, body: JSON.parse(String(init?.body)) });
        return Response.json({
          token: {
            preview: "cccccc",
            clientName: "GameRush CLI",
            scopes: ["builds:write"],
            gameIds: null,
            expiresAt: "2099-01-01T00:00:00.000Z",
          },
          secret: `grush_pat_${"c".repeat(43)}`,
        });
      },
      log: () => {},
      timeoutMs: 5000,
      openBrowser: async (url) => {
        const params = new URL(url).searchParams;
        const redirect = String(params.get("redirect_uri"));
        for (const query of [
          `code=${"x".repeat(43)}&state=other`,
          "error=access_denied&state=other",
          `code=${"x".repeat(43)}`,
          `code=${"a".repeat(43)}&state=${params.get("state")}`,
        ]) {
          const response = await fetch(`${redirect}/?${query}`);
          statuses.push(response.status);
          await response.text();
        }
      },
    });
    assert.deepEqual(statuses, [400, 400, 400, 200]);
    assert.equal(exchanged.length, 1);
    assert.equal(exchanged[0].body.code, "a".repeat(43));
    assert.equal(credentials.token, `grush_pat_${"c".repeat(43)}`);
  });

  test("承認されなかった応答はエラーにする", async () => {
    const { pending, status } = await loginWith(() => "error=access_denied&state={state}");
    await assert.rejects(pending, /承認されませんでした（access_denied）/);
    assert.equal(status(), 400);
  });

  test("承認が来なければ時間切れになる", async () => {
    const pending = login({
      origin: "http://127.0.0.1:1",
      fetch: () => Promise.reject(new Error("呼ばれない")),
      log: () => {},
      timeoutMs: 50,
      openBrowser: () => {},
    });
    await assert.rejects(pending, /時間が切れました/);
  });
});

describe("zip", () => {
  test("stored と deflate を読み、ディレクトリのエントリを飛ばす", () => {
    const zip = makeZip([
      { name: "game/", method: 0 },
      { name: "game/index.html", data: Buffer.from("<html></html>"), method: 0 },
      { name: "game/main.js", data: Buffer.from("console.log(1);".repeat(100)) },
    ]);
    const entries = readZipEntries(zip);
    assert.deepEqual(
      entries.map((entry) => entry.path),
      ["game/index.html", "game/main.js"],
    );
    assert.equal(entries[0].read().toString(), "<html></html>");
    assert.equal(entries[1].read().toString(), "console.log(1);".repeat(100));
    assert.equal(entries[1].size, 1500);
  });

  test("パスワード付きのエントリは断る", () => {
    const zip = makeZip([{ name: "index.html", data: Buffer.from("x"), flags: 0x0001 }]);
    assert.throws(() => readZipEntries(zip), /パスワード付き/);
  });

  test("ZIP64 は断る", () => {
    const zip = makeZip([{ name: "index.html", data: Buffer.from("x") }], { zip64Locator: true });
    assert.throws(() => readZipEntries(zip), /ZIP64/);
    const counted = makeZip([{ name: "index.html", data: Buffer.from("x") }], {
      entryCount: 0xffff,
    });
    assert.throws(() => readZipEntries(counted), /ZIP64/);
  });

  test("壊れた中身は CRC で見つける", () => {
    const zip = makeZip([{ name: "index.html", data: Buffer.from("hello"), method: 0 }]);
    zip[30 + "index.html".length] ^= 0xff;
    const [entry] = readZipEntries(zip);
    assert.throws(() => entry.read(), /壊れています/);
  });

  test("zip でもない入力は断る", () => {
    assert.throws(
      () => readZipEntries(Buffer.from("not a zip at all, definitely not")),
      /zip として読めません/,
    );
  });

  test("Studio と同じく、1つのフォルダを剥がし、__MACOSX と .DS_Store を除く", () => {
    const dir = tempDir();
    const zipPath = path.join(dir, "build.zip");
    fs.writeFileSync(
      zipPath,
      makeZip([
        { name: "MyGame/index.html", data: Buffer.from("<html></html>") },
        { name: "MyGame/js/app.js", data: Buffer.from("1") },
        { name: "MyGame/js/app.js.map", data: Buffer.from("{}") },
        { name: "MyGame/.DS_Store", data: Buffer.from("x") },
        { name: "__MACOSX/MyGame/._index.html", data: Buffer.from("x") },
      ]),
    );
    const { files, skipped } = collectBuild(zipPath);
    assert.deepEqual(
      files.map((file) => file.path),
      ["index.html", "js/app.js"],
    );
    assert.deepEqual(skipped, ["js/app.js.map"]);
  });

  test("一番上に index.html があればフォルダを剥がさない", () => {
    assert.deepEqual(stripSingleRootFolder(["index.html"]), ["index.html"]);
    assert.deepEqual(stripSingleRootFolder(["a/index.html", "a/x.js"]), ["index.html", "x.js"]);
    assert.deepEqual(stripSingleRootFolder(["a/b/index.html"]), ["a/b/index.html"]);
    assert.deepEqual(stripSingleRootFolder(["a/x.js", "b/index.html"]), ["a/x.js", "b/index.html"]);
    // ロード設定だけでは剥がさない（Studio と同じ）。
    assert.deepEqual(stripSingleRootFolder(["a/__grush-player.json", "a/x.js"]), [
      "a/__grush-player.json",
      "a/x.js",
    ]);
    // 剥がすと Godot の書き出しになるときは剥がす。
    assert.deepEqual(stripSingleRootFolder(["a/game.pck", "a/game.wasm", "a/game.js"]), [
      "game.pck",
      "game.wasm",
      "game.js",
    ]);
    // 剥がす前が Unity のビルドなら剥がさない。
    const unity = [
      "a/Build/g.loader.js",
      "a/Build/g.framework.js",
      "a/Build/g.wasm",
      "a/Build/g.data",
      "a/x.pck",
      "a/x.wasm",
      "a/x.js",
    ];
    assert.deepEqual(stripSingleRootFolder(unity), unity);
  });
});

describe("上げる前の検査", () => {
  const ok = { path: "index.html", size: 10 };

  test("GameRush の規則で断る", () => {
    const cases = [
      [[], "build.noFiles"],
      [[ok, { path: "a.exe", size: 1 }], "build.unsupportedExtension"],
      [[ok, { path: "../a.js", size: 1 }], "build.unsafeSegment"],
      [[ok, { path: "a//b.js", size: 1 }], "build.unsafeSegment"],
      [[ok, { path: "a.js", size: 1 }, { path: "a.js", size: 1 }], "build.duplicatePath"],
      [[{ path: "main.js", size: 1 }], "build.missingEntry"],
      [[ok, { path: "__grush-player.json", size: 1 }], "build.conflictingEntry"],
      [[ok, { path: "a.js", size: MAX_BUILD_BYTES }], "build.tooLarge"],
      [[ok, { path: "sub/page.html.gz", size: 1 }], "build.compressedHtml"],
      [[ok, { path: "big.html", size: 5 * 1024 * 1024 + 1 }], "build.htmlTooLarge"],
      [[ok, { path: "grush.json", size: 64 * 1024 + 1 }], "build.leaderboardManifestTooLarge"],
    ];
    for (const [files, code] of cases) {
      const result = validateBuildFiles(/** @type {any} */ (files));
      assert.equal(result.ok ? "ok" : result.code, code, JSON.stringify(files));
    }
  });

  test("ファイル数の上限", () => {
    const files = [
      ok,
      ...Array.from({ length: MAX_BUILD_FILE_COUNT }, (_, i) => ({ path: `f${i}.js`, size: 1 })),
    ];
    assert.equal(
      validateBuildFiles(files).ok ? "ok" : /** @type {any} */ (validateBuildFiles(files)).code,
      "build.tooManyFiles",
    );
    assert.ok(validateBuildFiles(files.slice(0, MAX_BUILD_FILE_COUNT)).ok);
  });

  test("ロード設定だけを入口にでき、.br / .gz はその前の拡張子で決まる", () => {
    const result = validateBuildFiles([
      { path: "__grush-player.json", size: 100 },
      { path: "Build/x.wasm.br", size: 100 },
      { path: "Build/x.data.gz", size: 100 },
    ]);
    assert.deepEqual(result, { ok: true, totalBytes: 300 });
  });

  test("圧縮したファイルは展開せずにそのまま送る（サーバも encoding の無いファイルを展開しない）", () => {
    const notGzip = Buffer.from("not really gzip");
    const files = [
      { path: "index.html", size: 4, read: () => Buffer.from("<p>x") },
      { path: "a.data.gz", size: notGzip.length, read: () => notGzip },
    ];
    assert.deepEqual(precheckBuild(files), { totalBytes: 4 + notGzip.length });
  });

  test("index.html のルート絶対パスの参照を断る", () => {
    const html = Buffer.from('<script src="/assets/app.js"></script>');
    assert.throws(
      () => precheckBuild([{ path: "index.html", size: html.length, read: () => html }]),
      /ルート絶対パス/,
    );
  });

  test("フォルダの中のプレイに要らないファイルは除いて知らせる", () => {
    const dir = tempDir();
    writeTree(dir, {
      "index.html": "<p>hi</p>",
      "index.html.gz": "x",
      "__grush-canvas.json": "{}",
      "app.css.map": "{}",
      "Thumbs.db": "x",
      "img/a.png": "x",
    });
    const { files, skipped } = collectBuild(dir);
    assert.deepEqual(
      files.map((file) => file.path),
      ["img/a.png", "index.html"],
    );
    assert.deepEqual(skipped.sort(), ["__grush-canvas.json", "app.css.map", "index.html.gz"]);
  });
});

describe("保存したトークン", () => {
  test("Unity と同じフォルダの別ファイルに、本人だけが読める権限で書く", {
    skip: process.platform === "win32",
  }, () => {
    const home = tempDir();
    const host = {
      env: { XDG_CONFIG_HOME: path.join(home, "config") },
      platform: "linux",
      homedir: home,
    };
    const credentials = {
      origin: "https://gamerush.jp",
      token: `grush_pat_${"a".repeat(43)}`,
      preview: "aaaaaa",
      clientName: "GameRush CLI",
      expiresAt: "2099-01-01T00:00:00.000Z",
      scopes: ["builds:write"],
      gameIds: null,
    };
    saveCredentials(host, credentials);
    const file = credentialsPath(host);
    assert.equal(file, path.join(home, "config", "gamerush", "cli-token.json"));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.deepEqual(loadCredentials(host), credentials);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, "utf8"))), [
      "origin",
      "token",
      "preview",
      "clientName",
      "expiresAt",
      "scopes",
      "gameIds",
    ]);
  });

  test("保存に失敗しても、前に保存したトークンは消さない", {
    skip: process.platform === "win32",
  }, () => {
    const home = tempDir();
    const host = {
      env: { XDG_CONFIG_HOME: path.join(home, "config") },
      platform: "linux",
      homedir: home,
    };
    const base = {
      origin: "https://gamerush.jp",
      preview: "aaaaaa",
      clientName: "GameRush CLI",
      expiresAt: "2099-01-01T00:00:00.000Z",
      scopes: ["builds:write"],
      gameIds: null,
    };
    saveCredentials(host, { ...base, token: `grush_pat_${"a".repeat(43)}` });
    // 一時ファイルの場所を塞いで、書き込みを失敗させる。
    const blocker = `${credentialsPath(host)}.${process.pid}.tmp`;
    fs.mkdirSync(blocker);
    assert.throws(
      () => saveCredentials(host, { ...base, token: `grush_pat_${"b".repeat(43)}` }),
      /保存できませんでした/,
    );
    assert.equal(loadCredentials(host)?.token, `grush_pat_${"a".repeat(43)}`);
    assert.ok(fs.statSync(blocker).isDirectory());
  });

  test("macOS と Windows の場所", () => {
    assert.equal(
      credentialsPath({ env: {}, platform: "darwin", homedir: "/Users/a" }),
      "/Users/a/Library/Application Support/GameRush/cli-token.json",
    );
    assert.equal(
      credentialsPath({
        env: { APPDATA: "C:\\Users\\a\\AppData\\Roaming" },
        platform: "win32",
        homedir: "C:\\Users\\a",
      }),
      "C:\\Users\\a\\AppData\\Roaming\\GameRush\\cli-token.json",
    );
  });
});

/** GameRush の API の偽物。ブラウザの承認は、openBrowser の中で redirect_uri を叩いて代わりに行う。 */
async function startFakeGameRush() {
  const state = {
    challenge: "",
    redirectUri: "",
    secret: `grush_pat_${"b".repeat(43)}`,
    gameId: "11111111-2222-4333-8444-555555555555",
    buildId: "66666666-7777-4888-8999-000000000000",
    manifest: /** @type {{ path: string, size: number }[]} */ ([]),
    stored: /** @type {Map<string, Buffer>} */ (new Map()),
    failOnce: new Set(["js/app.js"]),
    requests: /** @type {string[]} */ ([]),
    createBodies: /** @type {any[]} */ ([]),
  };
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const url = new URL(request.url ?? "/", "http://x");
    state.requests.push(`${request.method} ${url.pathname}`);
    const json = (status, body) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const authorized = request.headers.authorization === `Bearer ${state.secret}`;

    if (request.method === "POST" && url.pathname === "/api/api-token-authorizations/exchange") {
      const body = JSON.parse(raw.toString());
      const expected = createHash("sha256").update(body.codeVerifier).digest("base64url");
      if (
        body.code !== "c".repeat(43) ||
        expected !== state.challenge ||
        body.redirectUri !== state.redirectUri
      ) {
        return json(400, { error: "Invalid authorization code." });
      }
      return json(200, {
        token: {
          id: "t",
          name: "GameRush CLI",
          preview: "bbbbbb",
          clientName: "GameRush CLI",
          scopes: LOGIN_SCOPES,
          gameIds: null,
          expiresAt: "2099-01-01T00:00:00.000Z",
          lastUsedAt: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        secret: state.secret,
      });
    }
    if (!authorized && url.pathname.startsWith("/api/"))
      return json(401, { error: "Unauthorized" });
    if (request.method === "POST" && url.pathname === "/api/games") {
      const body = JSON.parse(raw.toString());
      state.createBodies.push(body);
      if (body.confirmAssetRights !== true) return json(403, { code: "rights.confirmRequired" });
      return json(200, { game: { id: state.gameId, title: body.title }, mediaUploads: [] });
    }
    if (request.method === "POST" && url.pathname === `/api/games/${state.gameId}/builds`) {
      const body = JSON.parse(raw.toString());
      state.createBodies.push(body);
      state.manifest = body.files;
      const origin = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
      return json(200, {
        build: { id: state.buildId, status: "uploading" },
        uploadUrls: body.files.map((file) => ({
          path: file.path,
          key: `games/${state.gameId}/builds/${state.buildId}/${file.path}`,
          url: `${origin}/r2/${encodeURIComponent(file.path)}`,
          headers: { "If-None-Match": "*" },
        })),
        entryUrl: `https://${state.gameId}.example.test/${state.buildId}/index.html`,
      });
    }
    if (request.method === "PUT" && url.pathname.startsWith("/r2/")) {
      const filePath = decodeURIComponent(url.pathname.slice(4));
      if (request.headers["if-none-match"] !== "*") return json(400, {});
      if (state.failOnce.delete(filePath)) return json(500, {});
      if (state.stored.has(filePath)) {
        response.writeHead(412);
        return response.end();
      }
      state.stored.set(filePath, raw);
      response.writeHead(200);
      return response.end();
    }
    if (request.method === "POST" && url.pathname === `/api/builds/${state.buildId}/complete`) {
      const missing = state.manifest.filter(
        (file) => state.stored.get(file.path)?.length !== file.size,
      );
      if (missing.length > 0) return json(409, { error: "missing", details: { missing } });
      return json(200, {
        build: { id: state.buildId, status: "ready" },
        entryUrl: `https://${state.gameId}.example.test/${state.buildId}/index.html?v=1&t=x`,
        leaderboards: {
          failed: [{ key: "score", code: "build.leaderboardManifestSemanticsLocked" }],
        },
      });
    }
    json(404, { error: "Not found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const origin = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
  return { server, state, origin };
}

/** @param {Record<string, string>} env */
function cliDeps(env, extra = {}) {
  const home = tempDir();
  const out = [];
  const err = [];
  return {
    out,
    err,
    deps: {
      fetch: (input, init) => fetch(input, init),
      host: {
        env: { XDG_CONFIG_HOME: path.join(home, "config"), ...env },
        platform: "linux",
        homedir: home,
      },
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      openBrowser: () => {},
      confirm: async () => true,
      isInteractive: false,
      sleep: async () => {},
      ...extra,
    },
  };
}

describe("通しの流れ（偽の GameRush）", () => {
  test("login から --new の upload と logout まで", {
    skip: process.platform === "win32",
  }, async () => {
    const fake = await startFakeGameRush();
    try {
      const { deps, out, err } = cliDeps(
        {},
        {
          openBrowser: async (/** @type {string} */ url) => {
            const params = new URL(url).searchParams;
            assert.equal(new URL(url).origin, fake.origin);
            fake.state.challenge = String(params.get("code_challenge"));
            fake.state.redirectUri = String(params.get("redirect_uri"));
            assert.match(fake.state.redirectUri, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/);
            const back = new URL(fake.state.redirectUri);
            back.searchParams.set("code", "c".repeat(43));
            back.searchParams.set("state", String(params.get("state")));
            const response = await fetch(back);
            assert.equal(response.status, 200);
            assert.match(await response.text(), /接続が完了しました/);
          },
        },
      );

      assert.equal(await run(["login", "--origin", fake.origin], deps), 0, err.join("\n"));
      const saved = loadCredentials(deps.host);
      assert.equal(saved?.token, fake.state.secret);
      assert.equal(saved?.origin, fake.origin);

      out.length = 0;
      assert.equal(await run(["whoami"], deps), 0);
      assert.ok(out.some((line) => line.includes("bbbbbb")));
      assert.ok(out.some((line) => line.includes("games:create")));

      const dir = tempDir();
      writeTree(dir, {
        "MyGame/index.html": '<!doctype html><script src="js/app.js"></script>',
        "MyGame/js/app.js": "console.log('hi');",
        "MyGame/grush.json": JSON.stringify({ leaderboards: {} }),
      });
      const zipPath = path.join(dir, "game.zip");
      fs.writeFileSync(
        zipPath,
        makeZip(
          ["index.html", "js/app.js", "grush.json"].map((name) => ({
            name: `MyGame/${name}`,
            data: fs.readFileSync(path.join(dir, "MyGame", name)),
          })),
        ),
      );

      // 対話できないところで --new を --yes なしに通さない。
      err.length = 0;
      assert.equal(await run(["upload", zipPath, "--new", "テストのゲーム"], deps), 1);
      assert.match(err.join("\n"), /--yes/);
      assert.equal(fake.state.requests.filter((r) => r === "POST /api/games").length, 0);

      out.length = 0;
      err.length = 0;
      assert.equal(
        await run(["upload", zipPath, "--new", "テストのゲーム", "--yes"], deps),
        0,
        err.join("\n"),
      );
      const [gameBody, buildBody] = fake.state.createBodies;
      assert.equal(gameBody.title, "テストのゲーム");
      assert.equal(gameBody.visibility, "private");
      assert.equal(gameBody.acceptTerms, true);
      assert.equal(gameBody.confirmAssetRights, true);
      assert.match(gameBody.operationId, /^[0-9a-f-]{36}$/);
      assert.match(buildBody.operationId, /^[0-9a-f-]{36}$/);
      assert.deepEqual(buildBody.files.map((/** @type {any} */ file) => file.path).sort(), [
        "grush.json",
        "index.html",
        "js/app.js",
      ]);
      assert.equal(fake.state.stored.get("js/app.js")?.toString(), "console.log('hi');");
      assert.ok(fake.state.requests.includes(`POST /api/builds/${fake.state.buildId}/complete`));
      const text = out.join("\n");
      assert.match(text, new RegExp(`ゲーム ID: ${fake.state.gameId}`));
      assert.match(text, new RegExp(`${fake.origin}/studio/games/${fake.state.gameId}`));
      assert.doesNotMatch(text, /example\.test/);
      assert.match(text, /スコアが投稿済み/);

      // 既存のゲームへ、フォルダから。送り済みのファイルの 412 は成功に扱う。
      out.length = 0;
      err.length = 0;
      assert.equal(
        await run(["upload", path.join(dir, "MyGame"), "--game", fake.state.gameId], deps),
        0,
        err.join("\n"),
      );

      out.length = 0;
      assert.equal(await run(["logout"], deps), 0);
      assert.equal(loadCredentials(deps.host), null);
      assert.match(out.join("\n"), /失効させてください/);
    } finally {
      fake.server.close();
    }
  });

  test("GRUSH_TOKEN は保存したトークンより先に使う", async () => {
    const fake = await startFakeGameRush();
    try {
      const { deps, out, err } = cliDeps({
        GRUSH_TOKEN: fake.state.secret,
        GRUSH_ORIGIN: fake.origin,
      });
      const dir = tempDir();
      writeTree(dir, { "index.html": "<p>hi</p>" });
      assert.equal(
        await run(["upload", dir, "--game", fake.state.gameId], deps),
        0,
        err.join("\n"),
      );
      assert.match(out.join("\n"), /アップロードが終わりました/);
    } finally {
      fake.server.close();
    }
  });

  test("期限の切れたトークンでは送らずにログインし直しを促す", {
    skip: process.platform === "win32",
  }, async () => {
    const { deps, err } = cliDeps({});
    saveCredentials(deps.host, {
      origin: "https://gamerush.jp",
      token: `grush_pat_${"a".repeat(43)}`,
      preview: "aaaaaa",
      clientName: "GameRush CLI",
      expiresAt: "2020-01-01T00:00:00.000Z",
      scopes: LOGIN_SCOPES,
      gameIds: null,
    });
    const dir = tempDir();
    writeTree(dir, { "index.html": "<p>hi</p>" });
    deps.fetch = () => {
      throw new Error("送らない");
    };
    assert.equal(
      await run(["upload", dir, "--game", "11111111-2222-4333-8444-555555555555"], deps),
      1,
    );
    assert.match(err.join("\n"), /期限が切れています.*grush login/);
  });

  test("API のエラーの code を日本語にする", async () => {
    const fake = await startFakeGameRush();
    try {
      const { deps, err } = cliDeps({
        GRUSH_TOKEN: `grush_pat_${"z".repeat(43)}`,
        GRUSH_ORIGIN: fake.origin,
      });
      const dir = tempDir();
      writeTree(dir, { "index.html": "<p>hi</p>" });
      assert.equal(await run(["upload", dir, "--game", fake.state.gameId], deps), 1);
      assert.match(err.join("\n"), /grush login/);
    } finally {
      fake.server.close();
    }
  });
});
