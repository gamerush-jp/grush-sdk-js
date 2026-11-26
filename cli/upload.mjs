import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ApiError, CliError, messageForCode, requestJson } from "./api.mjs";
import {
  BUILD_CANVAS_SIZE_PATH,
  BUILD_MANIFEST_PATH,
  MAX_BUILD_BYTES,
  isCompressedHtmlPath,
  isIgnoredZipEntry,
  isSourceMapPath,
  normalizeUploadPath,
  referencesRootAbsolutePath,
  stripSingleRootFolder,
  validateBuildFiles,
} from "./rules.mjs";
import { readZipEntries, ZipError } from "./zip.mjs";

/**
 * @typedef {{ path: string, size: number, read: () => Buffer }} SourceFile
 * @typedef {import("./api.mjs").FetchLike} FetchLike
 */

// presigned URL への PUT の決まり。Unity の Editor 拡張（GRushEditorPutPolicy）と同じ値。
export const PUT_POLICY = {
  baseSeconds: 30,
  minBytesPerSecond: 64 * 1024,
  maxSeconds: 900,
  attempts: 3,
  retryBaseSeconds: 2,
  retryMaxSeconds: 8,
};
// ビルドの presigned URL は一度きりの書き込みなので、412 は前の試行が届いていた印として成功に扱う。
const OBJECT_ALREADY_WRITTEN = 412;
const SIGNATURE_REJECTED = 403;
// ビルドの確定には時間がかかることがあるので、ほかの API より長く待つ。
const COMPLETE_TIMEOUT_MS = 180_000;
const UPLOAD_CONCURRENCY = 4;
// 作成と確定を同じ要求で送り直す回数。作成は冪等キー（operationId）を付けるので、送り直しても2つ目は作られない。
const REQUEST_ATTEMPTS = 3;
// 確定の途中でゲームの状態が変わったときの 409。同じビルドの確定をやり直せば通る。
const RETRYABLE_CONFLICT = "Game state changed during upload. Please retry.";
const NO_FILE_MANIFEST = "Build has no file manifest.";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @param {number} bytes */
export function putTimeoutSeconds(bytes) {
  const size = Math.max(bytes, 0);
  const transfer = Math.ceil(size / PUT_POLICY.minBytesPerSecond);
  const ceiling = PUT_POLICY.maxSeconds - PUT_POLICY.baseSeconds;
  return transfer >= ceiling ? PUT_POLICY.maxSeconds : PUT_POLICY.baseSeconds + transfer;
}

/** @param {number} failedAttempt */
export function retryDelaySeconds(failedAttempt) {
  const shift = Math.max(0, Math.min(failedAttempt - 1, 16));
  return Math.min(PUT_POLICY.retryMaxSeconds, PUT_POLICY.retryBaseSeconds * 2 ** shift);
}

/** @param {string} value */
export function isGameId(value) {
  return UUID_PATTERN.test(value);
}

/**
 * @param {string} root
 * @param {string} prefix
 * @param {SourceFile[]} files
 */
function walk(root, prefix, files) {
  const entries = fs.readdirSync(path.join(root, prefix), { withFileTypes: true });
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (isIgnoredZipEntry(relative)) continue;
    const absolute = path.join(root, relative);
    if (entry.isDirectory()) {
      walk(root, relative, files);
    } else if (entry.isFile()) {
      const { size } = fs.statSync(absolute);
      files.push({ path: relative, size, read: () => fs.readFileSync(absolute) });
    } else {
      // 黙って飛ばすと、リンク先を当てにしたビルドがファイルの欠けたまま上がる。
      throw new CliError(
        `通常のファイルでもフォルダでもないもの（シンボリックリンクなど）は上げられません: ${relative}`,
      );
    }
  }
}

/**
 * フォルダか zip から、上げるファイルを並べる。Studio と同じく、zip が1つのフォルダを包んでいればそのフォルダを
 * 剥がし、プレイヤーに要らないもの（ソースマップ・圧縮した HTML・基準解像度のファイル）は除いて知らせる。
 * @param {string} input
 * @returns {{ files: SourceFile[], skipped: string[] }}
 */
