import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { installAgentDocs, readInstallSpec } from "./agents.mjs";
import { CliError } from "./api.mjs";
import {
  GODOT_ADDON,
  GODOT_BUILD_ADDON,
  UNITY_MANIFEST,
  detectProject,
  godotPluginVersion,
  hasJs,
  rewriteJsdelivr,
  rewriteUnityManifest,
  sdkLabel,
} from "./project.mjs";
import {
  SDKS,
  compareVersions,
  downloadSourceZip,
  fetchLatestVersion,
  normalizeVersion,
  recordLatestVersion,
} from "./releases.mjs";
import { ZipError, readZipEntries } from "./zip.mjs";

// grush update: プロジェクトの SDK を、同じエンジンの SDK のリポジトリの最新のリリース（か --to の版）へ上げる。
// 書き換える前に予定を全部見せ、--yes か対話の確認があったときだけ書く。

/**
 * @typedef {import("./releases.mjs").SdkKind} SdkKind
 * @typedef {import("./releases.mjs").FetchLike} FetchLike
 * @typedef {import("./credentials.mjs").CredentialsHost} CredentialsHost
 *
 * @typedef {{
 *   fetch: FetchLike,
 *   host: CredentialsHost,
 *   out: (line: string) => void,
 *   err: (line: string) => void,
 *   confirm: (question: string) => Promise<boolean>,
 *   isInteractive: boolean,
 *   now: () => Date,
 * }} UpdateDeps
 *
 * @typedef {{
 *   kind: SdkKind,
 *   line: string,
 *   archive: boolean,
 *   details?: (work: Workspace) => string[],
 *   apply: (work: Workspace, tx: Transaction) => void | boolean | Promise<void | boolean>,
 * }} Action
 *   archive はリリースの zip が要るとき true（予定を見せる前に取る）。details は予定に添える行。
 *   apply が false を返したら、書き換えなかったことを表す
 *
 * @typedef {{ root: string, temp: string, extracted: (kind: SdkKind) => string }} Workspace
 */

// エージェント向けの文書が、各 SDK のリリースのどこにあるか。
/** @type {Record<SdkKind, string>} */
const AGENT_DOCS_DIR = {
  js: "agents",
  unity: "Documentation~/agents",
  godot: "addons/grush_sdk/agents",
};
const JS_RELEASE_FILES = { iife: "grush-sdk.js", esm: "grush-sdk.mjs", dts: "grush-sdk.d.ts" };
// Godot が生成するファイル。リリースに無いものは、置き換えの前のフォルダから引き継ぐ（UID が変わると参照が切れうる）。
const GODOT_GENERATED = [".uid", ".import"];

/** @param {string | null} version */
const v = (version) => (version ? `v${version}` : "版不明");

/**
 * zip のパスを、展開してよい相対パスにする。危ないパス（絶対パス・..・ドライブ名など）は例外。
 * @param {string} name
 */
export function safeRelativePath(name) {
  const segments = name.split("/");
  const unsafe =
    name === "" ||
    name.includes("\\") ||
    name.includes("\0") ||
    name.startsWith("/") ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === ".." || segment.includes(":"),
    );
  if (unsafe) throw new CliError(`SDK の zip に危ないパスがあります: ${name}`);
  return name;
}

/**
 * GitHub のソースの zip（一番上に1つのフォルダがある）を、prefix の下だけ dest へ展開する。
 * @param {Buffer} buffer
 * @param {string} dest
 * @returns {string[]} 展開したファイルの、zip の一番上のフォルダを剥がした後の相対パス
 */
