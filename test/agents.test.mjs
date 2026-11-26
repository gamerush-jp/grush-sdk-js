import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { installAgentDocs, readInstallSpec, upsertPointer } from "../cli/agents.mjs";
import { packageVersion, run } from "../cli/main.mjs";

const roots = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grush-agents-"));
  roots.push(dir);
  return dir;
}
after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

const spec = readInstallSpec();
const read = (/** @type {string} */ file) => fs.readFileSync(file, "utf8");

function deps() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    deps: /** @type {any} */ ({
      out: (/** @type {string} */ line) => out.push(line),
      err: (/** @type {string} */ line) => err.push(line),
    }),
  };
}

describe("目印の段", () => {
  test("空の文書には段だけを書く", () => {
    assert.equal(upsertPointer("", spec, "a\nb"), `${spec.begin}\na\nb\n${spec.end}\n`);
  });

  test("目印が無ければ空行を挟んで末尾に足す", () => {
    assert.equal(upsertPointer("# x\n", spec, "a"), `# x\n\n${spec.begin}\na\n${spec.end}\n`);
    assert.equal(upsertPointer("# x", spec, "a"), `# x\n\n${spec.begin}\na\n${spec.end}\n`);
  });

  test("目印があれば、その間だけを置き換える", () => {
    const before = `head\n${spec.begin}\nold\n${spec.end}\ntail\n`;
    assert.equal(
      upsertPointer(before, spec, "new"),
      `head\n${spec.begin}\nnew\n${spec.end}\ntail\n`,
    );
  });

  test("CRLF の文書には CRLF で書く", () => {
    assert.equal(
      upsertPointer("# x\r\n", spec, "a\nb"),
      `# x\r\n\r\n${spec.begin}\r\na\r\nb\r\n${spec.end}\r\n`,
    );
  });

  test("目印が片方だけ・2組・逆順のときは置き換えない", () => {
    const pair = `${spec.begin}\nold\n${spec.end}\n`;
    assert.equal(upsertPointer(`keep\n${spec.begin}\nauthor text\n`, spec, "a"), null);
    assert.equal(upsertPointer(`author text\n${spec.end}\nkeep\n`, spec, "a"), null);
    assert.equal(upsertPointer(pair + pair, spec, "a"), null);
    assert.equal(upsertPointer(`${spec.end}\nx\n${spec.begin}\n`, spec, "a"), null);
  });

  test("何度入れても同じ文書になる", () => {
    const once = upsertPointer("# x\n", spec, "a");
    assert.equal(upsertPointer(once, spec, "a"), once);
  });
});

describe("grush agents", () => {
  test(".gamerush/ に文書を写し、AGENTS.md を作って指す", async () => {
    const project = tempDir();
    const { deps: d, out } = deps();
    assert.equal(await run(["agents", project], d), 0);

    const agents = read(path.join(project, ".gamerush/AGENTS.md"));
    assert.ok(agents.includes(`grush-sdk-js ${packageVersion()}`));
    assert.ok(!agents.includes(spec.versionPlaceholder));
    const shipped = fs.readdirSync(new URL("../agents/docs/", import.meta.url)).sort();
    assert.deepEqual(fs.readdirSync(path.join(project, ".gamerush/docs")).sort(), shipped);

    const pointer = read(path.join(project, "AGENTS.md"));
    assert.ok(pointer.startsWith(spec.begin));
    assert.ok(pointer.includes(".gamerush/AGENTS.md"));
    assert.equal(fs.existsSync(path.join(project, "CLAUDE.md")), false);
    assert.ok(out.some((line) => line.startsWith("AGENTS.md: ")));
  });

  test("既存の AGENTS.md と CLAUDE.md に1回だけ段を足し、古い文書を消す", () => {
    const project = tempDir();
    fs.writeFileSync(path.join(project, "AGENTS.md"), "# 自分の決まり\n");
    fs.writeFileSync(path.join(project, "CLAUDE.md"), "# memo\r\n");
    fs.mkdirSync(path.join(project, ".gamerush/docs"), { recursive: true });
    fs.writeFileSync(path.join(project, ".gamerush/docs/removed.md"), "old");

    const first = installAgentDocs({ projectDir: project, stamp: "test 1.0.0" });
    assert.deepEqual(
      first.pointers.map((pointer) => pointer.status),
      ["updated", "updated"],
    );
    assert.equal(fs.existsSync(path.join(project, ".gamerush/docs/removed.md")), false);
    const claude = read(path.join(project, "CLAUDE.md"));
    assert.ok(claude.startsWith("# memo\r\n\r\n"));
    assert.ok(claude.includes("\r\n@.gamerush/AGENTS.md\r\n"));
    assert.ok(read(path.join(project, "AGENTS.md")).startsWith("# 自分の決まり\n\n"));

    const second = installAgentDocs({ projectDir: project, stamp: "test 1.0.0" });
    assert.deepEqual(
      second.pointers.map((pointer) => pointer.status),
      ["unchanged", "unchanged"],
    );
    assert.equal(read(path.join(project, "CLAUDE.md")), claude);
  });

  test("目印が壊れた文書があれば、何も書かずに止める", async () => {
    const project = tempDir();
    const broken = `# 自分の決まり\n${spec.begin}\n消してはいけない文\n`;
    fs.writeFileSync(path.join(project, "CLAUDE.md"), broken);
    const { deps: d, err } = deps();
    assert.equal(await run(["agents", project], d), 1);
    assert.match(err.join("\n"), /CLAUDE\.md の目印/);
    assert.equal(read(path.join(project, "CLAUDE.md")), broken);
    assert.equal(fs.existsSync(path.join(project, "AGENTS.md")), false);
    assert.equal(fs.existsSync(path.join(project, ".gamerush")), false);
  });

  test("無いフォルダと2つ以上のフォルダは断る", async () => {
    const { deps: d, err } = deps();
    assert.equal(await run(["agents", path.join(tempDir(), "missing")], d), 1);
    assert.equal(await run(["agents", tempDir(), tempDir()], d), 1);
    assert.equal(err.length, 2);
  });
});

describe("同梱の文書", () => {
  test("AGENTS.md の地図のファイルが docs/ にそろう", () => {
    const agents = fs.readFileSync(new URL("../agents/AGENTS.md", import.meta.url), "utf8");
    const linked = [...agents.matchAll(/\]\(docs\/([\w.-]+\.md)/g)].map((match) => match[1]);
    assert.ok(linked.length > 0);
    for (const file of linked) {
      assert.ok(fs.existsSync(new URL(`../agents/docs/${file}`, import.meta.url)), file);
    }
  });
});
