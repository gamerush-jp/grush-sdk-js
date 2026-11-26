import fs from "node:fs";
import { createInterface } from "node:readline/promises";
import { installAgentDocs } from "./agents.mjs";
import { CliError, PRODUCTION_ORIGIN, canonicalOrigin } from "./api.mjs";
import {
  clearCredentials,
  credentialsPath,
  defaultHost,
  isExpired,
  loadCredentials,
  saveCredentials,
} from "./credentials.mjs";
import { login } from "./login.mjs";
import { openBrowser as defaultOpenBrowser } from "./open-browser.mjs";
import { BUILD_MANIFEST_PATH } from "./rules.mjs";
import { updateCheckDisabled } from "./releases.mjs";
import { updateProject } from "./update.mjs";
import { collectBuild, formatBytes, isGameId, precheckBuild, uploadBuild } from "./upload.mjs";
import { outdatedWarnings } from "./version-check.mjs";

const API_TOKEN_PATTERN = /^grush_pat_[A-Za-z0-9_-]{43}$/;
const API_TOKEN_PREFIX = "grush_pat_";

/**
 * @typedef {import("./api.mjs").FetchLike} FetchLike
 * @typedef {import("./credentials.mjs").CredentialsHost} CredentialsHost
 *
 * @typedef {{
 *   fetch: FetchLike,
 *   host: CredentialsHost,
 *   out: (line: string) => void,
 *   err: (line: string) => void,
 *   openBrowser: (url: string) => void | Promise<void>,
 *   confirm: (question: string) => Promise<boolean>,
 *   isInteractive: boolean,
 *   loginTimeoutMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => Date,
 *   releaseFetch?: FetchLike,
 * }} CliDeps
 *   releaseFetch は GitHub のリリースを読む fetch。無ければ版のお知らせを出さず、grush update も使えない。
 *
 * @typedef {(subject: import("./version-check.mjs").CheckSubject) => void} CheckUpdates
 *   版のお知らせを調べ始める。結果はコマンドの後に stderr へ出す。
 */

export function packageVersion() {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  return String(pkg.version);
}

const HELP = `GameRush CLI（grush）

使い方:
  grush login [--origin URL]        ブラウザで承認して、トークンを保存する
  grush logout                      保存したトークンを消す
  grush whoami                      使うトークンの接続先・権限・期限を表示する（status も同じ）
  grush upload <フォルダ|zip> --game <ゲーム ID> [--origin URL]
                                    既存のゲームへビルドを上げる
  grush upload <フォルダ|zip> --new <タイトル> [--yes] [--origin URL]
                                    ゲームを private で作ってからビルドを上げる
  grush agents [プロジェクトのフォルダ]
                                    AI エージェント向けの GameRush の文書を .gamerush/ に入れ、
                                    AGENTS.md（と、あれば CLAUDE.md）から指す（既定は今のフォルダ）
  grush update [プロジェクトのフォルダ] [--yes] [--to vX.Y.Z] [--dry-run]
                                    プロジェクトの GameRush SDK（Unity・Godot・JavaScript）を
                                    最新のリリース（か --to の版）へ上げる（既定は今のフォルダ）
  grush help                        この説明
  grush --version                   版を表示する

環境変数:
  GRUSH_TOKEN    保存したトークンの代わりに使う API トークン（grush_pat_…）。CI 向け
  GRUSH_ORIGIN   接続先（既定 ${PRODUCTION_ORIGIN}）
  GRUSH_NO_UPDATE_CHECK=1
                 grush と SDK の版のお知らせを出さない
  GITHUB_TOKEN   GitHub のリリースを読むときに使うトークン（回数制限を避けるとき）
`;

/**
 * @param {string[]} args
 * @param {Record<string, "value" | "flag">} spec
 */
function parseArgs(args, spec) {
  /** @type {Record<string, string | boolean>} */
  const options = {};
  /** @type {string[]} */
  const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
    const kind = spec[name];
    if (!kind) throw new CliError(`知らないオプションです: --${name}（grush help を参照）`);
    if (kind === "flag") {
      options[name] = true;
      continue;
    }
    const value = inline ?? args[index + 1];
    if (value === undefined || (inline === undefined && value.startsWith("--"))) {
      throw new CliError(`--${name} に値を指定してください。`);
    }
    if (inline === undefined) index += 1;
    options[name] = value;
  }
  return { options, positionals };
}

/**
 * 接続先は --origin、GRUSH_ORIGIN、保存したトークンの接続先、本番の順に決める。
 * @param {string | boolean | undefined} flag
 * @param {CredentialsHost} host
 * @param {string | null} saved
 */
