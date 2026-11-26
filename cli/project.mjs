import fs from "node:fs";
import path from "node:path";
import { SDK_OWNER, SDKS, compareVersions, normalizeVersion } from "./releases.mjs";

// ゲームのプロジェクトの中から、入っている GameRush の SDK と版を探す。読むだけで、書き換えは update.mjs が行う。

export const UNITY_PACKAGE = "cc.gamerush.sdk";
export const UNITY_MANIFEST = "Packages/manifest.json";
export const GODOT_ADDON = "addons/grush_sdk";
export const GODOT_BUILD_ADDON = "addons/grush_sdk_build";

// 以前のリポジトリの持ち主。GitHub は転送するが、書き換えるときは今の持ち主にそろえる。
const LEGACY_OWNER = "gamerush-cc";
const UNITY_GIT_URL = new RegExp(
  `^(https://github\\.com/)(${SDK_OWNER}|${LEGACY_OWNER})(/grush-sdk-unity(?:\\.git)?)#(v?\\d+\\.\\d+\\.\\d+)$`,
);
const UNITY_REPO_URL = new RegExp(
  `github\\.com[/:](?:${SDK_OWNER}|${LEGACY_OWNER})/grush-sdk-unity`,
);
export const JS_BANNER = /GameRush SDK for JavaScript v(\d+\.\d+\.\d+)/;
const DTS_HEADER = "// Types for the GameRush SDK for JavaScript.";
const JSDELIVR_URL = new RegExp(
  `(cdn\\.jsdelivr\\.net/gh/)(?:${SDK_OWNER}|${LEGACY_OWNER})/grush-sdk-js@v?(\\d+\\.\\d+\\.\\d+)/`,
  "g",
);
// 探さないフォルダ。依存・git・エンジンの生成物。"." で始まるフォルダ（.godot・.gamerush など）も見ない。
// Unity と Godot の書き出し・一時ファイル、JavaScript のビルドの出力（書き出し直せば SDK も入れ替わる）も見ない。
const SKIPPED_DIRS = new Set([
  "node_modules",
  "bower_components",
  "Library",
  "Temp",
  "Logs",
  "obj",
  "UserSettings",
  "MemoryCaptures",
  "Build",
  "Builds",
  "build",
  "dist",
]);
// 探す量の上限。ファイルとフォルダを合わせた数と深さで止める。
export const DEFAULT_MAX_ENTRIES = 50_000;
const MAX_DEPTH = 12;
const MAX_SCANNED_BYTES = 10 * 1024 * 1024;
// jsDelivr の URL を探す .js の大きさの上限。手で書いたスクリプトだけを読み、バンドルは読まない。
const MAX_CDN_SCRIPT_BYTES = 1024 * 1024;
// SDK のファイルとして入れ替えてよい名前。先頭に注記があっても、ほかの名前のファイル（バンドルなど）は入れ替えない。
const JS_SDK_NAMES = new Set(["grush-sdk.js", "grush-sdk.mjs", "grush-sdk.d.ts"]);
const BANNER_BYTES = 512;
const CDN_EXTENSIONS = new Set([".html", ".htm", ".js", ".mjs"]);

/**
 * @typedef {{
 *   mode: "git" | "local" | "embedded" | "other",
 *   version: string | null,
 *   value: string,
 *   url: string | null,
 * }} UnityInstall
 *   url は GameRush の SDK のリポジトリを指す git の値のとき、その値。
 *
 * @typedef {{ mode: "addon" | "link", version: string | null, hasBuildAddon: boolean }} GodotInstall
 *
 * @typedef {{ file: string, version: string | null, flavor: "iife" | "esm" | "dts" }} JsCopy
 * @typedef {{ file: string, versions: string[] }} CdnReference
 * @typedef {{ dir: string, version: string | null }} JsSubmodule
 * @typedef {{ copies: JsCopy[], cdn: CdnReference[], submodules: JsSubmodule[], truncated: boolean }} JsInstall
 *   truncated は上限で探すのをやめたとき true
 *
 * @typedef {{ root: string, unity: UnityInstall | null, godot: GodotInstall | null, js: JsInstall }} ProjectSdks
 */