export function collectBuild(input) {
  let stats;
  try {
    stats = fs.statSync(input);
  } catch {
    throw new CliError(`ファイルかフォルダが見つかりません: ${input}`);
  }
  /** @type {SourceFile[]} */
  let files = [];
  if (stats.isDirectory()) {
    walk(input, "", files);
  } else if (stats.isFile() && input.toLowerCase().endsWith(".zip")) {
    // zip の外側の大きさで先に断る。展開後の合計は下の検査が見る。
    if (stats.size > MAX_BUILD_BYTES * 4) {
      throw new CliError(
        `zip が大きすぎます（ビルドの上限は ${MAX_BUILD_BYTES / 1024 / 1024}MB）。`,
      );
    }
    let entries;
    try {
      entries = readZipEntries(fs.readFileSync(input), { maxEntryBytes: MAX_BUILD_BYTES });
    } catch (error) {
      if (error instanceof ZipError) throw new CliError(error.message);
      throw error;
    }
    const kept = entries
      .map((entry) => ({ ...entry, path: normalizeUploadPath(entry.path) }))
      .filter((entry) => !isIgnoredZipEntry(entry.path));
    const stripped = stripSingleRootFolder(kept.map((entry) => entry.path));
    files = kept.map((entry, index) => ({ ...entry, path: stripped[index] }));
  } else {
    throw new CliError(`ビルドのフォルダか .zip を指定してください: ${input}`);
  }

  const skipped = [];
  const uploadable = [];
  for (const file of files) {
    if (
      isSourceMapPath(file.path) ||
      isCompressedHtmlPath(file.path) ||
      file.path === BUILD_CANVAS_SIZE_PATH
    ) {
      skipped.push(file.path);
    } else {
      uploadable.push(file);
    }
  }
  uploadable.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files: uploadable, skipped };
}

/**
 * @param {string} code
 * @param {Record<string, unknown>} [params]
 */
function ruleError(code, params) {
  return new CliError(`上げる前の検査に落ちました: ${messageForCode(code, params) ?? code}`);
}

/**
 * GameRush がビルドの作成で当てる規則を、上げる前に手元で当てる。
 * @param {SourceFile[]} files
 * @returns {{ totalBytes: number }}
 */
export function precheckBuild(files) {
  const validation = validateBuildFiles(
    files.map((file) => ({ path: file.path, size: file.size })),
  );
  if (!validation.ok) throw ruleError(validation.code, validation.params);

  const index = files.find((file) => file.path === "index.html");
  if (index && referencesRootAbsolutePath(index.read().toString("utf8"))) {
    throw ruleError("build.webAbsolutePath");
  }
  return { totalBytes: validation.totalBytes };
}

/** @param {number} bytes */
export function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

/**
 * 一時的な失敗（通信の失敗・503・同じ冪等キーの要求の処理中）だけを、同じ本文で送り直す。
 * @template T
 * @param {() => Promise<T>} run
 * @param {(ms: number) => Promise<void>} sleep
 * @param {(error: ApiError) => boolean} [retryable]
 * @returns {Promise<T>}
 */
async function withRetry(run, sleep, retryable = isTransient) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof ApiError) || !retryable(error) || attempt >= REQUEST_ATTEMPTS)
        throw error;
      await sleep(retryDelaySeconds(attempt) * 1000);
    }
  }
}

/** @param {ApiError} error */
function isTransient(error) {
  return error.status === null || error.status === 503 || error.code === "operation.inProgress";
}

/**
 * 確定の失敗のうち、同じビルドでは二度と確定できないもの（Editor 拡張の GRushEditorCompleteFailure と同じ）。
 * @param {ApiError} error
 */
function requiresNewBuild(error) {
  if (error.status === 409) return error.serverError !== RETRYABLE_CONFLICT;
  if (error.status === 422) return true;
  if (error.status === 400) return error.serverError === NO_FILE_MANIFEST;
  return false;
}

