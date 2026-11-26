import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import { CliError, requestJson } from "./api.mjs";

// RFC 8252 のループバック + PKCE（S256）で、ブラウザの承認からトークンを受け取る。Unity の Editor 拡張と同じ手順。

/** 承認を待つ秒数。認可コードの寿命（5分）と同じ。 */
export const LOGIN_TIMEOUT_MS = 300_000;

export const CLIENT_NAME = "GameRush CLI";

/** Unity の Editor 拡張がゲームの作成を求めるときと同じ権限。 */
export const LOGIN_SCOPES = [
  "games:read",
  "leaderboards:read",
  "leaderboards:write",
  "builds:write",
  "games:create",
];

/** @param {Buffer} bytes */
function base64Url(bytes) {
  return bytes.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/**
 * code_verifier は 43〜128 文字。32 バイトの base64url は 43 文字ちょうどで、使う文字も許容集合に収まる。
 */
export function createVerifier() {
  return base64Url(randomBytes(32));
}

/** @param {string} verifier */
export function codeChallenge(verifier) {
  return base64Url(createHash("sha256").update(verifier, "ascii").digest());
}

export function createState() {
  return base64Url(randomBytes(16));
}

/**
 * @param {string} origin
 * @param {{ redirectUri: string, challenge: string, state: string, clientName: string, scopes: string[] }} params
 */
export function authorizeUrl(origin, params) {
  const query = new URLSearchParams({
    redirect_uri: params.redirectUri,
    code_challenge: params.challenge,
    code_challenge_method: "S256",
    client_name: params.clientName,
    scopes: params.scopes.join(","),
    state: params.state,
  });
  return `${origin}/studio/authorize?${query.toString()}`;
}

/** @param {string} message */
function page(message) {
  const escaped = message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html><meta charset="utf-8"><title>GameRush</title><body style="font-family:sans-serif;padding:40px"><p>${escaped}</p></body>`;
}

/**
 * @param {http.ServerResponse} response
 * @param {number} status
 * @param {string} message
 */
function respond(response, status, message) {
  const body = Buffer.from(page(message), "utf8");
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
    Connection: "close",
  });
  response.end(body);
}

/**
 * @param {http.Server} server
 * @param {string} host
 * @returns {Promise<boolean>}
 */
function listen(server, host) {
  return new Promise((resolve) => {
    const onError = () => {
      server.off("listening", onListening);
      resolve(false);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(true);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    // ポートは OS に選ばせる。選んでから離す形と違い、選び直しの隙間に他所へ取られることが無い。
    server.listen(0, host);
  });
}

/**
 * RFC 8252 が勧める 127.0.0.1 を先に試し、開けないときだけ localhost へ落ちる。サーバはどちらの表記も受け付ける。
 * redirect_uri はクエリもフラグメントも付けられないので、末尾スラッシュ無しの http://<host>:<port> を
 * そのまま交換にも使う。
 * @param {http.RequestListener} handler
 * @returns {Promise<{ server: http.Server, redirectUri: string }>}
 */
async function startLoopback(handler) {
  for (const host of ["127.0.0.1", "localhost"]) {
    const server = http.createServer(handler);
    if (await listen(server, host)) {
      const address = server.address();
      if (address && typeof address === "object") {
        return { server, redirectUri: `http://${host}:${address.port}` };
      }
      server.close();
    }
  }
  throw new CliError("手元の待ち受け（http://127.0.0.1）を開けませんでした。");
}

/**
 * @typedef {import("./api.mjs").FetchLike} FetchLike
 * @typedef {import("./credentials.mjs").Credentials} Credentials
 */

/**
 * ブラウザで承認してもらい、トークンを受け取る。保存は呼び出し側が行う。
 * @param {{
 *   origin: string,
 *   fetch: FetchLike,
 *   openBrowser: (url: string) => void | Promise<void>,
 *   log: (line: string) => void,
 *   timeoutMs?: number,
 *   clientName?: string,
 *   scopes?: string[],
 * }} options
 * @returns {Promise<Credentials>}
 */