/** @param {string} file */
function readTextOrNull(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** @param {string} file */
function isRealDirectory(file) {
  try {
    return fs.lstatSync(file).isDirectory();
  } catch {
    return false;
  }
}

/** @param {string} file */
function exists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * manifest.json の dependencies から cc.gamerush.sdk の値を読む。
 * @param {string} text
 * @returns {string | null}
 */
function unityDependency(text) {
  try {
    const value = JSON.parse(text)?.dependencies?.[UNITY_PACKAGE];
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

/** @param {string} root @returns {UnityInstall | null} */
function detectUnity(root) {
  const manifest = readTextOrNull(path.join(root, UNITY_MANIFEST));
  const value = manifest === null ? null : unityDependency(manifest);
  if (value !== null) {
    const git = UNITY_GIT_URL.exec(value);
    if (git) return { mode: "git", version: normalizeVersion(git[4]), value, url: value };
    if (value.startsWith("file:")) {
      const target = path.resolve(root, "Packages", value.slice("file:".length));
      return { mode: "local", version: packageVersionAt(target), value, url: null };
    }
    return { mode: "other", version: null, value, url: UNITY_REPO_URL.test(value) ? value : null };
  }
  // Packages/ の下に置いたパッケージ（embedded）は manifest に載らない。
  const embedded = path.join(root, "Packages", UNITY_PACKAGE);
  if (isRealDirectory(embedded)) {
    return { mode: "embedded", version: packageVersionAt(embedded), value: "", url: null };
  }
  return null;
}

/** @param {string} dir */
function packageVersionAt(dir) {
  const text = readTextOrNull(path.join(dir, "package.json"));
  if (text === null) return null;
  try {
    const json = JSON.parse(text);
    return json?.name === UNITY_PACKAGE && typeof json.version === "string"
      ? normalizeVersion(json.version)
      : null;
  } catch {
    return null;
  }
}

/** plugin.cfg の version を読む。 @param {string} text */
export function godotPluginVersion(text) {
  const match = /^\s*version\s*=\s*"([^"]*)"\s*$/m.exec(text);
  return match ? normalizeVersion(match[1]) : null;
}

/** @param {string} root @returns {GodotInstall | null} */
function detectGodot(root) {
  const addon = path.join(root, GODOT_ADDON);
  if (!exists(addon)) return null;
  const cfg = readTextOrNull(path.join(addon, "plugin.cfg"));
  if (cfg === null) return null;
  return {
    mode: isRealDirectory(addon) ? "addon" : "link",
    version: godotPluginVersion(cfg),
    hasBuildAddon: exists(path.join(root, GODOT_BUILD_ADDON)),
  };
}

/** @param {string} file */
function readHead(file) {
  const handle = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(BANNER_BYTES);
    const read = fs.readSync(handle, buffer, 0, BANNER_BYTES, 0);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    fs.closeSync(handle);
  }
}

/**
 * SDK のファイルの先頭の注記から版と種類を読む。SDK のファイルでなければ null。
 * SDK の名前（grush-sdk.js / .mjs / .d.ts）で、先頭に注記があるものだけ。バンドルは SDK だけを差し替えられないので、
 * 先頭が注記でも、名前が違えば SDK のファイルとしない。
 * @param {string} name ファイル名
 * @param {string} head ファイルの先頭
 * @param {() => string} readAll
 * @returns {{ version: string | null, flavor: JsCopy["flavor"] } | null}
 */
