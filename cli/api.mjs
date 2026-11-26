// GameRush の API の呼び出しと、エラーを作者向けの日本語にする部分。

export const PRODUCTION_ORIGIN = "https://gamerush.jp";
// 以前の本番の接続先。いまは PRODUCTION_ORIGIN へ転送されるだけで、同じ API のトークンが使える。
const LEGACY_PRODUCTION_ORIGIN = "https://gamerush.cc";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** 作者へそのまま出す日本語の message を持つ例外。 */
export class CliError extends Error {}

/**
 * 接続先を正規化する。https か、手元の開発サーバ（ループバックの http）だけを受ける。
 * トークンを平文の http で外へ送らないため。
 * @param {string} value
 * @returns {string}
 */
export function canonicalOrigin(value) {
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new CliError(`接続先の URL を読めません: ${value}`);
  }
  const loopbackHttp = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !loopbackHttp) {
    throw new CliError(`接続先は https の URL にしてください: ${value}`);
  }
  const origin = url.origin;
  return origin === LEGACY_PRODUCTION_ORIGIN ? PRODUCTION_ORIGIN : origin;
}

// API のエラーの code から作者向けの文言。GameRush の画面の文言に合わせる。
/** @type {Record<string, string>} */
const CODE_MESSAGES = {
  "build.emptyPath": "空のパスが含まれています。",
  "build.invalidSeparator": "不正な区切り文字を含むパスです。",
  "build.unsafeSegment": "不正なパス（../ など）が含まれています。",
  "build.unsupportedExtension": "対応していない拡張子です: {path}",
  "build.noFiles": "ビルドにファイルが含まれていません。",
  "build.tooManyFiles": "ファイル数が多すぎます（上限 {limit} 個）。",
  "build.duplicatePath": "パスが重複しています: {path}",
  "build.invalidSize": "サイズが不正です: {path}",
  "build.conflictingEntry":
    "index.html と __grush-player.json は同時に含められません。どちらか一方にしてください。",
  "build.missingEntry":
    "ビルドのエントリが見つかりません。一番上に index.html（または __grush-player.json）がある状態で指定してください。",
  "build.tooLarge": "ビルドが上限（{maxMb}MB）を超えています。",
  "build.htmlTooLarge": "HTML ファイルが大きすぎます（1ファイル 5MB まで）: {path}",
  "build.webAbsolutePath":
    'index.html がルート絶対パス（/assets/... など）でアセットを参照しています。相対パスで書き出してください（Vite なら vite.config の base を "./" にします）。',
  "build.blockedExecutable": "実行ファイルは含められません: {path}",
  "build.contentTypeMismatch": "ファイルの内容が拡張子と一致しません: {path}",
  "build.blockedHtml":
    "この HTML は公開できません（パスワード入力や外部への自動転送を含んでいます）: {path}",
  "build.compressedHtml": "HTML は圧縮せずにそのまま含めてください: {path}",
  "build.leaderboardManifestTooLarge": "{path} が大きすぎます（{maxKb}KB まで）。",
  "build.leaderboardManifestInvalidJson": "{path} を JSON のオブジェクトとして読めません。",
  "build.leaderboardManifestUnknownField": "grush.json に知らない項目があります: {field}",
  "build.leaderboardManifestInvalidField": "grush.json の値が正しくありません: {field}",
  "build.leaderboardManifestTooMany": "grush.json のランキングは {limit} 個までです。",
  "build.leaderboardManifestDuplicateKey": "grush.json でランキングのキーが重複しています: {key}",
  "build.leaderboardManifestCompressed": "{path} は圧縮せずにそのまま含めてください。",
  "build.leaderboardManifestSemanticsLocked":
    "スコアが投稿済みのランキング「{key}」の並び順・値の型・集約・期間は変えられません。新しいキーで定義してください。",
  "build.leaderboardManifestLimit":
    "grush.json の定義を足すと、1つのゲームのランキングの上限（{limit} 個）を超えます。",
  "post.banned": "このアカウントは運営により利用を停止されているため、投稿できません。",
  "title.required": "タイトルを入力してください。",
  "title.tooManyHashtags": "ハッシュタグはタイトルと説明を合わせて {max} 個までです。",
  "terms.agreeRequired": "ゲームを作るには利用規約への同意が必要です。",
  "rights.confirmRequired":
    "サーバが素材の権利の確認を受け付けませんでした。grush を最新版に更新してから、もう一度お試しください。",
  "ageRating.declarationRequired":
    "ゲームを公開または限定公開にするときは、全年齢向けの内容であることの申告が必要です。",
  "operation.inProgress": "前の送信をまだ処理しています。少し待ってから、もう一度お試しください。",
  "operation.bodyMismatch":
    "前の送信と内容が違うため、送れませんでした。最初からやり直してください。",
  "operation.gone":
    "前の送信で作られたものは削除されています。もう一度実行すると、新しく作ります。",
};