/** @param {unknown} response */
function leaderboardWarnings(response) {
  const failed = /** @type {any} */ (response)?.leaderboards?.failed;
  if (!Array.isArray(failed) || failed.length === 0) return [];
  const reasons = /** @type {Record<string, string>} */ ({
    "build.leaderboardManifestSemanticsLocked":
      "スコアが投稿済みなので、並び順・値の型・集約・期間は変えられません。新しい key で定義してください",
    "build.leaderboardManifestLimit": "1つのゲームのランキングの上限を超えます",
    "build.leaderboardManifestApplyFailed":
      "書き込みに失敗しました。もう一度アップロードしてください",
  });
  return [
    "ビルドは確定しましたが、grush.json のランキングの定義のうち次のものは書けませんでした。",
    ...failed.map((item) => {
      const code = typeof item?.code === "string" ? item.code : "";
      return `・${typeof item?.key === "string" ? item.key : "?"}: ${reasons[code] ?? code}`;
    }),
    "Studio のランキングで今の定義を確認してください。",
  ];
}

/**
 * @param {{
 *   fetch: FetchLike,
 *   ticket: { path: string, url: string, headers: Record<string, string> },
 *   file: SourceFile,
 *   sleep: (ms: number) => Promise<void>,
 * }} input
 */
async function putFile({ fetch, ticket, file, sleep }) {
  /** @type {Record<string, string>} */
  const headers = { ...ticket.headers };
  if (!Object.keys(headers).some((name) => name.toLowerCase() === "if-none-match")) {
    headers["If-None-Match"] = "*";
  }
  const body = file.read();
  for (let attempt = 1; attempt <= PUT_POLICY.attempts; attempt += 1) {
    let status = null;
    try {
      const response = await fetch(ticket.url, {
        method: "PUT",
        headers,
        body,
        signal: AbortSignal.timeout(putTimeoutSeconds(body.length) * 1000),
      });
      status = response.status;
      // presigned の応答は保存先の XML なので、本文は読まずに捨てる。
      await response.body?.cancel();
    } catch {
      status = null;
    }
    if (status !== null && ((status >= 200 && status < 300) || status === OBJECT_ALREADY_WRITTEN)) {
      return;
    }
    if (status === SIGNATURE_REJECTED) {
      throw new CliError(
        `${ticket.path}: アップロード用の URL が期限切れです（有効期限 1 時間）。もう一度 grush upload を実行すると新しいビルドで送り直します。途中のビルドは 24 時間後に自動で片付きます。`,
      );
    }
    if (attempt === PUT_POLICY.attempts) {
      throw new CliError(
        `${ticket.path}: 送信に失敗しました（${status === null ? "通信の失敗" : `HTTP ${status}`}）。`,
      );
    }
    await sleep(retryDelaySeconds(attempt) * 1000);
  }
}

/**
 * @template T
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T) => Promise<void>} run
 */