export async function login(options) {
  const clientName = options.clientName ?? CLIENT_NAME;
  const scopes = options.scopes ?? LOGIN_SCOPES;
  const verifier = createVerifier();
  const state = createState();

  /** @type {(code: string) => void} */
  let resolveCode = () => {};
  /** @type {(error: Error) => void} */
  let rejectCode = () => {};
  const received = new Promise((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // 承認を待ち始める前（ブラウザを開いている間）に応答が来て失敗しても、未処理の拒否にしない。
  received.catch(() => {});
  let settled = false;

  const { server, redirectUri } = await startLoopback((request, response) => {
    const query = new URL(request.url ?? "/", "http://127.0.0.1").searchParams;
    const code = query.get("code");
    const error = query.get("error");
    if (settled || (code === null && error === null)) {
      respond(response, 404, "この待ち受けは GameRush の承認専用です。");
      return;
    }
    if (query.get("state") !== state) {
      // state を知らないのは、手元のポートを探り当てたほかのページかもしれない。断って捨て、本物の応答を待ち続ける
      // （ここで止めると、どのページでも作者のログインを中断させられる）。
      respond(response, 400, "要求元が一致しません。この応答は使いません。");
      options.log(
        "state の一致しない応答を受けたので無視しました。ブラウザでの承認を待っています…",
      );
      return;
    }
    settled = true;
    if (error !== null || code === null) {
      respond(response, 400, "承認されませんでした。ターミナルへ戻ってください。");
      rejectCode(new CliError(`承認されませんでした（${error ?? "不明"}）。`));
      return;
    }
    respond(
      response,
      200,
      "GameRush への接続が完了しました。このタブを閉じてターミナルへ戻ってください。",
    );
    resolveCode(code);
  });

  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  try {
    const url = authorizeUrl(options.origin, {
      redirectUri,
      challenge: codeChallenge(verifier),
      state,
      clientName,
      scopes,
    });
    options.log(
      "ブラウザで GameRush の承認画面を開きます。開かないときは、次の URL を開いてください。",
    );
    options.log(url);
    try {
      await options.openBrowser(url);
    } catch {
      // URL は表示済みなので、手で開いてもらえば続けられる。
    }
    options.log("ブラウザで承認を待っています…（5 分で時間切れになります）");

    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        settled = true;
        reject(new CliError("承認を待つ時間が切れました。もう一度 grush login してください。"));
      }, options.timeoutMs ?? LOGIN_TIMEOUT_MS);
    });
    const code = /** @type {string} */ (await Promise.race([received, timeout]));
    clearTimeout(timer);
    // 応答を書き終える前に切らないよう、ここでは待ち受けを閉じるだけにする。
    closeServer(server, false);

    options.log("トークンを受け取っています…");
    let exchanged;
    try {
      exchanged = await requestJson(
        { fetch: options.fetch, origin: options.origin, token: null },
        "POST",
        "/api/api-token-authorizations/exchange",
        { code, codeVerifier: verifier, redirectUri },
      );
    } catch (error) {
      const status = /** @type {{ status?: number }} */ (error).status;
      if (status === 409) {
        throw new CliError(
          "有効な API トークンが上限に達しています。Studio の API トークンから使っていないものを失効させてから、もう一度 grush login してください。",
        );
      }
      throw new CliError(
        `トークンの受け取りに失敗しました: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const token =
      typeof exchanged.token === "object" && exchanged.token !== null ? exchanged.token : {};
    if (typeof exchanged.secret !== "string" || exchanged.secret === "") {
      throw new CliError("トークンの応答を読めませんでした。");
    }
    return {
      origin: options.origin,
      token: exchanged.secret,
      preview: typeof token.preview === "string" ? token.preview : "",
      clientName: typeof token.clientName === "string" ? token.clientName : clientName,
      expiresAt: typeof token.expiresAt === "string" ? token.expiresAt : "",
      scopes: Array.isArray(token.scopes)
        ? token.scopes.filter((/** @type {unknown} */ s) => typeof s === "string")
        : [],
      gameIds: Array.isArray(token.gameIds)
        ? token.gameIds.filter((/** @type {unknown} */ s) => typeof s === "string")
        : null,
    };
  } finally {
    clearTimeout(timer);
    closeServer(server, true);
  }
}

/**
 * @param {http.Server} server
 * @param {boolean} force 開いたままの接続（ブラウザの keep-alive）も切る
 */
function closeServer(server, force) {
  if (server.listening) server.close();
  if (force) server.closeAllConnections();
  else server.closeIdleConnections();
}