/**
 * @param {string} code
 * @param {Record<string, unknown>} [params]
 * @returns {string | null}
 */
export function messageForCode(code, params = {}) {
  const template = CODE_MESSAGES[code];
  if (!template) return null;
  return template.replace(/\{(\w+)\}/g, (_, key) =>
    params[key] === undefined ? `{${key}}` : String(params[key]),
  );
}

/** API が成功でない応答を返したときの例外。 */
export class ApiError extends CliError {
  /**
   * @param {string} message
   * @param {{ status: number | null, code: string | null, serverError: string | null, params: Record<string, unknown>, details: unknown }} info
   */
  constructor(message, info) {
    super(message);
    this.status = info.status;
    this.code = info.code;
    this.serverError = info.serverError;
    this.params = info.params;
    this.details = info.details;
  }
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {number | null} status
 * @param {unknown} body
 */
function describeFailure(status, body) {
  const record = isRecord(body) ? body : {};
  const code = typeof record.code === "string" ? record.code : null;
  const params = isRecord(record.params) ? record.params : {};
  const serverError = typeof record.error === "string" ? record.error : null;
  if (status === null)
    return { text: "GameRush に接続できませんでした。", code, params, serverError };
  if (code) {
    const mapped = messageForCode(code, params);
    if (mapped) return { text: mapped, code, params, serverError };
  }
  if (status === 401) {
    return {
      text: "トークンが無効か、失効しています。`grush login` でログインし直してください。",
      code,
      params,
      serverError,
    };
  }
  if (status === 403) {
    return {
      text: `この操作の権限がありません（${serverError ?? code ?? "403"}）。必要な権限で \`grush login\` し直してください。`,
      code,
      params,
      serverError,
    };
  }
  if (status === 404) {
    return {
      text: `見つかりません（${serverError ?? "404"}）。ゲーム ID と、トークンの対象のゲームを確かめてください。`,
      code,
      params,
      serverError,
    };
  }
  if (status === 503) {
    return {
      text: "GameRush が一時的に処理できません。少し待ってからもう一度お試しください。",
      code,
      params,
      serverError,
    };
  }
  const detail = [serverError, code].filter(Boolean).join(" / ");
  return { text: `HTTP ${status}${detail ? `: ${detail}` : ""}`, code, params, serverError };
}

/**
 * @typedef {(input: string, init?: RequestInit) => Promise<Response>} FetchLike
 */

/**
 * GameRush の JSON API を呼ぶ。エラー文に載せるのは status とサーバの error・code だけで、
 * 要求の本文とヘッダ（トークン）は載せない。
 * @param {{ fetch: FetchLike, origin: string, token: string | null }} client
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<any>}
 */
export async function requestJson(client, method, path, body, options = {}) {
  /** @type {Record<string, string>} */
  const headers = { Accept: "application/json" };
  if (client.token) headers.Authorization = `Bearer ${client.token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await client.fetch(`${client.origin}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
    });
  } catch {
    const failure = describeFailure(null, null);
    throw new ApiError(failure.text, {
      status: null,
      code: null,
      serverError: null,
      params: {},
      details: null,
    });
  }
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  if (!response.ok) {
    const failure = describeFailure(response.status, json);
    throw new ApiError(failure.text, {
      status: response.status,
      code: failure.code,
      serverError: failure.serverError,
      params: failure.params,
      details: isRecord(json) ? json.details : null,
    });
  }
  if (!isRecord(json)) {
    throw new ApiError("GameRush の応答を読めませんでした。", {
      status: response.status,
      code: null,
      serverError: null,
      params: {},
      details: null,
    });
  }
  return json;
}
