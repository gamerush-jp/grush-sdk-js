import fs from "node:fs";
import path from "node:path";
import { CliError } from "./api.mjs";
import { credentialsDirectory } from "./credentials.mjs";

// GameRush の SDK の公開リポジトリと、その最新のリリース。版の比較・GitHub の API・調べた結果の控え（24 時間）を持つ。

/** @typedef {"js" | "unity" | "godot"} SdkKind */
/** @typedef {import("./api.mjs").FetchLike} FetchLike */
/** @typedef {import("./credentials.mjs").CredentialsHost} CredentialsHost */

export const SDK_OWNER = "gamerush-jp";
/** @type {Record<SdkKind, { repo: string, label: string }>} */
export const SDKS = {
  js: { repo: "grush-sdk-js", label: "GameRush SDK for JavaScript" },
  unity: { repo: "grush-sdk-unity", label: "GameRush SDK for Unity" },
  godot: { repo: "grush-sdk-godot", label: "GameRush SDK for Godot" },
};

export const VERSION_CHECK_FILE_NAME = "version-check.json";
export const VERSION_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
// 調べられなかったときも控える。オフラインでコマンドのたびに待たせないため。短めにして、つながれば早く知らせる。
const FAILED_CHECK_TTL_MS = 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 3000;
const API_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
// リリースのソースの zip の上限。SDK のリポジトリはどれも数 MB なので、桁違いに大きいものは受けない。
export const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)$/;

/** "v1.2.3" と "1.2.3" を受け、"1.2.3" を返す。形が違えば null。 @param {string} value */
export function normalizeVersion(value) {
  const match = VERSION_PATTERN.exec(value.trim());
  return match ? `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}` : null;
}

