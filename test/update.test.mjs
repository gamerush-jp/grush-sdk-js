import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { readInstallSpec } from "../cli/agents.mjs";
import { packageVersion, run } from "../cli/main.mjs";
import {
  classifyJsFile,
  detectProject,
  rewriteJsdelivr,
  rewriteUnityManifest,
} from "../cli/project.mjs";
import {
  VERSION_CHECK_TTL_MS,
  cachedLatestVersion,
  compareVersions,
  normalizeVersion,
  versionCheckPath,
} from "../cli/releases.mjs";
import { extractSourceZip, safeRelativePath } from "../cli/update.mjs";
import { jsVersionInBuild } from "../cli/version-check.mjs";
import { crc32 } from "../cli/zip.mjs";

const roots = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grush-update-"));
  roots.push(dir);
  return dir;
}
after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

const read = (/** @type {string} */ file) => fs.readFileSync(file, "utf8");

/** @param {string} dir @param {Record<string, string | Buffer>} files */
function writeTree(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

/** @param {Record<string, string | Buffer>} files */
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [entryName, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const body = deflateRawSync(data);
    const name = Buffer.from(entryName, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, eocd]);
}

/** GitHub のソースの zip と同じく、全部を1つのフォルダに入れる。 @param {Record<string, string>} files */
function sourceZip(files) {
  return makeZip(
    Object.fromEntries(
      Object.entries(files).map(([name, data]) => [`gamerush-jp-repo-abc123/${name}`, data]),
    ),
  );
}

const banner = (/** @type {string} */ version) =>
  `/*! GameRush SDK for JavaScript v${version}\n * Docs: https://gamerush.jp/sdk\n */\n`;
const DTS = "// Types for the GameRush SDK for JavaScript.\nexport type X = 1;\n";

/** 最小限の AI エージェント向けの文書。 @param {string} prefix @param {string} marker */
function agentDocs(prefix, marker) {
  const spec = readInstallSpec();
  return {
    [`${prefix}/install.json`]: JSON.stringify(spec),
    [`${prefix}/AGENTS.md`]: `# ${marker} ${spec.versionPlaceholder}\n`,
    [`${prefix}/docs/sdk-basics.md`]: `${marker}\n`,
  };
}

/**
 * 偽の GitHub。latest は種類ごとの最新の版、zips はタグの zip。
 * @param {{ latest?: Record<string, string>, zips?: Record<string, Buffer>, fail?: boolean }} options
 */
function fakeGitHub({ latest = {}, zips = {}, fail = false }) {
  const calls = [];
  const fetch = async (/** @type {string} */ url, /** @type {any} */ init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    if (fail) throw new Error("offline");
    const release = /repos\/gamerush-jp\/grush-sdk-(\w+)\/releases\/latest$/.exec(url);
    if (release) {
      const version = latest[release[1]];
      return version
        ? new Response(JSON.stringify({ tag_name: `v${version}` }), { status: 200 })
        : new Response("{}", { status: 404 });
    }
    const zip = /repos\/gamerush-jp\/grush-sdk-(\w+)\/zipball\/refs\/tags\/v([\d.]+)$/.exec(url);
    if (zip) {
      const body = zips[`${zip[1]}@${zip[2]}`];
      return body ? new Response(body, { status: 200 }) : new Response("", { status: 404 });
    }
    return new Response("", { status: 404 });
  };
  return { fetch, calls };
}

/**
 * @param {{ fetch: any, interactive?: boolean, answer?: boolean, env?: Record<string, string>, now?: Date }} options
 */
function cliDeps({
  fetch,
  interactive = false,
  answer = true,
  env = {},
  now = new Date("2026-11-26T00:00:00Z"),
}) {
  const home = tempDir();
  const out = [];
  const err = [];
  const questions = [];
  return {
    out,
    err,
    questions,
    home,
    deps: /** @type {any} */ ({
      // GameRush の API は 401 を返す（upload のお知らせのテストで、上げる手前で止める）。
      fetch: async () =>
        new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      sleep: async () => {},
      releaseFetch: fetch,
      host: {
        env: { XDG_CONFIG_HOME: path.join(home, "config"), ...env },
        platform: "linux",
        homedir: home,
      },
      out: (/** @type {string} */ line) => out.push(line),
      err: (/** @type {string} */ line) => err.push(line),
      openBrowser: () => {},
      confirm: async (/** @type {string} */ question) => {
        questions.push(question);
        return answer;
      },
      isInteractive: interactive,
      now: () => now,
    }),
  };
}

