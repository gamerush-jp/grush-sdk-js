// アップロードの前の手元の検査と、zip の読み方。写しの元は3つある。
// - ファイルの一覧の検査（validateBuildFiles）: GameRush がビルドの作成（POST /api/games/:id/builds）で当てる規則
// - HTML の大きさ: ビルドの確定（complete）の中身の検査が当てる上限
// - zip の包みのフォルダの剥がし方・除くファイル・index.html のルート絶対パス: Studio がビルドを受けるときの扱い
// 上げ切ってから断られることと、Studio で上がるビルドが CLI では違う形で上がることを避けるために持つ。
// 境界はサーバの検査にあり、ここで通っても断られることはある。
// 写しを変えるときは GameRush の規則に合わせる（GameRush 側のテストが写しの一致を照合する）。

/** ビルドの合計の上限（バイト）。 */
export const MAX_BUILD_BYTES = 100 * 1024 * 1024;
/** ビルドのファイル数の上限。 */
export const MAX_BUILD_FILE_COUNT = 2000;
/** HTML 1ファイルの上限（バイト）。サーバは中身を読める大きさまでしか受けない。 */
export const MAX_HTML_SCAN_BYTES = 5 * 1024 * 1024;
/** ロード設定のファイル名。index.html の代わりの入口になる。 */
export const GENERATED_PLAYER_CONFIG_PATH = "__grush-player.json";
export const GENERATED_PLAYER_CONFIG_MAX_BYTES = 64 * 1024;
/** 基準解像度のファイル名。Studio だけが書くので、作者の同名のファイルは送らない。 */
export const BUILD_CANVAS_SIZE_PATH = "__grush-canvas.json";
export const BUILD_CANVAS_SIZE_MAX_BYTES = 1024;
/** ランキングの定義を書く、ビルドの最上位の設定ファイル。 */
export const BUILD_MANIFEST_PATH = "grush.json";
export const BUILD_MANIFEST_MAX_BYTES = 64 * 1024;

/** 上げられる拡張子（小文字）。後ろに .br / .gz が付いた名前は、その前の拡張子で決まる。 */
export const BUILD_EXTENSIONS = new Set([
  "html",
  "js",
  "wasm",
  "data",
  "json",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "bmp",
  "css",
  "unityweb",
  "pck",
  "ico",
  "svg",
  "webp",
  "mp3",
  "m4a",
  "aac",
  "ogg",
  "wav",
  "mp4",
  "txt",
  "csv",
  "xml",
  "yml",
  "yaml",
  "ttf",
  "woff",
  "woff2",
  "webmanifest",
  "bytes",
  "bundle",
  "assetbundle",
  "bin",
  "dat",
  "bank",
  "ress",
  "resource",
  "fnt",
  "atlas",
  "skel",
  "glsl",
  "frag",
  "vert",
  "tmx",
  "tsx",
  "tmj",
  "tsj",
  "otf",
  "webm",
  "ktx",
  "pvr",
  "ktx2",
  "basis",
  "glb",
  "ldtk",
]);

export const COMPRESSED_EXTENSIONS = new Set(["br", "gz"]);

const COMPRESSED_SUFFIX = /\.(gz|br)$/i;
const SOURCE_MAP_SUFFIXES = [".js.map", ".css.map"];
const ROOT_ABSOLUTE_REFERENCE = /[\s"'](?:src|href)\s*=\s*["']?\/(?!\/)[^\s"'>]/i;

/**
 * @typedef {{ path: string, size: number }} BuildFile
 * @typedef {{ code: string, params?: Record<string, unknown> }} RuleError
 */

/** @param {string} path */
export function normalizeUploadPath(path) {
  return path.replaceAll("\\", "/").replace(/^\/+/, "").trim();
}

/**
 * Studio と同じく、macOS と Windows が勝手に作るファイルを除く。
 * @param {string} path
 */
export function isIgnoredZipEntry(path) {
  const normalized = normalizeUploadPath(path);
  const parts = normalized.split("/");
  const name = parts.at(-1) ?? "";
  return (
    normalized === "" ||
    normalized.startsWith("__MACOSX/") ||
    parts.includes("__MACOSX") ||
    name === ".DS_Store" ||
    name === "Thumbs.db"
  );
}

