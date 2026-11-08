import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
// The SDK is often copied into a game's repository, so the file itself says where the docs and the
// issue tracker are.
const banner = [
  `/*! GameRush SDK for JavaScript v${pkg.version}`,
  " * Docs: https://gamerush.jp/sdk",
  " * Source: https://github.com/gamerush-jp/grush-sdk-js",
  " * Issues: https://github.com/gamerush-jp/grush-sdk-js/issues",
  " */",
].join("\n");

const targets = [
  { entry: "src/global.js", outfile: "grush-sdk.js", format: "iife" },
  { entry: "src/index.js", outfile: "grush-sdk.mjs", format: "esm" },
];

async function render(target) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [target.entry],
    bundle: true,
    format: target.format,
    target: "es2020",
    legalComments: "none",
    banner: { js: banner },
    write: false,
  });
  return result.outputFiles[0].text;
}

const check = process.argv.includes("--check");
const stale = [];

for (const target of targets) {
  const text = await render(target);
  const file = path.join(root, target.outfile);
  if (check) {
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (current !== text) stale.push(target.outfile);
  } else {
    fs.writeFileSync(file, text);
  }
}

if (stale.length > 0) {
  console.error(`${stale.join(", ")} is out of date. Run \`npm run build\` and commit the result.`);
  process.exit(1);
}