describe("版", () => {
  test("v の有無を問わず読み、数として比べる", () => {
    assert.equal(normalizeVersion("v1.2.3"), "1.2.3");
    assert.equal(normalizeVersion("1.10.0"), "1.10.0");
    assert.equal(normalizeVersion("main"), null);
    assert.ok(compareVersions("1.9.0", "1.10.0") < 0);
    assert.equal(compareVersions("0.23.0", "0.23.0"), 0);
  });
});

describe("Unity の manifest.json", () => {
  const manifest = (url, eol = "\n") =>
    [
      "{",
      '    "dependencies": {',
      '        "com.unity.ugui": "1.0.0",',
      `        "cc.gamerush.sdk"  :  "${url}",`,
      '        "com.unity.modules.audio": "1.0.0"',
      "    }",
      "}",
      "",
    ].join(eol);

  test("タグだけを書き換え、字下げ・空白・CRLF はそのまま", () => {
    const before = manifest("https://github.com/gamerush-jp/grush-sdk-unity.git#v1.20.0", "\r\n");
    const after = rewriteUnityManifest(before, "1.22.0");
    assert.equal(
      after,
      manifest("https://github.com/gamerush-jp/grush-sdk-unity.git#v1.22.0", "\r\n"),
    );
  });

  test("以前の持ち主の URL も受け、今の持ち主にそろえる", () => {
    const after = rewriteUnityManifest(
      manifest("https://github.com/gamerush-cc/grush-sdk-unity.git#v1.2.0"),
      "1.22.0",
    );
    assert.equal(after, manifest("https://github.com/gamerush-jp/grush-sdk-unity.git#v1.22.0"));
  });

  test("タグでない git の値とローカルのフォルダは書き換えない", () => {
    assert.equal(
      rewriteUnityManifest(
        manifest("https://github.com/gamerush-jp/grush-sdk-unity.git#main"),
        "1.0.0",
      ),
      null,
    );
    assert.equal(rewriteUnityManifest(manifest("file:../../grush-sdk-unity"), "1.0.0"), null);
  });

  test("grush update で書き換え、packages-lock.json には触れない", async () => {
    const project = tempDir();
    const lock = '{\n  "dependencies": {}\n}\n';
    writeTree(project, {
      "Packages/manifest.json": manifest(
        "https://github.com/gamerush-jp/grush-sdk-unity.git#v1.20.0",
      ),
      "Packages/packages-lock.json": lock,
    });
    const github = fakeGitHub({ latest: { unity: "1.22.0", js: packageVersion() } });
    const { deps, out } = cliDeps({ fetch: github.fetch });
    assert.equal(await run(["update", project, "--yes"], deps), 0);
    assert.equal(
      read(path.join(project, "Packages/manifest.json")),
      manifest("https://github.com/gamerush-jp/grush-sdk-unity.git#v1.22.0"),
    );
    assert.equal(read(path.join(project, "Packages/packages-lock.json")), lock);
    assert.ok(out.some((line) => line.includes("cc.gamerush.sdk v1.20.0 → v1.22.0")));
    // .gamerush/ が無いので、リリースの zip は取らない。
    assert.ok(!github.calls.some((call) => call.url.includes("zipball")));
    assert.deepEqual(
      fs.readdirSync(project).filter((name) => name.startsWith(".grush-update")),
      [],
    );
  });

  test("ローカルのフォルダから入れていれば、手順だけを出す", async () => {
    const project = tempDir();
    writeTree(project, { "Packages/manifest.json": manifest("file:../sdk/cc.gamerush.sdk") });
    const before = read(path.join(project, "Packages/manifest.json"));
    const { deps, out } = cliDeps({ fetch: fakeGitHub({ latest: { unity: "1.22.0" } }).fetch });
    assert.equal(await run(["update", project, "--yes"], deps), 0);
    assert.equal(read(path.join(project, "Packages/manifest.json")), before);
    assert.ok(
      out.some((line) => line.startsWith("手で上げてください:") && line.includes("#v1.22.0")),
    );
  });
});