async function eachWithConcurrency(items, concurrency, run) {
  let next = 0;
  let failed = false;
  async function worker() {
    while (!failed && next < items.length) {
      const item = items[next];
      next += 1;
      try {
        await run(item);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
}

/**
 * @typedef {{
 *   fetch: FetchLike,
 *   origin: string,
 *   token: string,
 *   files: SourceFile[],
 *   target: { kind: "existing", gameId: string } | { kind: "new", title: string },
 *   log: (line: string) => void,
 *   sleep?: (ms: number) => Promise<void>,
 * }} UploadInput
 */

/**
 * ビルドを上げる。手順は Unity の Editor 拡張と同じで、ビルドの作成 → 全ファイルの PUT → 確定。
 * ランキングの定義（grush.json）はビルドに含めて上げ、確定のときに GameRush が反映する。
 * @param {UploadInput} input
 * @returns {Promise<{ gameId: string, buildId: string, studioUrl: string }>}
 */
export async function uploadBuild(input) {
  const { fetch, origin, token, files, log } = input;
  const sleep = input.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const client = { fetch, origin, token };

  let gameId;
  let createdGame = false;
  if (input.target.kind === "new") {
    const title = input.target.title;
    log(`ゲームを作成しています: ${title}`);
    const operationId = randomUUID();
    // visibility は private に固定する。公開・限定公開と説明・遊び方は Studio で決めてもらう。
    // 説明と遊び方は空で送り、サーバが空を「未記入」として保存する。
    const created = await withRetry(
      () =>
        requestJson(client, "POST", "/api/games", {
          title,
          description: "",
          howToPlay: "",
          visibility: "private",
          acceptTerms: true,
          confirmAssetRights: true,
          operationId,
        }),
      sleep,
    );
    gameId = typeof created.game?.id === "string" ? created.game.id : "";
    if (!gameId)
      throw new CliError(
        "ゲームの作成の応答を読めませんでした。Studio に作られていないか確認してください。",
      );
    createdGame = true;
    log(`ゲームを作成しました（private）: ${gameId}`);
  } else {
    gameId = input.target.gameId;
  }

  try {
    log("ビルドを作成しています…");
    const operationId = randomUUID();
    const created = await withRetry(
      () =>
        requestJson(client, "POST", `/api/games/${encodeURIComponent(gameId)}/builds`, {
          files: files.map((file) => ({ path: file.path, size: file.size })),
          operationId,
        }),
      sleep,
    );
    const buildId = typeof created.build?.id === "string" ? created.build.id : "";
    const tickets = Array.isArray(created.uploadUrls) ? created.uploadUrls : null;
    // 読むのは手元で並べたファイルだけにする。応答のパスをそのまま結ぶと、ビルドの外のファイルを送りうる。
    const byPath = new Map(files.map((file) => [file.path, file]));
    const alreadyReady =
      created.build?.status !== undefined && created.build.status !== "uploading";
    if (
      !buildId ||
      !tickets ||
      (!alreadyReady && tickets.length !== files.length) ||
      tickets.some(
        (/** @type {any} */ ticket) =>
          typeof ticket?.path !== "string" ||
          typeof ticket?.url !== "string" ||
          !byPath.has(ticket.path),
      )
    ) {
      throw new CliError(
        "アップロード先の応答を読めませんでした。Studio でビルドの状態を確認してください。",
      );
    }
    log(`ビルドを作成しました: ${buildId}`);

    let sent = 0;
    let sentBytes = 0;
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    await eachWithConcurrency(tickets, UPLOAD_CONCURRENCY, async (/** @type {any} */ ticket) => {
      const file = /** @type {SourceFile} */ (byPath.get(ticket.path));
      const headers =
        typeof ticket.headers === "object" && ticket.headers !== null ? ticket.headers : {};
      await putFile({
        fetch,
        ticket: { path: ticket.path, url: ticket.url, headers },
        file,
        sleep,
      });
      sent += 1;
      sentBytes += file.size;
      log(
        `  [${sent}/${tickets.length}] ${ticket.path}（${formatBytes(sentBytes)} / ${formatBytes(totalBytes)}）`,
      );
    });

    log("ビルドを確定しています…");
    let completed;
    try {
      completed = await withRetry(
        () =>
          requestJson(
            client,
            "POST",
            `/api/builds/${encodeURIComponent(buildId)}/complete`,
            {},
            {
              timeoutMs: COMPLETE_TIMEOUT_MS,
            },
          ),
        sleep,
        (error) =>
          isTransient(error) || (error.status === 409 && error.serverError === RETRYABLE_CONFLICT),
      );
    } catch (error) {
      if (error instanceof ApiError && requiresNewBuild(error)) {
        const where = typeof error.params.path === "string" ? `: ${error.params.path}` : "";
        const reason =
          error.code !== null ? error.message : (error.serverError ?? `HTTP ${error.status}`);
        throw new CliError(
          `このビルドはもう確定できません（${reason}${where}）。原因を直してから、もう一度 grush upload を実行すると新しいビルドで送り直します。`,
        );
      }
      throw new CliError(
        `ビルドの確定に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const line of leaderboardWarnings(completed)) log(line);

    // complete の entryUrl は play-token を持たず、private や審査待ちのゲームでは開けないので、Studio のページを返す。
    return { gameId, buildId, studioUrl: `${origin}/studio/games/${gameId}` };
  } catch (error) {
    if (createdGame && error instanceof Error) {
      // ゲームは作成済みなので、同じ題で作り直さずに既存のゲームへビルドを足してもらう。
      throw new CliError(
        `${error.message}\nゲームは作成済みです（${gameId}）。直してから --game ${gameId} で実行し直してください（--new は付けない）。`,
      );
    }
    throw error;
  }
}

export { BUILD_MANIFEST_PATH };
