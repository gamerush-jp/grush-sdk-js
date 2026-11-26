#!/usr/bin/env node
import { defaultDeps, run } from "../cli/main.mjs";

const [major] = process.versions.node.split(".").map(Number);
if (major < 20) {
  process.stderr.write(`grush には Node.js 20 以上が要ります（いま ${process.versions.node}）。\n`);
  process.exit(1);
}

// `npx github:gamerush-jp/grush-sdk-js grush login` の形では、npx がコマンド名の grush も引数として渡してくる。
const args = process.argv.slice(2);
if (args[0] === "grush") args.shift();

run(args, defaultDeps()).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(
      `予期しないエラー: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  },
);