describe("Godot", () => {
  const plugin = (version) =>
    `[plugin]\n\nname="GameRush SDK"\nversion="${version}"\nscript="plugin.gd"\n`;

  test("addons/grush_sdk と grush_sdk_build をリリースの中身と入れ替え、.uid と文書を引き継ぐ", async () => {
    const project = tempDir();
    writeTree(project, {
      "project.godot": "config_version=5\n",
      "addons/grush_sdk/plugin.cfg": plugin("1.17.0"),
      "addons/grush_sdk/grush.gd": "old",
      "addons/grush_sdk/grush.gd.uid": "uid://keep",
      "addons/grush_sdk/removed.gd": "gone",
      "addons/grush_sdk_build/plugin.cfg": "old build",
      "addons/other/keep.gd": "keep",
      ".gamerush/AGENTS.md": "old",
      "AGENTS.md": "# mine\n",
    });
    const zip = sourceZip({
      "addons/grush_sdk/plugin.cfg": plugin("1.19.0"),
      "addons/grush_sdk/grush.gd": "new",
      "addons/grush_sdk_build/plugin.cfg": "new build",
      "samples/demo.gd": "sample",
      ...agentDocs("addons/grush_sdk/agents", "godot-docs"),
    });
    const github = fakeGitHub({
      latest: { godot: "1.19.0", js: packageVersion() },
      zips: { "godot@1.19.0": zip },
    });
    const { deps } = cliDeps({ fetch: github.fetch });
    assert.equal(await run(["update", project, "--yes"], deps), 0);

    assert.equal(read(path.join(project, "addons/grush_sdk/plugin.cfg")), plugin("1.19.0"));
    assert.equal(read(path.join(project, "addons/grush_sdk/grush.gd")), "new");
    assert.equal(read(path.join(project, "addons/grush_sdk/grush.gd.uid")), "uid://keep");
    assert.equal(fs.existsSync(path.join(project, "addons/grush_sdk/removed.gd")), false);
    assert.equal(read(path.join(project, "addons/grush_sdk_build/plugin.cfg")), "new build");
    assert.equal(read(path.join(project, "addons/other/keep.gd")), "keep");
    assert.equal(fs.existsSync(path.join(project, "samples")), false);
    assert.match(
      read(path.join(project, ".gamerush/AGENTS.md")),
      /godot-docs grush-sdk-godot 1\.19\.0/,
    );
    assert.ok(read(path.join(project, "AGENTS.md")).startsWith("# mine\n"));
    assert.deepEqual(
      fs.readdirSync(project).filter((name) => name.startsWith(".grush-update")),
      [],
    );
  });

  test("作者が足したファイルは予定に出し、入れ替えた後も退避先に残す", async () => {
    const project = tempDir();
    writeTree(project, {
      "addons/grush_sdk/plugin.cfg": plugin("1.17.0"),
      "addons/grush_sdk/my_patch.gd": "mine",
    });
    const zip = sourceZip({ "addons/grush_sdk/plugin.cfg": plugin("1.19.0") });
    const github = fakeGitHub({ latest: { godot: "1.19.0" }, zips: { "godot@1.19.0": zip } });

    const dry = cliDeps({ fetch: github.fetch, env: { GRUSH_NO_UPDATE_CHECK: "1" } });
    assert.equal(await run(["update", project, "--dry-run"], dry.deps), 0);
    assert.ok(dry.out.some((line) => line.includes("v1.19.0 に無いので")));
    assert.ok(dry.out.some((line) => line.trim() === "addons/grush_sdk/my_patch.gd"));
    assert.ok(fs.existsSync(path.join(project, "addons/grush_sdk/my_patch.gd")));

    const { deps, out } = cliDeps({ fetch: github.fetch, env: { GRUSH_NO_UPDATE_CHECK: "1" } });
    assert.equal(await run(["update", project, "--yes"], deps), 0);
    assert.equal(fs.existsSync(path.join(project, "addons/grush_sdk/my_patch.gd")), false);
    const backups = fs.readdirSync(project).filter((name) => name.startsWith(".grush-backup-"));
    assert.equal(backups.length, 1);
    assert.equal(read(path.join(project, backups[0], "addons/grush_sdk/my_patch.gd")), "mine");
    assert.ok(out.some((line) => line.includes(backups[0])));
  });

  test("後の書き換えに失敗したら、入れ替えたアドオンも元に戻し、退避先を残す", async () => {
    const project = tempDir();
    writeTree(project, {
      "addons/grush_sdk/plugin.cfg": plugin("1.17.0"),
      "addons/grush_sdk/grush.gd": "old",
      ".gamerush/AGENTS.md": "old docs",
    });
    // リリースの install.json がプロジェクトの外を指している。
    const zip = sourceZip({
      "addons/grush_sdk/plugin.cfg": plugin("1.19.0"),
      "addons/grush_sdk/grush.gd": "new",
      "addons/grush_sdk/agents/install.json": JSON.stringify({
        ...readInstallSpec(),
        dir: "../outside",
      }),
      "addons/grush_sdk/agents/AGENTS.md": "x",
    });
    const github = fakeGitHub({ latest: { godot: "1.19.0" }, zips: { "godot@1.19.0": zip } });
    const { deps, err } = cliDeps({ fetch: github.fetch, env: { GRUSH_NO_UPDATE_CHECK: "1" } });
    assert.equal(await run(["update", project, "--yes"], deps), 1);
    const text = err.join("\n");
    assert.match(text, /install\.json の形が正しくありません/);
    assert.match(text, /先に書き換えた 1 件は元に戻しました/);
    assert.equal(read(path.join(project, "addons/grush_sdk/plugin.cfg")), plugin("1.17.0"));
    assert.equal(read(path.join(project, "addons/grush_sdk/grush.gd")), "old");
    assert.equal(read(path.join(project, ".gamerush/AGENTS.md")), "old docs");
    assert.equal(fs.existsSync(path.join(path.dirname(project), "outside")), false);
    const backups = fs.readdirSync(project).filter((name) => name.startsWith(".grush-backup-"));
    assert.equal(backups.length, 1);
    assert.ok(text.includes(backups[0]));
    assert.ok(!fs.readdirSync(project).some((name) => name.startsWith(".grush-update-")));
  });

  test("リリースの版が食い違えば、何も入れ替えない", async () => {
    const project = tempDir();
    writeTree(project, { "addons/grush_sdk/plugin.cfg": plugin("1.17.0") });
    const zip = sourceZip({ "addons/grush_sdk/plugin.cfg": plugin("1.18.0") });
    const github = fakeGitHub({ latest: { godot: "1.19.0" }, zips: { "godot@1.19.0": zip } });
    const { deps, err } = cliDeps({ fetch: github.fetch });
    assert.equal(await run(["update", project, "--yes"], deps), 1);
    assert.match(err.join("\n"), /v1\.19\.0 ではありません/);
    assert.equal(read(path.join(project, "addons/grush_sdk/plugin.cfg")), plugin("1.17.0"));
  });

  test("シンボリックリンクの addons/grush_sdk は書き換えない", {
    skip: process.platform === "win32",
  }, async () => {
    const project = tempDir();
    const elsewhere = tempDir();
    writeTree(elsewhere, { "plugin.cfg": plugin("1.17.0") });
    fs.mkdirSync(path.join(project, "addons"));
    fs.symlinkSync(elsewhere, path.join(project, "addons/grush_sdk"));
    const { deps, out } = cliDeps({ fetch: fakeGitHub({ latest: { godot: "1.19.0" } }).fetch });
    assert.equal(await run(["update", project, "--yes"], deps), 0);
    assert.ok(out.some((line) => line.includes("シンボリックリンク")));
    assert.equal(read(path.join(elsewhere, "plugin.cfg")), plugin("1.17.0"));
  });
});