/** @param {string} path */
export function isSourceMapPath(path) {
  const lower = path.toLowerCase();
  return SOURCE_MAP_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/** @param {string} path */
export function isHtmlBuildPath(path) {
  const name = path.split("/").at(-1)?.toLowerCase() ?? "";
  return name.replace(COMPRESSED_SUFFIX, "").endsWith(".html");
}

/** @param {string} path */
export function isCompressedHtmlPath(path) {
  return isHtmlBuildPath(path) && COMPRESSED_SUFFIX.test(path);
}

/** @param {string} html */
export function referencesRootAbsolutePath(html) {
  return ROOT_ABSOLUTE_REFERENCE.test(html);
}

/** @param {string} path */
export function extensionForPath(path) {
  const name = normalizeUploadPath(path).split("/").at(-1)?.toLowerCase();
  if (!name?.includes(".")) return null;
  const parts = name.split(".");
  let extension = parts.pop();
  if (extension && COMPRESSED_EXTENSIONS.has(extension)) {
    extension = parts.pop();
  }
  return extension ?? null;
}

/**
 * @param {string} path
 * @returns {RuleError | null}
 */
export function validateBuildPath(path) {
  const normalized = normalizeUploadPath(path);
  if (!normalized) return { code: "build.emptyPath" };
  if (normalized.startsWith("/") || normalized.includes("\\")) {
    return { code: "build.invalidSeparator" };
  }
  if (normalized.split("/").some((part) => part === "" || part === "." || part === "..")) {
    return { code: "build.unsafeSegment", params: { path: normalized } };
  }
  const extension = extensionForPath(normalized);
  if (!extension || !BUILD_EXTENSIONS.has(extension)) {
    return { code: "build.unsupportedExtension", params: { path: normalized } };
  }
  return null;
}

/**
 * ビルドの作成でサーバが当てるファイルの一覧の検査。CLI は encoding を付けずに手元のバイトをそのまま送るので、
 * encoding に関わる分岐は持たない。
 * @param {BuildFile[]} files
 * @returns {{ ok: true, totalBytes: number } | ({ ok: false } & RuleError)}
 */
export function validateBuildFiles(files) {
  if (files.length === 0) return { ok: false, code: "build.noFiles" };
  const counted = files.filter((file) => normalizeUploadPath(file.path) !== BUILD_CANVAS_SIZE_PATH);
  if (counted.length > MAX_BUILD_FILE_COUNT) {
    return { ok: false, code: "build.tooManyFiles", params: { limit: MAX_BUILD_FILE_COUNT } };
  }

  let totalBytes = 0;
  const seen = new Set();
  let hasIndexHtml = false;
  let hasGeneratedConfig = false;

  for (const file of files) {
    const normalized = normalizeUploadPath(file.path);
    if (seen.has(normalized)) {
      return { ok: false, code: "build.duplicatePath", params: { path: normalized } };
    }
    seen.add(normalized);

    if (!Number.isSafeInteger(file.size) || file.size < 0) {
      return { ok: false, code: "build.invalidSize", params: { path: normalized } };
    }

    const pathError = validateBuildPath(normalized);
    if (pathError) return { ok: false, ...pathError };

    if (normalized === "index.html") hasIndexHtml = true;
    if (normalized === GENERATED_PLAYER_CONFIG_PATH) {
      if (file.size > GENERATED_PLAYER_CONFIG_MAX_BYTES) {
        return { ok: false, code: "build.invalidSize", params: { path: normalized } };
      }
      hasGeneratedConfig = true;
    }
    if (normalized === BUILD_CANVAS_SIZE_PATH && file.size > BUILD_CANVAS_SIZE_MAX_BYTES) {
      return { ok: false, code: "build.invalidSize", params: { path: normalized } };
    }
    if (normalized === BUILD_MANIFEST_PATH && file.size > BUILD_MANIFEST_MAX_BYTES) {
      return {
        ok: false,
        code: "build.leaderboardManifestTooLarge",
        params: { path: normalized, maxKb: BUILD_MANIFEST_MAX_BYTES / 1024 },
      };
    }
    if (isCompressedHtmlPath(normalized)) {
      return { ok: false, code: "build.compressedHtml", params: { path: normalized } };
    }
    if (isHtmlBuildPath(normalized) && file.size > MAX_HTML_SCAN_BYTES) {
      return { ok: false, code: "build.htmlTooLarge", params: { path: normalized } };
    }
    totalBytes += file.size;
  }

  if (hasGeneratedConfig && hasIndexHtml) {
    return { ok: false, code: "build.conflictingEntry" };
  }
  if (!hasGeneratedConfig && !hasIndexHtml) {
    return { ok: false, code: "build.missingEntry", params: { entryPath: "index.html" } };
  }
  if (totalBytes > MAX_BUILD_BYTES) {
    return {
      ok: false,
      code: "build.tooLarge",
      params: { maxMb: MAX_BUILD_BYTES / (1024 * 1024) },
    };
  }
  return { ok: true, totalBytes };
}

/**
 * Unity のビルドの4役割（loader・framework・wasm・data）がそろっているか。Studio の判別と同じ数え方。
 * @param {string} path
 * @returns {"loader" | "framework" | "wasm" | "data" | "symbols" | null}
 */
function unityRoleForPath(path) {
  const lower = normalizeUploadPath(path).toLowerCase();
  if (lower.split("/").slice(0, -1).includes("streamingassets")) return null;
  /** @param {string} base */
  const matches = (base) =>
    lower.endsWith(base) ||
    lower.endsWith(`${base}.gz`) ||
    lower.endsWith(`${base}.br`) ||
    lower.endsWith(`${base}.unityweb`);
  if (lower.endsWith(".loader.js")) return "loader";
  if (matches(".symbols.json")) return "symbols";
  if (matches(".framework.js")) return "framework";
  if (matches(".wasm")) return "wasm";
  if (matches(".data")) return "data";
  return null;
}

/** @param {string[]} paths */
function collectUnityRoles(paths) {
  /** @type {Map<string, string[]>} */
  const byRole = new Map();
  for (const path of paths) {
    const role = unityRoleForPath(path);
    if (!role) continue;
    byRole.set(role, [...(byRole.get(role) ?? []), path]);
  }
  return byRole;
}

/**
 * @param {string[]} paths
 * @returns {boolean}
 */
export function isModernUnityBuild(paths) {
  let byRole = collectUnityRoles(paths);
  const loaders = byRole.get("loader") ?? [];
  if (loaders.length === 0) return false;
  if (loaders.length === 1) {
    const ambiguous = ["framework", "wasm", "data", "symbols"].some(
      (role) => (byRole.get(role) ?? []).length > 1,
    );
    if (ambiguous) {
      const normalized = normalizeUploadPath(loaders[0]);
      const slash = normalized.lastIndexOf("/");
      const directory = slash === -1 ? "" : normalized.slice(0, slash);
      const base = normalized.slice(slash + 1).slice(0, -".loader.js".length);
      const prefix = directory === "" ? `${base}.` : `${directory}/${base}.`;
      byRole = collectUnityRoles(
        paths.filter((path) => normalizeUploadPath(path).startsWith(prefix)),
      );
    }
  }
  for (const role of ["loader", "framework", "wasm", "data"]) {
    if ((byRole.get(role) ?? []).length !== 1) return false;
  }
  return (byRole.get("symbols") ?? []).length <= 1;
}

/**
 * 最上位に同じ名前の .pck・.wasm・.js（.gz / .br を除いた名前）がそろう Godot の書き出しか。Studio の判別と同じく、
 * 使えない名前の一式も Godot として数える。
 * @param {string[]} paths
 * @returns {boolean}
 */
export function isGodotBuild(paths) {
  /** @type {Set<string>} */
  const logical = new Set();
  for (const path of paths) {
    const normalized = normalizeUploadPath(path);
    logical.add(
      normalized.endsWith(".gz") || normalized.endsWith(".br")
        ? normalized.slice(0, -3)
        : normalized,
    );
  }
  for (const name of logical) {
    if (!name.endsWith(".pck") || name.includes("/")) continue;
    const executable = name.slice(0, -".pck".length);
    if (executable && logical.has(`${executable}.wasm`) && logical.has(`${executable}.js`))
      return true;
  }
  return false;
}

/**
 * zip の中身の全部が1つのフォルダに入っているときの、Studio と同じ剥がし方。一番上に index.html があれば剥がさず、
 * 剥がすと index.html が一番上に来るときと、剥がすと Godot の書き出しになるとき（剥がす前が Unity のビルドでなければ）
 * だけ剥がす。
 * @param {string[]} paths
 * @returns {string[]}
 */
export function stripSingleRootFolder(paths) {
  if (paths.includes("index.html")) return paths;
  const roots = new Set(paths.map((path) => path.split("/")[0]).filter(Boolean));
  if (roots.size !== 1) return paths;
  const [root] = Array.from(roots);
  const prefix = `${root}/`;
  const stripped = paths.map((path) =>
    path.startsWith(prefix) ? path.slice(prefix.length) : path,
  );
  if (stripped.includes("index.html")) return stripped;
  if (isModernUnityBuild(paths)) return paths;
  return isGodotBuild(stripped) ? stripped : paths;
}
