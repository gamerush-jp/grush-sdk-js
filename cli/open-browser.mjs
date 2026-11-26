import { spawn } from "node:child_process";

/**
 * 既定のブラウザで URL を開く。シェルを通さずに引数で渡すので、URL の & や ? が解釈されない。
 * 開けなくても失敗にしない（URL は画面に出しているので、手で開いてもらえる）。
 * @param {string} url
 */
export function openBrowser(url) {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? // cmd の start は & を区切りとして読むので使わない。
          ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // 上の理由で無視する。
  }
}