describe("zip の展開", () => {
  test("危ないパスを断る", () => {
    for (const name of ["../x", "a/../../x", "/abs", "C:/x", "a\\b", "a//b"]) {
      assert.throws(() => safeRelativePath(name), /危ないパス/, name);
    }
    assert.equal(safeRelativePath("addons/grush_sdk/a.gd"), "addons/grush_sdk/a.gd");
  });

  test("一番上のフォルダを剥がして展開し、.. を含む zip は止める", () => {
    const dest = tempDir();
    assert.deepEqual(extractSourceZip(sourceZip({ "a/b.txt": "x" }), dest), ["a/b.txt"]);
    assert.equal(read(path.join(dest, "a/b.txt")), "x");
    assert.throws(
      () => extractSourceZip(sourceZip({ "../evil.txt": "x" }), tempDir()),
      /危ないパス/,
    );
  });
});

describe("JavaScript", () => {
  test("先頭の注記で SDK のファイルを見分ける", () => {
    assert.deepEqual(
      classifyJsFile("grush-sdk.js", banner("0.20.0"), () => `${banner("0.20.0")}(()=>{})();`),
      {
        version: "0.20.0",
        flavor: "iife",
      },
    );
    assert.deepEqual(
      classifyJsFile("grush-sdk.js", banner("0.20.0"), () => `${banner("0.20.0")}export { a };`),
      { version: "0.20.0", flavor: "esm" },
    );
    assert.deepEqual(
      classifyJsFile("grush-sdk.mjs", banner("0.21.0"), () => ""),
      {
        version: "0.21.0",
        flavor: "esm",
      },
    );
    // 先頭が注記でも、SDK の名前でなければ（バンドルなど）入れ替えない。
    assert.equal(
      classifyJsFile("vendor.js", banner("0.20.0"), () => banner("0.20.0")),
      null,
    );
    assert.equal(
      classifyJsFile("sdk.mjs", banner("0.20.0"), () => ""),
      null,
    );
    assert.deepEqual(
      classifyJsFile("grush-sdk.d.ts", DTS, () => DTS),
      { version: null, flavor: "dts" },
    );
    assert.equal(
      classifyJsFile("main.js", `import x;\n${banner("0.20.0")}`, () => ""),
      null,
    );
  });

  test("jsDelivr の URL の版を書き換える", () => {
    const html =
      '<script src="https://cdn.jsdelivr.net/gh/gamerush-jp/grush-sdk-js@v0.19.0/grush-sdk.js"></script>\n' +
      '<script src="https://cdn.jsdelivr.net/gh/gamerush-cc/grush-sdk-js@0.18.1/grush-sdk.js"></script>\n' +
      '<script src="https://cdn.jsdelivr.net/gh/gamerush-jp/grush-sdk-js@main/grush-sdk.js"></script>\n';
    assert.equal(
      rewriteJsdelivr(html, "0.23.0"),
      '<script src="https://cdn.jsdelivr.net/gh/gamerush-jp/grush-sdk-js@v0.23.0/grush-sdk.js"></script>\n' +
        '<script src="https://cdn.jsdelivr.net/gh/gamerush-jp/grush-sdk-js@v0.23.0/grush-sdk.js"></script>\n' +
        '<script src="https://cdn.jsdelivr.net/gh/gamerush-jp/grush-sdk-js@main/grush-sdk.js"></script>\n',
    );
  });

  /** @param {string} project */
  function jsProject(project) {
    writeTree(project, {
      "index.html":
        '<script src="https://cdn.jsdelivr.net/gh/gamerush-jp/grush-sdk-js@v0.19.0/grush-sdk.js"></script>\n',
      "lib/grush-sdk.js": `${banner("0.20.0")}(()=>{})();\n`,
      "lib/grush-sdk.mjs": `${banner("0.20.0")}export { a };\n`,
      "lib/grush-sdk.d.ts": DTS,
      "src/main.js": "console.log(1);\n",
      "src/app.bundle.js": `${banner("0.20.0")}export { app };\n`,
      "build/grush-sdk.js": `${banner("0.18.0")}`,
      "node_modules/x/grush-sdk.js": `${banner("0.1.0")}`,
      "vendor/grush-sdk-js/.git": "gitdir: ../../.git/modules/vendor/grush-sdk-js\n",
      "vendor/grush-sdk-js/package.json": '{ "name": "grush-sdk-js" }',
      "vendor/grush-sdk-js/grush-sdk.js": `${banner("0.19.0")}`,
    });
  }
  const jsZip = sourceZip({
    "grush-sdk.js": `${banner("0.23.0")}(()=>{ /* new */ })();\n`,
    "grush-sdk.mjs": `${banner("0.23.0")}export { b };\n`,
    "grush-sdk.d.ts": `${DTS}export type Y = 2;\n`,
    ...agentDocs("agents", "js-docs"),
  });

  test("コピー・型・jsDelivr を見つけ、node_modules と submodule の中は書き換えない", () => {
    const project = tempDir();
    jsProject(project);
    const { js } = detectProject(project);
    assert.deepEqual(
      js.copies.map((copy) => [copy.file, copy.version, copy.flavor]),
      [
        ["lib/grush-sdk.d.ts", "0.20.0", "dts"],
        ["lib/grush-sdk.js", "0.20.0", "iife"],
        ["lib/grush-sdk.mjs", "0.20.0", "esm"],
      ],
    );
    assert.deepEqual(js.cdn, [{ file: "index.html", versions: ["0.19.0"] }]);
    assert.deepEqual(js.submodules, [{ dir: "vendor/grush-sdk-js", version: "0.19.0" }]);
  });

  test("確認なし・対話できないときは、予定だけを出して 1 で終わる", async () => {
    const project = tempDir();
    jsProject(project);
    const github = fakeGitHub({ latest: { js: "0.23.0" }, zips: { "js@0.23.0": jsZip } });
    const { deps, out, err } = cliDeps({ fetch: github.fetch });
    assert.equal(await run(["update", project], deps), 1);
    assert.ok(out.some((line) => line.includes("lib/grush-sdk.js: v0.20.0 → v0.23.0")));
    assert.match(err.join("\n"), /--yes/);
    assert.equal(read(path.join(project, "lib/grush-sdk.js")), `${banner("0.20.0")}(()=>{})();\n`);
  });

  test("--dry-run は書かずに 0 で終わる", async () => {
    const project = tempDir();
    jsProject(project);
    const github = fakeGitHub({ latest: { js: "0.23.0" }, zips: { "js@0.23.0": jsZip } });
    const { deps, out } = cliDeps({ fetch: github.fetch });
    assert.equal(await run(["update", project, "--dry-run"], deps), 0);
    assert.ok(out.some((line) => line.includes("--dry-run")));
    assert.match(read(path.join(project, "index.html")), /@v0\.19\.0/);
  });

  test("対話で断れば書かない", async () => {
    const project = tempDir();
    jsProject(project);
    const { deps, questions } = cliDeps({
      fetch: fakeGitHub({ latest: { js: "0.23.0" }, zips: { "js@0.23.0": jsZip } }).fetch,
      interactive: true,
      answer: false,
    });
    assert.equal(await run(["update", project], deps), 1);
    assert.equal(questions.length, 1);
    assert.match(read(path.join(project, "index.html")), /@v0\.19\.0/);
  });

  test("対話で認めれば、コピーと型と URL を入れ替え、submodule は手順を出す", async () => {
    const project = tempDir();
    jsProject(project);
    writeTree(project, { ".gamerush/AGENTS.md": "old" });
    const github = fakeGitHub({ latest: { js: "0.23.0" }, zips: { "js@0.23.0": jsZip } });
    const { deps, out, questions } = cliDeps({ fetch: github.fetch, interactive: true });
    assert.equal(await run(["update", project], deps), 0);
    assert.equal(questions.length, 1);
    assert.equal(
      read(path.join(project, "lib/grush-sdk.js")),
      `${banner("0.23.0")}(()=>{ /* new */ })();\n`,
    );
    assert.equal(
      read(path.join(project, "lib/grush-sdk.mjs")),
      `${banner("0.23.0")}export { b };\n`,
    );
    assert.equal(read(path.join(project, "lib/grush-sdk.d.ts")), `${DTS}export type Y = 2;\n`);
    assert.match(read(path.join(project, "index.html")), /grush-sdk-js@v0\.23\.0\/grush-sdk\.js/);
    assert.equal(read(path.join(project, "node_modules/x/grush-sdk.js")), banner("0.1.0"));
    assert.equal(read(path.join(project, "build/grush-sdk.js")), banner("0.18.0"));
    assert.equal(
      read(path.join(project, "src/app.bundle.js")),
      `${banner("0.20.0")}export { app };\n`,
    );
    assert.deepEqual(
      fs.readdirSync(project).filter((name) => name.startsWith(".grush-")),
      [],
    );
    assert.equal(read(path.join(project, "vendor/grush-sdk-js/grush-sdk.js")), banner("0.19.0"));
    assert.ok(
      out.some((line) =>
        line.includes(
          "git -C vendor/grush-sdk-js fetch --tags && git -C vendor/grush-sdk-js checkout v0.23.0",
        ),
      ),
    );
    assert.match(read(path.join(project, ".gamerush/AGENTS.md")), /js-docs grush-sdk-js 0\.23\.0/);

    // もう一度実行すると、上げるものは無い。
    const again = cliDeps({ fetch: github.fetch });
    assert.equal(await run(["update", project], again.deps), 0);
    assert.ok(again.out.some((line) => line.includes("自動で書き換えるものはありません")));
  });

  test("--to で版を選べるが、SDK が2種類あれば断る", async () => {
    const project = tempDir();
    jsProject(project);
    const github = fakeGitHub({ zips: { "js@0.21.0": jsZip } });
    const { deps, out } = cliDeps({ fetch: github.fetch, env: { GRUSH_NO_UPDATE_CHECK: "1" } });
    assert.equal(await run(["update", project, "--to", "v0.21.0", "--dry-run"], deps), 0);
    assert.ok(out.some((line) => line.includes("index.html: jsDelivr の URL v0.19.0 → v0.21.0")));
    assert.ok(!github.calls.some((call) => call.url.includes("releases/latest")));

    writeTree(project, { "addons/grush_sdk/plugin.cfg": 'version="1.0.0"\n' });
    const mixed = cliDeps({ fetch: github.fetch });
    assert.equal(await run(["update", project, "--to", "v0.21.0"], mixed.deps), 1);
    assert.match(mixed.err.join("\n"), /--to は SDK が1種類のときだけ/);
  });

  test("--to が無ければ、最新より新しい jsDelivr の URL は下げない", async () => {
    const project = tempDir();
    const newer = "https://cdn.jsdelivr.net/gh/gamerush-jp/grush-sdk-js@v0.30.0/grush-sdk.js";
    writeTree(project, {
      "a.html": `<script src="${newer}"></script>\n`,
      "b.html":
        `<script src="${newer}"></script>\n` +
        '<script src="https://cdn.jsdelivr.net/gh/gamerush-jp/grush-sdk-js@v0.19.0/grush-sdk.js"></script>\n',
    });
    const github = fakeGitHub({ latest: { js: "0.23.0" } });
    const { deps, out } = cliDeps({ fetch: github.fetch, env: { GRUSH_NO_UPDATE_CHECK: "1" } });
    assert.equal(await run(["update", project, "--yes"], deps), 0);
    assert.ok(!out.some((line) => line.includes("a.html")));
    assert.ok(out.some((line) => line.includes("b.html: jsDelivr の URL v0.19.0 → v0.23.0")));
    const b = read(path.join(project, "b.html"));
    assert.ok(b.includes(newer));
    assert.ok(b.includes("grush-sdk-js@v0.23.0/"));
  });

  test("探す量に上限があり、超えたら途中までと知らせる", () => {
    const project = tempDir();
    const files = {};
    for (let index = 0; index < 20; index += 1) files[`f${index}.txt`] = "";
    files["z/grush-sdk.js"] = banner("0.20.0");
    writeTree(project, files);
    const limited = detectProject(project, { maxEntries: 10 });
    assert.equal(limited.js.truncated, true);
    assert.deepEqual(limited.js.copies, []);
    const deep = tempDir();
    writeTree(deep, { [`${"d/".repeat(20)}grush-sdk.js`]: banner("0.20.0") });
    assert.equal(detectProject(deep).js.truncated, true);
    assert.equal(detectProject(project).js.copies.length, 1);
  });

  test("SDK が無いフォルダは断る", async () => {
    const { deps, err } = cliDeps({ fetch: fakeGitHub({}).fetch });
    assert.equal(await run(["update", tempDir()], deps), 1);
    assert.match(err.join("\n"), /SDK が見つかりません/);
  });

  test("GITHUB_TOKEN があれば GitHub へ送る", async () => {
    const project = tempDir();
    jsProject(project);
    const github = fakeGitHub({ latest: { js: "0.23.0" }, zips: { "js@0.23.0": jsZip } });
    const { deps } = cliDeps({ fetch: github.fetch, env: { GITHUB_TOKEN: "t0ken" } });
    assert.equal(await run(["update", project, "--dry-run"], deps), 0);
    assert.equal(github.calls[0].headers.Authorization, "Bearer t0ken");
  });

  test("GITHUB_TOKEN が断られたら、付けずに読み直す", async () => {
    const project = tempDir();
    jsProject(project);
    const github = fakeGitHub({ latest: { js: "0.23.0" }, zips: { "js@0.23.0": jsZip } });
    const fetch = async (/** @type {string} */ url, /** @type {any} */ init) =>
      init?.headers?.Authorization ? new Response("{}", { status: 401 }) : github.fetch(url, init);
    const { deps, out } = cliDeps({
      fetch,
      env: { GITHUB_TOKEN: "stale", GRUSH_NO_UPDATE_CHECK: "1" },
    });
    assert.equal(await run(["update", project, "--dry-run"], deps), 0);
    assert.ok(out.some((line) => line.includes("→ v0.23.0")));
  });
});