function resolveOrigin(flag, host, saved) {
  if (typeof flag === "string") return canonicalOrigin(flag);
  const env = host.env.GRUSH_ORIGIN;
  if (env) return canonicalOrigin(env);
  if (saved) return canonicalOrigin(saved);
  return PRODUCTION_ORIGIN;
}

/** @param {string} token */
function previewOf(token) {
  return token.startsWith(API_TOKEN_PREFIX)
    ? token.slice(API_TOKEN_PREFIX.length, API_TOKEN_PREFIX.length + 6)
    : "";
}

/**
 * 使うトークンを決める。GRUSH_TOKEN があればそれを使い、権限と期限は分からないので手元では見ない。
 * @param {CliDeps} deps
 * @param {string | boolean | undefined} originFlag
 * @returns {{ origin: string, token: string, scopes: string[] | null, source: "env" | "saved" }}
 */
function resolveAuth(deps, originFlag) {
  const envToken = deps.host.env.GRUSH_TOKEN;
  if (envToken) {
    if (!API_TOKEN_PATTERN.test(envToken)) {
      throw new CliError(
        "GRUSH_TOKEN が API トークン（grush_pat_ で始まる値）の形ではありません。",
      );
    }
    return {
      origin: resolveOrigin(originFlag, deps.host, null),
      token: envToken,
      scopes: null,
      source: "env",
    };
  }
  const saved = loadCredentials(deps.host);
  if (!saved) throw new CliError("ログインしていません。先に grush login を実行してください。");
  const savedOrigin = canonicalOrigin(saved.origin || PRODUCTION_ORIGIN);
  const origin = resolveOrigin(originFlag, deps.host, savedOrigin);
  // トークンは接続先ごとに別物なので、食い違えばログインし直してもらう。
  if (origin !== savedOrigin) {
    throw new CliError(
      `保存したトークンは ${savedOrigin} 用です。${origin} へ上げるには grush login --origin ${origin} を実行してください。`,
    );
  }
  if (isExpired(saved, deps.now?.())) {
    throw new CliError(
      `保存したトークンは期限が切れています（${saved.expiresAt}）。grush login でログインし直してください。`,
    );
  }
  return { origin, token: saved.token, scopes: saved.scopes, source: "saved" };
}

/** @param {string[]} args @param {CliDeps} deps */
async function commandLogin(args, deps) {
  const { options } = parseArgs(args, { origin: "value" });
  const origin = resolveOrigin(options.origin, deps.host, null);
  const credentials = await login({
    origin,
    fetch: deps.fetch,
    openBrowser: deps.openBrowser,
    log: deps.out,
    timeoutMs: deps.loginTimeoutMs,
  });
  try {
    saveCredentials(deps.host, credentials);
  } catch (error) {
    throw new CliError(
      `${error instanceof Error ? error.message : String(error)} Studio の API トークンから、このトークン（${credentials.preview}…）を失効させてください。`,
    );
  }
  deps.out(`ログインしました（${origin}）。トークンの期限: ${credentials.expiresAt || "不明"}`);
  deps.out(`保存先: ${credentialsPath(deps.host)}`);
  if (deps.host.env.GRUSH_TOKEN) {
    deps.out(
      "注意: 環境変数 GRUSH_TOKEN があるあいだは、保存したトークンより GRUSH_TOKEN が使われます。",
    );
  }
  return 0;
}

/** @param {string[]} args @param {CliDeps} deps */
async function commandLogout(args, deps) {
  parseArgs(args, {});
  const saved = loadCredentials(deps.host);
  const removed = clearCredentials(deps.host);
  if (!removed) {
    deps.out("保存したトークンはありません。");
    return 0;
  }
  deps.out("保存したトークンを消しました。");
  // API トークンでトークンを失効させる口は無い（失効はセッションでだけ受け付ける）ので、手元から消すだけにする。
  const origin = saved?.origin ? canonicalOrigin(saved.origin) : PRODUCTION_ORIGIN;
  deps.out(
    `トークン${saved?.preview ? `（${saved.preview}…）` : ""}は期限までは有効です。もう使わないなら、Studio（${origin}/studio）の API トークンから失効させてください。`,
  );
  return 0;
}

