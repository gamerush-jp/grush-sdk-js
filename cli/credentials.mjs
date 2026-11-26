import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// トークンはプロジェクトの外（ユーザーのプロファイルの下）に置く。場所は Unity の Editor 拡張と同じフォルダで、
// ファイルは CLI 用に分ける（片方のログアウトがもう片方のトークンを消さないように）。JSON の形は Editor 拡張と同じ。

export const CREDENTIALS_FILE_NAME = "cli-token.json";

/**
 * @typedef {{
 *   origin: string,
 *   token: string,
 *   preview: string,
 *   clientName: string,
 *   expiresAt: string,
 *   scopes: string[],
 *   gameIds: string[] | null,
 * }} Credentials
 *
 * @typedef {{
 *   env: Record<string, string | undefined>,
 *   platform: string,
 *   homedir: string,
 * }} CredentialsHost
 */

/** @returns {CredentialsHost} */
export function defaultHost() {
  return { env: process.env, platform: process.platform, homedir: os.homedir() };
}

/** @param {CredentialsHost} host */
export function credentialsDirectory(host) {
  if (host.platform === "win32") {
    const appData = host.env.APPDATA || path.win32.join(host.homedir, "AppData", "Roaming");
    return path.win32.join(appData, "GameRush");
  }
  if (host.platform === "darwin") {
    return path.posix.join(host.homedir, "Library", "Application Support", "GameRush");
  }
  const configHome = host.env.XDG_CONFIG_HOME || path.posix.join(host.homedir, ".config");
  return path.posix.join(configHome, "gamerush");
}

/** @param {CredentialsHost} host */
export function credentialsPath(host) {
  const join = host.platform === "win32" ? path.win32.join : path.posix.join;
  return join(credentialsDirectory(host), CREDENTIALS_FILE_NAME);
}

/** @param {unknown} value */
function stringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

/**
 * @param {CredentialsHost} host
 * @returns {Credentials | null}
 */
export function loadCredentials(host) {
  let text;
  try {
    text = fs.readFileSync(credentialsPath(host), "utf8");
  } catch {
    return null;
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) return null;
  if (typeof json.token !== "string" || json.token === "") return null;
  return {
    origin: typeof json.origin === "string" ? json.origin : "",
    token: json.token,
    preview: typeof json.preview === "string" ? json.preview : "",
    clientName: typeof json.clientName === "string" ? json.clientName : "",
    expiresAt: typeof json.expiresAt === "string" ? json.expiresAt : "",
    scopes: stringArray(json.scopes) ?? [],
    gameIds: stringArray(json.gameIds),
  };
}

/**
 * 期限を読めないときは切れていないものとして扱う（Editor 拡張と同じ）。サーバが 401 を返せばそこで分かる。
 * @param {Credentials} credentials
 * @param {Date} [now]
 */
export function isExpired(credentials, now = new Date()) {
  const expires = Date.parse(credentials.expiresAt);
  return Number.isFinite(expires) && expires <= now.getTime();
}

/** 本人以外の読み書きの権限が残っていれば true。 */
function hasGroupOrOtherBits(/** @type {string} */ target) {
  return (fs.statSync(target).mode & 0o077) !== 0;
}

/**
 * 権限を絞れなければ保存しない。一時ファイルを絞れないと分かったときは消して例外を投げる — 誰でも読める場所に
 * 平文の bearer トークンを置いたまま「保存できた」と返すのが一番まずい。
 * 一時ファイルを 0600 で新しく作って書き、確かめてから置き換えるので、既にある広い権限のファイルへ
 * トークンを書き込む瞬間も作らない。
 * @param {CredentialsHost} host
 * @param {Credentials} credentials
 */
export function saveCredentials(host, credentials) {
  const directory = credentialsDirectory(host);
  const target = credentialsPath(host);
  const posix = host.platform !== "win32";
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (posix) {
    try {
      fs.chmodSync(directory, 0o700);
    } catch {
      // 下で確かめる。
    }
    if (hasGroupOrOtherBits(directory)) {
      throw new Error(
        `トークンの保存先（${directory}）を本人だけが読める状態にできませんでした。トークンは保存していません。`,
      );
    }
  }
  // Windows では %APPDATA% がユーザーのプロファイルの下にあり、既定で本人（と SYSTEM・管理者）にしか読めない。
  // Node は Windows の ACL を扱えないので、そのフォルダの既定の権限に任せる。

  const temporary = `${target}.${process.pid}.tmp`;
  const body = `${JSON.stringify(serialize(credentials))}\n`;
  let createdTemporary = false;
  try {
    fs.writeFileSync(temporary, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
    createdTemporary = true;
    if (posix) {
      fs.chmodSync(temporary, 0o600);
      if (hasGroupOrOtherBits(temporary)) throw new Error("permission");
    }
    // rename は権限ごと置き換えるので、確かめた 0600 のまま保存先になる。失敗しても保存先の前のファイルは残る。
    fs.renameSync(temporary, target);
  } catch (error) {
    // 片付けるのは自分で作った一時ファイルだけ。前にログインして保存したトークンは、使えるまま残す。
    if (createdTemporary && fs.existsSync(temporary) && !tryDelete(temporary)) {
      throw new Error(
        `権限を絞れなかったトークンを消せませんでした。${temporary} を手で消し、Studio でこのトークンを失効させてください。`,
      );
    }
    if (error instanceof Error && error.message === "permission") {
      throw new Error(
        `トークンの保存先（${target}）を本人だけが読める状態にできませんでした。トークンは保存していません。`,
      );
    }
    throw new Error(
      `トークンを保存できませんでした（${target}）: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** @param {Credentials} credentials */
function serialize(credentials) {
  return {
    origin: credentials.origin,
    token: credentials.token,
    preview: credentials.preview,
    clientName: credentials.clientName,
    expiresAt: credentials.expiresAt,
    scopes: credentials.scopes,
    gameIds: credentials.gameIds,
  };
}

/** @param {string} file */
function tryDelete(file) {
  try {
    fs.rmSync(file, { force: true });
    return !fs.existsSync(file);
  } catch {
    return false;
  }
}

/**
 * 保存したトークンのファイルを消す。消したときは true、もともと無ければ false。
 * @param {CredentialsHost} host
 */
export function clearCredentials(host) {
  const target = credentialsPath(host);
  if (!fs.existsSync(target)) return false;
  fs.rmSync(target, { force: true });
  return true;
}