export function extractSourceZip(buffer, dest) {
  let entries;
  try {
    entries = readZipEntries(buffer);
  } catch (error) {
    if (error instanceof ZipError) throw new CliError(`SDK の zip を読めません: ${error.message}`);
    throw error;
  }
  // GitHub のソースの zip は、全部が「持ち主-リポジトリ-コミット/」の下に入っている。
  const roots = new Set(entries.map((entry) => entry.path.split("/")[0]));
  if (roots.size !== 1 || entries.some((entry) => !entry.path.includes("/"))) {
    throw new CliError("SDK の zip の形が GitHub のソースの zip と違います。");
  }
  const written = [];
  for (const entry of entries) {
    const relative = safeRelativePath(entry.path.slice(entry.path.indexOf("/") + 1));
    const target = path.resolve(dest, relative);
    if (!target.startsWith(path.resolve(dest) + path.sep)) {
      throw new CliError(`SDK の zip に危ないパスがあります: ${entry.path}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.read(), { flag: "wx" });
    written.push(relative);
  }
  return written;
}

/** 書き込みの途中で落ちても壊れたファイルが残らないよう、隣に書いてから置き換える。 @param {string} file @param {string | Buffer} data */
function writeAtomic(file, data) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (stat && !stat.isFile())
    throw new CliError(`通常のファイルではないので書き換えません: ${file}`);
  const temporary = `${file}.grush-${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, data, { flag: "wx", mode: stat ? stat.mode & 0o777 : 0o644 });
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * フォルダの中のファイル（シンボリックリンクも、たどらずに1つのファイルとして）を並べる。
 * @param {string} dir @param {string} [prefix] @returns {string[]}
 */
function listFiles(dir, prefix = "") {
  const result = [];
  for (const entry of fs.readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...listFiles(dir, relative));
    else result.push(relative);
  }
  return result;
}

/** Godot が生成したファイルで、元のファイルが新しい版にあるもの（引き継ぐもの）。 @param {string} file @param {string} fresh */
function carriedOver(file, fresh) {
  const generated = GODOT_GENERATED.find((extension) => file.endsWith(extension));
  return (
    generated !== undefined && fs.existsSync(path.join(fresh, file.slice(0, -generated.length)))
  );
}

/**
 * 入れ替えると無くなるファイル。新しい版に無く、引き継ぎもしないもの（作者が足したファイルと、新しい版で消えたファイル）。
 * @param {string} current 今のフォルダ @param {string} fresh 新しい版のフォルダ
 */
export function filesLostBySwap(current, fresh) {
  if (!fs.existsSync(current)) return [];
  return listFiles(current).filter(
    (file) => !fs.existsSync(path.join(fresh, file)) && !carriedOver(file, fresh),
  );
}

/**
 * 書き換えの取り消しの記録。書き換える前の中身を、入れ替えるフォルダの外（プロジェクトの .grush-backup-…/）に置き、
 * 途中で失敗したら逆順に戻す。戻せなかったものがあっても、退避先は消さない。
 */
export class Transaction {
  /** @param {string} root @param {string} backup @param {string} temp */
  constructor(root, backup, temp) {
    this.root = root;
    this.backup = backup;
    this.temp = temp;
    /** @type {(() => void)[]} */
    this.undo = [];
    this.discarded = 0;
  }

  /** 失敗したら戻す先を退避先から外さないよう、戻すときに消すものは作業用のフォルダへ移す。 @param {string} file */
  discard(file) {
    if (!fs.lstatSync(file, { throwIfNoEntry: false })) return;
    this.discarded += 1;
    const trash = path.join(this.temp, "discarded", String(this.discarded));
    fs.mkdirSync(path.dirname(trash), { recursive: true });
    fs.renameSync(file, trash);
  }

  /** 書き換える前のファイルを写しておく。 @param {string} relative */
  backupFile(relative) {
    const file = path.join(this.root, relative);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (stat && !stat.isFile()) {
      throw new CliError(`通常のファイルではないので書き換えません: ${relative}`);
    }
    if (!stat) {
      this.undo.push(() => this.discard(file));
      return;
    }
    const copy = path.join(this.backup, relative);
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.copyFileSync(file, copy);
    this.undo.push(() => fs.copyFileSync(copy, file));
  }

  /** 書き換える前のフォルダを写しておく。 @param {string} relative */
  backupTree(relative) {
    const dir = path.join(this.root, relative);
    const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (stat && !stat.isDirectory()) {
      throw new CliError(`${relative} がフォルダではないので書き換えません。`);
    }
    if (!stat) {
      this.undo.push(() => this.discard(dir));
      return;
    }
    const copy = path.join(this.backup, relative);
    fs.cpSync(dir, copy, { recursive: true, verbatimSymlinks: true });
    this.undo.push(() => {
      this.discard(dir);
      fs.cpSync(copy, dir, { recursive: true, verbatimSymlinks: true });
    });
  }

  /**
   * プロジェクトのフォルダを新しい中身と入れ替える。元のフォルダは退避先へ移す（写さないので速く、失敗しても退避先に残る）。
   * @param {string} relative プロジェクトの中のフォルダ（例: addons/grush_sdk）
   * @param {string} fresh 新しい中身のフォルダ
   */
  swapDirectory(relative, fresh) {
    const target = path.join(this.root, relative);
    const stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (stat && !stat.isDirectory()) {
      throw new CliError(
        `${relative} がフォルダではない（シンボリックリンクなど）ので置き換えません。`,
      );
    }
    const previous = path.join(this.backup, relative);
    if (stat) {
      fs.mkdirSync(path.dirname(previous), { recursive: true });
      fs.renameSync(target, previous);
      this.undo.push(() => {
        this.discard(target);
        fs.renameSync(previous, target);
      });
    } else {
      this.undo.push(() => this.discard(target));
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(fresh, target);
    if (!stat) return;
    for (const file of listFiles(previous)) {
      const destination = path.join(target, file);
      if (carriedOver(file, target) && !fs.existsSync(destination)) {
        fs.copyFileSync(path.join(previous, file), destination);
      }
    }
  }

  /** 逆順に戻す。戻せなかったものの説明を返す。 @returns {string[]} */
  rollback() {
    const failures = [];
    for (const undo of this.undo.reverse()) {
      try {
        undo();
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    this.undo = [];
    return failures;
  }
}

/**
 * @param {{ projectDir: string, to?: string, yes: boolean, dryRun: boolean, deps: UpdateDeps }} options
 * @returns {Promise<number>}
 */
export async function updateProject({ projectDir, to, yes, dryRun, deps }) {
  if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
    throw new CliError(`プロジェクトのフォルダがありません: ${projectDir}`);
  }
  const sdks = detectProject(projectDir);
  const root = sdks.root;
  /** @type {SdkKind[]} */
  const kinds = [];
  if (sdks.unity) kinds.push("unity");
  if (sdks.godot) kinds.push("godot");
  if (hasJs(sdks.js)) kinds.push("js");
  if (kinds.length === 0) {
    throw new CliError(
      `GameRush の SDK が見つかりません: ${root}（Unity は ${UNITY_MANIFEST}、Godot は ${GODOT_ADDON}/、JavaScript は grush-sdk.js などの先頭の注記で探します）`,
    );
  }

  let explicit = null;
  if (to !== undefined) {
    explicit = normalizeVersion(to);
    if (!explicit) throw new CliError(`--to には版を vX.Y.Z の形で指定してください: ${to}`);
    // Unity・Godot・JavaScript の SDK は版の番号が別々なので、1つの --to をまとめて当てない。
    if (kinds.length > 1) {
      throw new CliError(
        `このプロジェクトには ${kinds.map(sdkLabel).join("・")} があります。--to は SDK が1種類のときだけ使えます。`,
      );
    }
  }

  /** @type {Partial<Record<SdkKind, string>>} */
  const targets = {};
  for (const kind of kinds) {
    if (explicit) {
      targets[kind] = explicit;
      continue;
    }
    const latest = await fetchLatestVersion({ fetch: deps.fetch, env: deps.host.env, kind });
    recordLatestVersion(deps.host, kind, latest, deps.now());
    targets[kind] = latest;
  }

  /** @type {Action[]} */
  const actions = [];
  /** @type {string[]} */
  const notes = [];
  /** @type {string[]} */
  const current = [];
  /** 入れ替えで Godot のアドオンのフォルダから無くなるファイル。 @type {string[]} */
  const godotLost = [];
  /**
   * 上げるかどうか。--to が無いときは、最新より新しい版を下げない。
   * @param {string | null} from @param {string} target
   */
  const needsChange = (from, target) => {
    if (from === null) return true;
    const diff = compareVersions(from, target);
    return explicit ? diff !== 0 : diff < 0;
  };

  if (sdks.unity) {
    const unity = sdks.unity;
    const target = /** @type {string} */ (targets.unity);
    if (unity.mode === "git") {
      if (!needsChange(unity.version, target)) {
        current.push(`${sdkLabel("unity")}: ${v(unity.version)}（最新は v${target}）`);
      } else {
        const manifestPath = path.join(root, UNITY_MANIFEST);
        const rewritten = rewriteUnityManifest(fs.readFileSync(manifestPath, "utf8"), target);
        if (rewritten === null) {
          notes.push(
            `${UNITY_MANIFEST} の ${"cc.gamerush.sdk"} を書き換えられませんでした。Package Manager で https://github.com/gamerush-jp/grush-sdk-unity.git#v${target} を入れ直してください。`,
          );
        } else {
          actions.push({
            kind: "unity",
            line: `${UNITY_MANIFEST}: cc.gamerush.sdk ${v(unity.version)} → v${target}`,
            archive: false,
            apply: (_work, tx) => {
              tx.backupFile(UNITY_MANIFEST);
              writeAtomic(manifestPath, rewritten);
            },
          });
        }
      }
    } else {
      const how = {
        local: `ローカルのフォルダ（${unity.value}）から入れています`,
        embedded: "Packages/cc.gamerush.sdk/ に置いています",
        other: `git のタグ以外で入れています（${unity.value}）`,
      }[unity.mode];
      notes.push(
        `${sdkLabel("unity")}（${v(unity.version)}）は${how}。自動では上げないので、Package Manager の Add package from git URL... に https://github.com/gamerush-jp/grush-sdk-unity.git#v${target} を入れてください。`,
      );
    }
  }

  if (sdks.godot) {
    const godot = sdks.godot;
    const target = /** @type {string} */ (targets.godot);
    if (godot.mode === "link") {
      notes.push(
        `${GODOT_ADDON} はシンボリックリンクなので書き換えません。リンク先を ${sdkLabel("godot")} v${target} にしてください。`,
      );
    } else if (!needsChange(godot.version, target)) {
      current.push(`${sdkLabel("godot")}: ${v(godot.version)}（最新は v${target}）`);
    } else {
      const dirs = [GODOT_ADDON, ...(godot.hasBuildAddon ? [GODOT_BUILD_ADDON] : [])];
      actions.push({
        kind: "godot",
        line: `${dirs.map((dir) => `${dir}/`).join("・")}: ${v(godot.version)} → v${target}（フォルダごと入れ替える）`,
        archive: true,
        details: (work) => {
          const source = work.extracted("godot");
          const cfg = path.join(source, GODOT_ADDON, "plugin.cfg");
          if (!fs.existsSync(cfg) || godotPluginVersion(fs.readFileSync(cfg, "utf8")) !== target) {
            throw new CliError(
              `取得した ${GODOT_ADDON}/plugin.cfg の版が v${target} ではありません。`,
            );
          }
          for (const dir of dirs) {
            if (!fs.existsSync(path.join(source, dir))) {
              throw new CliError(`${sdkLabel("godot")} v${target} に ${dir}/ がありません。`);
            }
          }
          const lost = dirs.flatMap((dir) =>
            filesLostBySwap(path.join(root, dir), path.join(source, dir)).map(
              (file) => `${dir}/${file}`,
            ),
          );
          godotLost.push(...lost);
          return lost.length === 0
            ? []
            : [
                `次の ${lost.length} ファイルは v${target} に無いので、入れ替えるとフォルダから無くなります（退避先に残します）:`,
                ...lost.map((file) => `  ${file}`),
              ];
        },
        apply: (work, tx) => {
          const source = work.extracted("godot");
          for (const dir of dirs) tx.swapDirectory(dir, path.join(source, dir));
        },
      });
    }
  }

  if (hasJs(sdks.js)) {
    const target = /** @type {string} */ (targets.js);
    const js = sdks.js;
    const copies = js.copies.filter(
      (copy) => copy.flavor !== "dts" && needsChange(copy.version, target),
    );
    const cdn = js.cdn.filter((ref) =>
      ref.versions.some((version) => needsChange(version, target)),
    );
    // 型のファイルは版を持たないので、同じフォルダの SDK を上げるときか、版の分からないときに入れ替える。
    const types = js.copies.filter(
      (copy) =>
        copy.flavor === "dts" &&
        (copy.version === null
          ? copies.length > 0 || cdn.length > 0
          : needsChange(copy.version, target)),
    );
    for (const copy of [...copies, ...types]) {
      actions.push({
        kind: "js",
        line: `${copy.file}: ${v(copy.version)} → v${target}`,
        archive: true,
        apply: (work, tx) => {
          const data = fs.readFileSync(
            path.join(work.extracted("js"), JS_RELEASE_FILES[copy.flavor]),
          );
          tx.backupFile(copy.file);
          writeAtomic(path.join(root, copy.file), data);
        },
      });
    }
    for (const ref of cdn) {
      actions.push({
        kind: "js",
        line: `${ref.file}: jsDelivr の URL ${[...new Set(ref.versions.filter((version) => needsChange(version, target)))].map(v).join("・")} → v${target}`,
        archive: false,
        apply: (_work, tx) => {
          const file = path.join(root, ref.file);
          tx.backupFile(ref.file);
          const text = fs.readFileSync(file, "utf8");
          writeAtomic(
            file,
            rewriteJsdelivr(text, target, (version) => needsChange(version, target)),
          );
        },
      });
    }
    for (const sub of js.submodules) {
      if (!needsChange(sub.version, target)) {
        current.push(`${sub.dir}（submodule）: ${v(sub.version)}（最新は v${target}）`);
        continue;
      }
      notes.push(
        `${sub.dir} は grush-sdk-js の git のチェックアウト（submodule など）なので書き換えません。git -C ${sub.dir} fetch --tags && git -C ${sub.dir} checkout v${target} で上げ、親のリポジトリで ${sub.dir} をコミットしてください。`,
      );
    }
    if (
      copies.length === 0 &&
      cdn.length === 0 &&
      types.length === 0 &&
      js.copies.length + js.cdn.length > 0
    ) {
      current.push(`${sdkLabel("js")}: 最新（v${target}）です`);
    }
  }

  // .gamerush/ があれば、上げた SDK の版の文書で入れ直す。
  const agentsKind = ["unity", "godot", "js"].find((kind) =>
    actions.some((action) => action.kind === kind),
  );
  if (agentsKind && fs.existsSync(path.join(root, ".gamerush", "AGENTS.md"))) {
    const kind = /** @type {SdkKind} */ (agentsKind);
    const version = /** @type {string} */ (targets[kind]);
    actions.push({
      kind,
      line: `.gamerush/: AI エージェント向けの文書を ${sdkLabel(kind)} v${version} のもので入れ直す`,
      archive: true,
      apply: (work, tx) => {
        // Godot の文書はアドオンの中にあり、アドオンは先にプロジェクトへ移している。
        const base = kind === "godot" ? root : work.extracted(kind);
        const source = path.join(base, AGENT_DOCS_DIR[kind]);
        if (!fs.existsSync(path.join(source, "install.json"))) {
          deps.out(
            `${sdkLabel(kind)} v${version} には AI エージェント向けの文書が無いので、.gamerush/ はそのままにします。`,
          );
          return false;
        }
        // install.json はリリースから取ったものなので、書く先がプロジェクトの外を指していないかを readInstallSpec が確かめる。
        const spec = readInstallSpec(source);
        tx.backupTree(spec.dir);
        for (const pointer of spec.pointers) tx.backupFile(pointer.file);
        installAgentDocs({
          projectDir: root,
          stamp: `${SDKS[kind].repo} ${version}`,
          sourceDir: source,
        });
      },
    });
  }

  if (sdks.js.truncated) {
    current.push(
      "ファイルが多い・深いので、JavaScript の SDK を途中まで探しました。見つからない SDK があれば、そのフォルダを指定して実行してください。",
    );
  }
  for (const line of current) deps.out(line);
  for (const line of notes) deps.out(`手で上げてください: ${line}`);
  if (actions.length === 0) {
    deps.out(notes.length > 0 ? "自動で書き換えるものはありません。" : "SDK は最新です。");
    return 0;
  }

  // 作業用のフォルダはプロジェクトの中に作る。同じドライブなので、Godot のフォルダの入れ替えが rename で済む。
  const stamp = `${deps.now().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${randomBytes(3).toString("hex")}`;
  const temp = path.join(root, `.grush-update-${stamp}`);
  const backup = path.join(root, `.grush-backup-${stamp}`);
  fs.mkdirSync(temp);
  // Godot のエディタが開いていても、作業用のフォルダを取り込まないように。
  fs.writeFileSync(path.join(temp, ".gdignore"), "");
  /** @type {Map<SdkKind, string>} */
  const extracted = new Map();
  /** @type {Workspace} */
  const work = {
    root,
    temp,
    extracted: (kind) => {
      const dir = extracted.get(kind);
      if (!dir) throw new Error(`${kind} のリリースを取得していません。`);
      return dir;
    },
  };
  try {
    // 取得と展開を先に済ませる。予定に「入れ替えで無くなるファイル」を出すためと、書き換えの途中で取得に失敗しないため。
    for (const action of actions) {
      if (!action.archive || extracted.has(action.kind)) continue;
      const version = /** @type {string} */ (targets[action.kind]);
      deps.out(`${sdkLabel(action.kind)} v${version} を取得しています…`);
      const buffer = await downloadSourceZip({
        fetch: deps.fetch,
        env: deps.host.env,
        kind: action.kind,
        version,
      });
      const dest = path.join(temp, action.kind);
      fs.mkdirSync(dest);
      extractSourceZip(buffer, dest);
      extracted.set(action.kind, dest);
    }

    deps.out(`次のとおり書き換えます（${root}）:`);
    for (const action of actions) {
      deps.out(`  ${action.line}`);
      for (const line of action.details?.(work) ?? []) deps.out(`    ${line}`);
    }
    if (dryRun) {
      deps.out("--dry-run なので、書き換えていません。");
      return 0;
    }
    if (!yes) {
      if (!deps.isInteractive) {
        deps.err("書き換えるには、上の内容を確かめてから --yes を付けて実行してください。");
        return 1;
      }
      if (!(await deps.confirm("書き換えますか？ [y/N] "))) {
        deps.out("書き換えをやめました。");
        return 1;
      }
    }

    fs.mkdirSync(backup);
    fs.writeFileSync(path.join(backup, ".gdignore"), "");
    const tx = new Transaction(root, backup, temp);
    /** @type {string[]} */
    const done = [];
    for (const action of actions) {
      try {
        if ((await action.apply(work, tx)) !== false) {
          done.push(action.line);
          deps.out(`書き換えました: ${action.line}`);
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const failures = tx.rollback();
        deps.err(`書き換えに失敗しました: ${action.line}`);
        deps.err(`理由: ${reason}`);
        if (failures.length === 0) {
          deps.err(
            done.length > 0
              ? `先に書き換えた ${done.length} 件は元に戻しました。`
              : "書き換えたものはありません。",
          );
        } else {
          deps.err(`元に戻せなかったものがあります: ${failures.join(" / ")}`);
        }
        throw new CliError(`書き換える前の中身は ${backup} に残しています。`);
      }
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }

  if (godotLost.length > 0) {
    deps.out(
      `入れ替えで無くなったファイルは ${backup} に残しています。要らなければ消してください。`,
    );
  } else {
    fs.rmSync(backup, { recursive: true, force: true });
  }
  if (actions.some((action) => action.kind === "unity")) {
    deps.out("Unity でプロジェクトを開くと、Package Manager が新しい版を取り込みます。");
  }
  if (actions.some((action) => action.kind === "godot")) {
    deps.out("Godot のエディタを開いているなら、開き直してください。");
  }
  return 0;
}