/** @param {string[]} args @param {CliDeps} deps @param {CheckUpdates} checkUpdates */
async function commandWhoami(args, deps, checkUpdates) {
  const { options } = parseArgs(args, { origin: "value" });
  checkUpdates({ kind: "none" });
  const envToken = deps.host.env.GRUSH_TOKEN;
  if (envToken) {
    deps.out("環境変数 GRUSH_TOKEN のトークンを使います。");
    deps.out(`接続先:   ${resolveOrigin(options.origin, deps.host, null)}`);
    deps.out(`トークン: ${previewOf(envToken) || "（形が API トークンではありません）"}…`);
    deps.out("権限と期限は Studio の API トークンで確かめてください。");
    return 0;
  }
  const saved = loadCredentials(deps.host);
  if (!saved) {
    deps.out("ログインしていません。grush login を実行してください。");
    return 1;
  }
  const expired = isExpired(saved, deps.now?.());
  deps.out(`接続先:   ${canonicalOrigin(saved.origin || PRODUCTION_ORIGIN)}`);
  deps.out(`トークン: ${saved.preview}…（${saved.clientName || "名前なし"}）`);
  deps.out(`権限:     ${saved.scopes.join(", ") || "なし"}`);
  if (saved.gameIds) deps.out(`対象:     ${saved.gameIds.join(", ")}`);
  deps.out(
    `期限:     ${saved.expiresAt || "不明"}${expired ? "（切れています。grush login でログインし直してください）" : ""}`,
  );
  deps.out(`保存先:   ${credentialsPath(deps.host)}`);
  return expired ? 1 : 0;
}

/** @param {string[]} args @param {CliDeps} deps @param {CheckUpdates} checkUpdates */
async function commandUpload(args, deps, checkUpdates) {
  const { options, positionals } = parseArgs(args, {
    game: "value",
    new: "value",
    origin: "value",
    yes: "flag",
  });
  if (positionals.length !== 1) {
    throw new CliError(
      "上げるビルドのフォルダか .zip を1つ指定してください（grush help を参照）。",
    );
  }
  const hasGame = typeof options.game === "string";
  const hasNew = typeof options.new === "string";
  if (hasGame === hasNew)
    throw new CliError("--game <ゲーム ID> か --new <タイトル> のどちらか一方を指定してください。");
  if (hasGame && !isGameId(String(options.game))) {
    throw new CliError(
      `ゲーム ID の形ではありません: ${options.game}（Studio のゲームの URL の末尾の ID です）`,
    );
  }
  const title = hasNew ? String(options.new).trim() : "";
  if (hasNew && title === "") throw new CliError("--new にゲームのタイトルを指定してください。");

  const auth = resolveAuth(deps, options.origin);

  const { files, skipped } = collectBuild(positionals[0]);
  checkUpdates({ kind: "build", files });
  if (skipped.length > 0) {
    deps.out(`プレイに要らないファイルを除きます（Studio と同じ）: ${skipped.join(", ")}`);
  }
  const { totalBytes } = precheckBuild(files);
  deps.out(`検査を通過しました: ${files.length} ファイル / ${formatBytes(totalBytes)}`);

  if (auth.scopes) {
    const missing = [
      "builds:write",
      ...(files.some((file) => file.path === BUILD_MANIFEST_PATH) ? ["leaderboards:write"] : []),
      ...(hasNew ? ["games:create"] : []),
    ].filter((scope) => !auth.scopes?.includes(scope));
    if (missing.length > 0) {
      throw new CliError(
        `保存したトークンに権限（${missing.join(", ")}）がありません。grush login でログインし直してください。`,
      );
    }
  }

  if (hasNew && !options.yes) {
    const question =
      `ゲーム「${title}」を private で作成します。GameRush の利用規約（${auth.origin}/terms）に同意し、` +
      "ゲームに含まれる素材（画像・音・フォントなど）を使う権利があることを確認しますか？ [y/N] ";
    if (!deps.isInteractive) {
      throw new CliError(
        "--new でゲームを作るには、利用規約への同意と素材の権利の確認が要ります。確認した上で --yes を付けて実行してください。",
      );
    }
    if (!(await deps.confirm(question))) {
      deps.out("作成をやめました。");
      return 1;
    }
  }

  const result = await uploadBuild({
    fetch: deps.fetch,
    origin: auth.origin,
    token: auth.token,
    files,
    target: hasNew ? { kind: "new", title } : { kind: "existing", gameId: String(options.game) },
    log: deps.out,
    sleep: deps.sleep,
  });
  deps.out("");
  deps.out("アップロードが終わりました。");
  deps.out(`ゲーム ID: ${result.gameId}`);
  deps.out(`ビルド ID: ${result.buildId}`);
  deps.out(`Studio:    ${result.studioUrl}`);
  deps.out("試遊と公開の設定・申請は、上の Studio のゲームのページで行ってください。");
  return 0;
}