describe("版のお知らせ", () => {
  const now = new Date("2026-11-26T00:00:00Z");

  test("最新の版を 24 時間控え、過ぎたら調べ直す", async () => {
    const { deps } = cliDeps({ fetch: null });
    const host = deps.host;
    const github = fakeGitHub({ latest: { js: "0.30.0" } });
    assert.equal(
      await cachedLatestVersion({ fetch: github.fetch, host, kind: "js", now }),
      "0.30.0",
    );
    assert.equal(github.calls.length, 1);
    assert.ok(fs.existsSync(versionCheckPath(host)));

    const later = new Date(now.getTime() + VERSION_CHECK_TTL_MS - 1000);
    assert.equal(
      await cachedLatestVersion({ fetch: github.fetch, host, kind: "js", now: later }),
      "0.30.0",
    );
    assert.equal(github.calls.length, 1);

    const expired = new Date(now.getTime() + VERSION_CHECK_TTL_MS + 1000);
    const newer = fakeGitHub({ latest: { js: "0.31.0" } });
    assert.equal(
      await cachedLatestVersion({ fetch: newer.fetch, host, kind: "js", now: expired }),
      "0.31.0",
    );
    assert.equal(newer.calls.length, 1);
  });

  test("whoami で grush が古ければ stderr に 1 行だけ出す", async () => {
    const { deps, err, out } = cliDeps({
      fetch: fakeGitHub({ latest: { js: "99.0.0" } }).fetch,
      now,
    });
    assert.equal(await run(["whoami"], deps), 1);
    assert.equal(err.length, 1);
    assert.match(err[0], /grush の新しい版 v99\.0\.0/);
    assert.match(err[0], /npx -p github:gamerush-jp\/grush-sdk-js#v99\.0\.0 grush whoami/);
    assert.ok(out.some((line) => line.includes("ログインしていません")));
  });

  test("最新なら何も出さない", async () => {
    const { deps, err } = cliDeps({
      fetch: fakeGitHub({ latest: { js: packageVersion() } }).fetch,
      now,
    });
    await run(["whoami"], deps);
    assert.deepEqual(err, []);
  });

  test("通信に失敗しても黙って続け、1 時間は調べ直さない", async () => {
    const github = fakeGitHub({ fail: true });
    const { deps, err } = cliDeps({ fetch: github.fetch, now });
    assert.equal(await run(["whoami"], deps), 1);
    assert.deepEqual(err, []);
    assert.equal(github.calls.length, 1);
    await run(["whoami"], deps);
    assert.equal(github.calls.length, 1);
  });

  test("壊れた応答も黙って飛ばす", async () => {
    const fetch = async () => new Response("not json", { status: 200 });
    const { deps, err } = cliDeps({ fetch, now });
    await run(["whoami"], deps);
    assert.deepEqual(err, []);
  });

  test("GRUSH_NO_UPDATE_CHECK=1 なら調べない", async () => {
    const github = fakeGitHub({ latest: { js: "99.0.0" } });
    const { deps, err } = cliDeps({
      fetch: github.fetch,
      env: { GRUSH_NO_UPDATE_CHECK: "1" },
      now,
    });
    await run(["whoami"], deps);
    assert.deepEqual(err, []);
    assert.equal(github.calls.length, 0);
  });

  test("grush agents はプロジェクトの SDK が古ければ知らせる", async () => {
    const project = tempDir();
    writeTree(project, {
      "Packages/manifest.json":
        '{ "dependencies": { "cc.gamerush.sdk": "https://github.com/gamerush-jp/grush-sdk-unity.git#v1.20.0" } }\n',
    });
    const github = fakeGitHub({ latest: { js: packageVersion(), unity: "1.22.0" } });
    const { deps, err } = cliDeps({ fetch: github.fetch, now });
    assert.equal(await run(["agents", project], deps), 0);
    assert.equal(err.length, 1);
    assert.match(err[0], /GameRush SDK for Unity は v1\.20\.0 で、最新は v1\.22\.0/);
    assert.ok(err[0].includes(`grush update ${project}`));
  });

  test("ビルドの JavaScript から SDK の版を読む（バンドルの途中でもよい）", () => {
    const file = (/** @type {string} */ name, /** @type {string} */ text) => ({
      path: name,
      size: text.length,
      read: () => Buffer.from(text),
    });
    assert.equal(
      jsVersionInBuild([
        file("index.html", banner("0.1.0")),
        file("assets/app.js", `x;\n${banner("0.21.0")}`),
      ]),
      "0.21.0",
    );
    assert.equal(jsVersionInBuild([file("Build/game.loader.js", "unity")]), null);
  });

  test("upload は古い SDK のビルドを知らせ、上げるのは止めない", async () => {
    const build = tempDir();
    writeTree(build, { "index.html": "<!doctype html>", "sdk.js": banner("0.20.0") });
    const github = fakeGitHub({ latest: { js: packageVersion() } });
    const token = `grush_pat_${"a".repeat(43)}`;
    const { deps, err } = cliDeps({ fetch: github.fetch, now, env: { GRUSH_TOKEN: token } });
    // API が 401 を返すので upload はそこで止まるが、お知らせは出る。
    assert.equal(
      await run(["upload", build, "--game", "00000000-0000-4000-8000-000000000000"], deps),
      1,
    );
    assert.match(err[0], /^エラー: /);
    assert.ok(
      err.some((line) =>
        line.includes(
          `このビルドの GameRush SDK for JavaScript は v0.20.0 で、最新は v${packageVersion()}`,
        ),
      ),
    );
  });
});
