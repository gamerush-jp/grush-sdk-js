import { JS_BANNER, detectProject, oldestJsVersion, sdkLabel } from "./project.mjs";
import { cachedLatestVersion, cliCommand, compareVersions } from "./releases.mjs";

// grush と、使っている SDK が最新のリリースより古ければ、1 行のお知らせを返す。コマンドは止めない。
// 調べられないとき（オフライン・回数制限・応答の形が違う）は何も返さない。

/**
 * @typedef {import("./releases.mjs").SdkKind} SdkKind
 * @typedef {import("./releases.mjs").FetchLike} FetchLike
 * @typedef {import("./credentials.mjs").CredentialsHost} CredentialsHost
 *
 * @typedef {{ kind: "project", dir: string } | { kind: "build", files: { path: string, size: number, read: () => Buffer }[] } | { kind: "none" }} CheckSubject
 */

const MAX_BUILD_SCRIPT_BYTES = 20 * 1024 * 1024;
const CHECK_MAX_ENTRIES = 5000;

/**
 * ビルドの JavaScript から SDK の版を読む。バンドラは /*! の注記を残すので、ファイルの途中にあっても読む。
 * Unity と Godot の書き出しには SDK の版が入らないので、見ない。
 * @param {{ path: string, size: number, read: () => Buffer }[]} files
 * @returns {string | null}
 */
export function jsVersionInBuild(files) {
  for (const file of files) {
    if (!/\.(m?js)$/i.test(file.path) || file.size > MAX_BUILD_SCRIPT_BYTES) continue;
    const match = JS_BANNER.exec(file.read().toString("utf8"));
    if (match) return match[1];
  }
  return null;
}

/**
 * @param {{
 *   fetch: FetchLike,
 *   host: CredentialsHost,
 *   now: Date,
 *   cliVersion: string,
 *   command: string,
 *   subject: CheckSubject,
 * }} options
 * @returns {Promise<string[]>}
 */
export async function outdatedWarnings({ fetch, host, now, cliVersion, command, subject }) {
  /** @type {(kind: SdkKind) => Promise<string | null>} */
  const latestOf = (kind) => cachedLatestVersion({ fetch, host, kind, now });
  const lines = [];
  const latestCli = await latestOf("js");
  const grush = latestCli ? cliCommand(latestCli) : "grush";
  if (latestCli && compareVersions(cliVersion, latestCli) < 0) {
    lines.push(
      `お知らせ: grush の新しい版 v${latestCli} があります（いま v${cliVersion}）。${grush} ${command} で新しい版を使えます。`,
    );
  }

  if (subject.kind === "build") {
    const version = jsVersionInBuild(subject.files);
    if (version && latestCli && compareVersions(version, latestCli) < 0) {
      lines.push(
        `お知らせ: このビルドの ${sdkLabel("js")} は v${version} で、最新は v${latestCli} です。ゲームのプロジェクトで ${grush} update を実行してから、ビルドし直してください。`,
      );
    }
  }

  if (subject.kind === "project") {
    // コマンドの裏で走るので、探す量を絞る。
    const sdks = detectProject(subject.dir, { maxEntries: CHECK_MAX_ENTRIES });
    /** @type {[SdkKind, string | null][]} */
    const found = [
      ["unity", sdks.unity?.version ?? null],
      ["godot", sdks.godot?.version ?? null],
      ["js", oldestJsVersion(sdks.js)],
    ];
    const target =
      subject.dir === "."
        ? ""
        : ` ${/\s/.test(subject.dir) ? JSON.stringify(subject.dir) : subject.dir}`;
    for (const [kind, version] of found) {
      if (!version) continue;
      const latest = kind === "js" ? latestCli : await latestOf(kind);
      if (latest && compareVersions(version, latest) < 0) {
        lines.push(
          `お知らせ: このプロジェクトの ${sdkLabel(kind)} は v${version} で、最新は v${latest} です。${grush} update${target} で上げられます。`,
        );
      }
    }
  }
  return lines;
}