/** @param {string[]} args @param {CliDeps} deps @param {CheckUpdates} checkUpdates */
async function commandAgents(args, deps, checkUpdates) {
  const { positionals } = parseArgs(args, {});
  if (positionals.length > 1) {
    throw new CliError("プロジェクトのフォルダは1つだけ指定してください（grush help を参照）。");
  }
  const projectDir = positionals[0] ?? ".";
  if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
    throw new CliError(`プロジェクトのフォルダがありません: ${projectDir}`);
  }
  checkUpdates({ kind: "project", dir: projectDir });
  let result;
  try {
    result = installAgentDocs({ projectDir, stamp: `grush-sdk-js ${packageVersion()}` });
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error));
  }
  deps.out(
    `AI エージェント向けの文書を入れました: ${result.dir}（${result.files.length} ファイル）`,
  );
  const label = {
    created: "作りました",
    updated: "GameRush の段を足しました",
    unchanged: "変更なし",
  };
  for (const pointer of result.pointers) {
    if (pointer.status === "skipped") continue;
    deps.out(`${pointer.file}: ${label[pointer.status]}`);
  }
  deps.out(
    "SDK を上げたら、もう一度 grush agents を実行してください（grush update は .gamerush/ も入れ直します）。",
  );
  return 0;
}

/** @param {string[]} args @param {CliDeps} deps @param {CheckUpdates} checkUpdates */
async function commandUpdate(args, deps, checkUpdates) {
  const { options, positionals } = parseArgs(args, { yes: "flag", to: "value", "dry-run": "flag" });
  if (positionals.length > 1) {
    throw new CliError("プロジェクトのフォルダは1つだけ指定してください（grush help を参照）。");
  }
  if (!deps.releaseFetch) throw new CliError("この環境では GitHub のリリースを読めません。");
  checkUpdates({ kind: "none" });
  return updateProject({
    projectDir: positionals[0] ?? ".",
    to: typeof options.to === "string" ? options.to : undefined,
    yes: options.yes === true,
    dryRun: options["dry-run"] === true,
    deps: {
      fetch: deps.releaseFetch,
      host: deps.host,
      out: deps.out,
      err: deps.err,
      confirm: deps.confirm,
      isInteractive: deps.isInteractive,
      now: () => deps.now?.() ?? new Date(),
    },
  });
}

/**
 * 版のお知らせを、コマンドと並んで調べる。お知らせは補助なので、どんな失敗もコマンドに響かせない。
 * @param {CliDeps} deps
 * @param {string} command
 * @returns {{ checkUpdates: CheckUpdates, flush: () => Promise<void> }}
 */
function updateChecker(deps, command) {
  /** @type {Promise<string[]>[]} */
  const pending = [];
  const { releaseFetch } = deps;
  const enabled = releaseFetch !== undefined && deps.host && !updateCheckDisabled(deps.host.env);
  return {
    checkUpdates: (subject) => {
      if (!enabled || !releaseFetch) return;
      pending.push(
        (async () =>
          outdatedWarnings({
            fetch: releaseFetch,
            host: deps.host,
            now: deps.now?.() ?? new Date(),
            cliVersion: packageVersion(),
            command,
            subject,
          }))().catch(() => []),
      );
    },
    flush: async () => {
      for (const lines of await Promise.all(pending)) for (const line of lines) deps.err(line);
    },
  };
}

/**
 * @param {string[]} argv コマンド名より後ろの引数
 * @param {CliDeps} deps
 * @returns {Promise<number>} 終了コード
 */
export async function run(argv, deps) {
  const [command, ...rest] = argv;
  const { checkUpdates, flush } = updateChecker(deps, command ?? "");
  try {
    switch (command) {
      case undefined:
      case "help":
      case "--help":
      case "-h":
        deps.out(HELP);
        return command === undefined ? 1 : 0;
      case "--version":
      case "-v":
      case "version":
        deps.out(packageVersion());
        return 0;
      case "login":
        return await commandLogin(rest, deps);
      case "logout":
        return await commandLogout(rest, deps);
      case "whoami":
      case "status":
        return await commandWhoami(rest, deps, checkUpdates);
      case "upload":
        return await commandUpload(rest, deps, checkUpdates);
      case "agents":
        return await commandAgents(rest, deps, checkUpdates);
      case "update":
        return await commandUpdate(rest, deps, checkUpdates);
      default:
        deps.err(`知らないコマンドです: ${command}`);
        deps.out(HELP);
        return 1;
    }
  } catch (error) {
    if (error instanceof CliError) {
      deps.err(`エラー: ${error.message}`);
      return 1;
    }
    throw error;
  } finally {
    await flush();
  }
}

/** @returns {CliDeps} */
export function defaultDeps() {
  return {
    fetch: (input, init) => fetch(input, init),
    host: defaultHost(),
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    openBrowser: defaultOpenBrowser,
    releaseFetch: (input, init) => fetch(input, init),
    isInteractive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    confirm: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await rl.question(question);
        return /^y(es)?$/i.test(answer.trim());
      } finally {
        rl.close();
      }
    },
  };
}
