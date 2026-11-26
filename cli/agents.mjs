import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// AI エージェント向けの文書（このパッケージの agents/）を、作者のプロジェクトの .gamerush/ へ写し、プロジェクトの
// AGENTS.md（と、あれば CLAUDE.md）から指す。エージェントはパッケージの置き場を読まないので、プロジェクトの中に置く。
// フォルダの名前と目印は agents/install.json にあり、Unity と Godot の SDK のメニューも同じものを読む。

const AGENTS_DIR = fileURLToPath(new URL("../agents/", import.meta.url));
// install.json の dir と pointers[].file に使える名前。プロジェクトの直下の1つの名前だけ（区切りと .. を許さない）。
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * @typedef {{
 *   dir: string,
 *   versionPlaceholder: string,
 *   begin: string,
 *   end: string,
 *   pointers: { file: string, create: boolean, block: string }[],
 * }} InstallSpec
 *
 * @typedef {{ file: string, status: "created" | "updated" | "unchanged" | "skipped" }} PointerResult
 */

/** @param {string} [sourceDir] @returns {InstallSpec} */
export function readInstallSpec(sourceDir = AGENTS_DIR) {
  const spec = JSON.parse(fs.readFileSync(path.join(sourceDir, "install.json"), "utf8"));
  // grush update はリリースから取った install.json を読むので、書く先がプロジェクトの直下の名前であることを確かめる。
  const names = [
    spec?.dir,
    ...(Array.isArray(spec?.pointers) ? spec.pointers : [null]).map(
      (/** @type {any} */ p) => p?.file,
    ),
  ];
  const valid =
    names.every(
      (name) => typeof name === "string" && SAFE_NAME.test(name) && name !== "." && name !== "..",
    ) &&
    ["versionPlaceholder", "begin", "end"].every(
      (key) => typeof spec[key] === "string" && spec[key] !== "",
    ) &&
    spec.pointers.every(
      (/** @type {any} */ p) => typeof p.block === "string" && typeof p.create === "boolean",
    );
  if (!valid)
    throw new Error(
      `AI エージェント向けの文書の install.json の形が正しくありません: ${sourceDir}`,
    );
  return spec;
}

/** @param {string} text @param {string} marker */
function countOf(text, marker) {
  return text.split(marker).length - 1;
}

/**
 * 目印で囲んだ段を、文書に入れるか置き換える。目印が無ければ末尾に足す。改行は元の文書に合わせる。
 * 目印が片方だけ・2組以上・逆順のときは、置き換えると作者の文を消しかねないので、null を返して何もしない。
 * @param {string} content 元の文書（無ければ空文字列）
 * @param {InstallSpec} spec
 * @param {string} block
 * @returns {string | null}
 */
export function upsertPointer(content, spec, block) {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const section = [spec.begin, ...block.split("\n"), spec.end].join(eol);
  const begins = countOf(content, spec.begin);
  const ends = countOf(content, spec.end);
  if (begins !== 0 || ends !== 0) {
    const begin = content.indexOf(spec.begin);
    const end = content.indexOf(spec.end);
    if (begins !== 1 || ends !== 1 || end < begin) return null;
    return content.slice(0, begin) + section + content.slice(end + spec.end.length);
  }
  if (content === "") return section + eol;
  const separator = content.endsWith(eol) ? eol : eol + eol;
  return content + separator + section + eol;
}

/** @param {string} dir @returns {string[]} */
function markdownFiles(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort();
}

/**
 * @param {{ projectDir: string, stamp: string, sourceDir?: string }} options
 *   stamp は .gamerush/AGENTS.md に書く SDK の名前と版（例: "grush-sdk-js 0.22.0"）
 * @returns {{ dir: string, files: string[], pointers: PointerResult[] }}
 */
export function installAgentDocs({ projectDir, stamp, sourceDir = AGENTS_DIR }) {
  const root = path.resolve(projectDir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`プロジェクトのフォルダがありません: ${root}`);
  }
  const spec = readInstallSpec(sourceDir);

  // 段を足す先を先に全部確かめ、目印が壊れていれば何も書かずに止める。
  const planned = spec.pointers.map((pointer) => {
    const file = path.join(root, pointer.file);
    const exists = fs.existsSync(file);
    if (!exists && !pointer.create) return { pointer, file, exists, before: "", after: null };
    const before = exists ? fs.readFileSync(file, "utf8") : "";
    const after = upsertPointer(before, spec, pointer.block);
    if (after === null) {
      throw new Error(
        `${pointer.file} の目印（${spec.begin} と ${spec.end}）が1組そろっていません。目印の行を直すか消してから、もう一度実行してください。`,
      );
    }
    return { pointer, file, exists, before, after };
  });

  const dest = path.join(root, spec.dir);
  const destDocs = path.join(dest, "docs");
  // 前の版にあって今の版に無いファイルが残らないよう、docs/ は作り直す。
  fs.rmSync(destDocs, { recursive: true, force: true });
  fs.mkdirSync(destDocs, { recursive: true });

  const agents = fs
    .readFileSync(path.join(sourceDir, "AGENTS.md"), "utf8")
    .replaceAll(spec.versionPlaceholder, stamp);
  fs.writeFileSync(path.join(dest, "AGENTS.md"), agents);
  const files = [path.join(spec.dir, "AGENTS.md")];
  for (const name of markdownFiles(path.join(sourceDir, "docs"))) {
    fs.copyFileSync(path.join(sourceDir, "docs", name), path.join(destDocs, name));
    files.push(path.join(spec.dir, "docs", name));
  }

  /** @type {PointerResult[]} */
  const pointers = [];
  for (const { pointer, file, exists, before, after } of planned) {
    if (after === null) {
      pointers.push({ file: pointer.file, status: "skipped" });
      continue;
    }
    if (after !== before) fs.writeFileSync(file, after);
    pointers.push({
      file: pointer.file,
      status: !exists ? "created" : after === before ? "unchanged" : "updated",
    });
  }
  return { dir: dest, files, pointers };
}