/** a が b より古ければ負、同じなら 0、新しければ正。 @param {string} a @param {string} b */
export function compareVersions(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * GitHub の公開リポジトリを読む。認証なしの API は 1 時間に 60 回までなので、GITHUB_TOKEN があれば使う。
 * 公開リポジトリは認証なしでも読めるので、トークンが断られたら（期限切れ・別のサービスのトークンなど）付けずに読み直す。
 * @param {FetchLike} fetch
 * @param {Record<string, string | undefined>} env
 * @param {string} url
 * @param {number} timeoutMs
 */
async function githubGet(fetch, env, url, timeoutMs) {
  /** @param {boolean} withToken */
  const request = (withToken) =>
    fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "grush-cli",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(withToken ? { Authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  if (!env.GITHUB_TOKEN) return request(false);
  const response = await request(true);
  return response.status === 401 ? request(false) : response;
}

/**
 * GitHub の Releases API で最新のリリースの版を読む。
 * @param {{ fetch: FetchLike, env: Record<string, string | undefined>, kind: SdkKind, timeoutMs?: number }} options
 * @returns {Promise<string>} "1.2.3"
 */
export async function fetchLatestVersion({ fetch, env, kind, timeoutMs = API_TIMEOUT_MS }) {
  const url = `https://api.github.com/repos/${SDK_OWNER}/${SDKS[kind].repo}/releases/latest`;
  let response;
  try {
    response = await githubGet(fetch, env, url, timeoutMs);
  } catch (error) {
    throw new CliError(
      `${SDKS[kind].label} の最新のリリースを調べられませんでした: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new CliError(
      `${SDKS[kind].label} の最新のリリースを調べられませんでした（HTTP ${response.status}）。${response.status === 403 || response.status === 429 ? "GitHub の回数制限なら、時間を置くか環境変数 GITHUB_TOKEN を設定してください。" : ""}`,
    );
  }
  /** @type {any} */
  let body;
  try {
    body = await response.json();
  } catch {
    throw new CliError(`${SDKS[kind].label} の最新のリリースの応答を読めません。`);
  }
  const version = typeof body?.tag_name === "string" ? normalizeVersion(body.tag_name) : null;
  if (!version) {
    throw new CliError(`${SDKS[kind].label} の最新のリリースの版を読めません: ${body?.tag_name}`);
  }
  return version;
}

/**
 * リリースのタグのソースを zip で取る。
 * @param {{ fetch: FetchLike, env: Record<string, string | undefined>, kind: SdkKind, version: string }} options
 * @returns {Promise<Buffer>}
 */
export async function downloadSourceZip({ fetch, env, kind, version }) {
  const url = `https://api.github.com/repos/${SDK_OWNER}/${SDKS[kind].repo}/zipball/refs/tags/v${version}`;
  let response;
  try {
    response = await githubGet(fetch, env, url, DOWNLOAD_TIMEOUT_MS);
  } catch (error) {
    throw new CliError(
      `${SDKS[kind].label} v${version} を取得できませんでした: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new CliError(
      `${SDKS[kind].label} v${version} を取得できませんでした（HTTP ${response.status}）。${response.status === 404 ? "その版のリリースがあるか確かめてください。" : ""}`,
    );
  }
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_ARCHIVE_BYTES)
    throw new CliError(`${SDKS[kind].label} v${version} の zip が大きすぎます。`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_ARCHIVE_BYTES) {
    throw new CliError(`${SDKS[kind].label} v${version} の zip が大きすぎます。`);
  }
  return buffer;
}

/** @param {CredentialsHost} host */
export function versionCheckPath(host) {
  const join = host.platform === "win32" ? path.win32.join : path.posix.join;
  return join(credentialsDirectory(host), VERSION_CHECK_FILE_NAME);
}

/** @param {CredentialsHost} host @returns {Record<string, { latest: string | null, checkedAt: string }>} */
function readCache(host) {
  try {
    const json = JSON.parse(fs.readFileSync(versionCheckPath(host), "utf8"));
    return typeof json === "object" && json !== null && !Array.isArray(json) ? json : {};
  } catch {
    return {};
  }
}

/** @param {CredentialsHost} host @param {Record<string, unknown>} cache */
function writeCache(host, cache) {
  try {
    fs.mkdirSync(credentialsDirectory(host), { recursive: true, mode: 0o700 });
    fs.writeFileSync(versionCheckPath(host), `${JSON.stringify(cache, null, 2)}\n`);
  } catch {
    // 控えを書けなくても、次に調べ直すだけ。
  }
}

/**
 * 控えを使って最新の版を返す。調べられなければ null（お知らせを出さないだけなので、理由は出さない）。
 * @param {{ fetch: FetchLike, host: CredentialsHost, kind: SdkKind, now: Date }} options
 * @returns {Promise<string | null>}
 */
export async function cachedLatestVersion({ fetch, host, kind, now }) {
  const cache = readCache(host);
  const entry = cache[kind];
  if (entry && typeof entry === "object" && typeof entry.checkedAt === "string") {
    const age = now.getTime() - Date.parse(entry.checkedAt);
    const latest = typeof entry.latest === "string" ? normalizeVersion(entry.latest) : null;
    const ttl = latest ? VERSION_CHECK_TTL_MS : FAILED_CHECK_TTL_MS;
    // 時計が戻って控えが未来の日時になったときは、調べ直す。
    if (Number.isFinite(age) && age >= 0 && age < ttl) return latest;
  }
  let latest = null;
  try {
    latest = await fetchLatestVersion({ fetch, env: host.env, kind, timeoutMs: CHECK_TIMEOUT_MS });
  } catch {
    latest = null;
  }
  recordLatestVersion(host, kind, latest, now);
  return latest;
}

/**
 * grush update が調べた最新の版を控えに入れる。
 * @param {CredentialsHost} host @param {SdkKind} kind @param {string | null} latest @param {Date} now
 */
export function recordLatestVersion(host, kind, latest, now) {
  const cache = readCache(host);
  cache[kind] = { latest, checkedAt: now.toISOString() };
  writeCache(host, cache);
}

/** @param {Record<string, string | undefined>} env */
export function updateCheckDisabled(env) {
  const value = env.GRUSH_NO_UPDATE_CHECK;
  return value !== undefined && value !== "" && value !== "0";
}

/** 新しい版の grush を使うコマンド。npx は github: の指定をタグで固定できる。 @param {string} version */
export function cliCommand(version) {
  return `npx -p github:${SDK_OWNER}/${SDKS.js.repo}#v${version} grush`;
}