export function classifyJsFile(name, head, readAll) {
  if (!JS_SDK_NAMES.has(name)) return null;
  if (name.endsWith(".d.ts")) {
    return head.startsWith(DTS_HEADER) ? { version: null, flavor: "dts" } : null;
  }
  if (!head.startsWith("/*! GameRush SDK for JavaScript v")) return null;
  const version = JS_BANNER.exec(head)?.[1] ?? null;
  if (name.endsWith(".mjs")) return { version, flavor: "esm" };
  return { version, flavor: /^export\s*\{/m.test(readAll()) ? "esm" : "iife" };
}

/** jsDelivr の URL に書いた版を並べる。 @param {string} text */
export function jsdelivrVersions(text) {
  return [...text.matchAll(JSDELIVR_URL)].map((match) => match[2]);
}

/**
 * jsDelivr の URL の版を書き換える。shouldRewrite が false を返す版（最新より新しい版など）は残す。
 * @param {string} text @param {string} version @param {(current: string) => boolean} [shouldRewrite]
 */
export function rewriteJsdelivr(text, version, shouldRewrite = () => true) {
  return text.replace(JSDELIVR_URL, (match, prefix, current) =>
    shouldRewrite(current) ? `${prefix}${SDK_OWNER}/grush-sdk-js@v${version}/` : match,
  );
}

/** @param {string} dir */
function isJsSdkCheckout(dir) {
  if (!exists(path.join(dir, ".git"))) return false;
  const text = readTextOrNull(path.join(dir, "package.json"));
  if (text === null) return false;
  try {
    return JSON.parse(text)?.name === "grush-sdk-js";
  } catch {
    return false;
  }
}

/** @param {string} root @param {number} maxEntries @returns {JsInstall} */
function detectJs(root, maxEntries) {
  /** @type {JsInstall} */
  const result = { copies: [], cdn: [], submodules: [], truncated: false };
  let scanned = 0;
  /** @param {string} relative @param {number} depth */
  const visit = (relative, depth) => {
    if (depth > MAX_DEPTH) {
      result.truncated = true;
      return;
    }
    const absolute = path.join(root, relative);
    let entries;
    try {
      entries = fs.readdirSync(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (scanned >= maxEntries) {
        result.truncated = true;
        return;
      }
      scanned += 1;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      // シンボリックリンクはたどらない。プロジェクトの外を書き換えないため。
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || SKIPPED_DIRS.has(entry.name)) continue;
        if (isJsSdkCheckout(path.join(root, child))) {
          const banner = readTextOrNull(path.join(root, child, "grush-sdk.js"));
          result.submodules.push({
            dir: child,
            version: banner ? (JS_BANNER.exec(banner)?.[1] ?? null) : null,
          });
          continue;
        }
        visit(child, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name).toLowerCase();
      const isScript = extension === ".js" || extension === ".mjs" || entry.name.endsWith(".d.ts");
      if (!isScript && !CDN_EXTENSIONS.has(extension)) continue;
      const file = path.join(root, child);
      let size;
      try {
        size = fs.statSync(file).size;
      } catch {
        continue;
      }
      if (size > MAX_SCANNED_BYTES) continue;
      let text = null;
      const readAll = () => {
        text ??= fs.readFileSync(file, "utf8");
        return text;
      };
      if (isScript) {
        const copy = classifyJsFile(entry.name, readHead(file), readAll);
        if (copy) {
          result.copies.push({ file: child, ...copy });
          continue;
        }
      }
      const isHtml = extension === ".html" || extension === ".htm";
      if (CDN_EXTENSIONS.has(extension) && (isHtml || size <= MAX_CDN_SCRIPT_BYTES)) {
        const versions = jsdelivrVersions(readAll());
        if (versions.length > 0) result.cdn.push({ file: child, versions });
      }
    }
  };
  visit("", 0);
  // 型のファイルには版が無いので、同じフォルダの SDK の版を使う。
  for (const copy of result.copies) {
    if (copy.flavor !== "dts") continue;
    const sibling = result.copies.find(
      (other) =>
        other.flavor !== "dts" && path.posix.dirname(other.file) === path.posix.dirname(copy.file),
    );
    copy.version = sibling?.version ?? null;
  }
  return result;
}

/**
 * @param {string} projectDir
 * @param {{ js?: boolean, maxEntries?: number }} [options]
 *   js: false で JavaScript の SDK を探さない。maxEntries は探すファイルとフォルダの数の上限
 * @returns {ProjectSdks}
 */
export function detectProject(projectDir, options = {}) {
  const root = path.resolve(projectDir);
  return {
    root,
    unity: detectUnity(root),
    godot: detectGodot(root),
    js:
      options.js === false
        ? { copies: [], cdn: [], submodules: [], truncated: false }
        : detectJs(root, options.maxEntries ?? DEFAULT_MAX_ENTRIES),
  };
}

/** @param {JsInstall} js */
export function hasJs(js) {
  return js.copies.length > 0 || js.cdn.length > 0 || js.submodules.length > 0;
}

/**
 * プロジェクトの JavaScript の SDK の版。一番古いものを返す。
 * @param {JsInstall} js
 */
export function oldestJsVersion(js) {
  const versions = [
    ...js.copies.map((copy) => copy.version),
    ...js.cdn.flatMap((ref) => ref.versions),
    ...js.submodules.map((sub) => sub.version),
  ].filter((version) => version !== null);
  return versions.sort(compareVersions)[0] ?? null;
}

/**
 * manifest.json の cc.gamerush.sdk の値だけを書き換える。JSON を書き直すと字下げや改行が変わるので、文字列の中だけを置き換える。
 * 値が1か所に見つからなければ null。
 * @param {string} text
 * @param {string} version
 * @returns {string | null}
 */
export function rewriteUnityManifest(text, version) {
  const pattern = /("cc\.gamerush\.sdk"\s*:\s*")([^"\\]*)(")/g;
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) return null;
  const git = UNITY_GIT_URL.exec(matches[0][2]);
  if (!git) return null;
  const url = `${git[1]}${SDK_OWNER}${git[3]}#v${version}`;
  const result = text.replace(pattern, (_match, head, _value, tail) => `${head}${url}${tail}`);
  return unityDependency(result) === url ? result : null;
}

/** 表示用の SDK の名前。 @param {"js" | "unity" | "godot"} kind */
export function sdkLabel(kind) {
  return SDKS[kind].label;
}
