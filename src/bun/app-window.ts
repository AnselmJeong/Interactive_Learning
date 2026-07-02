import { BrowserWindow } from "electrobun/bun";

export function createMainWindow(rpc: never) {
  return new BrowserWindow({
    title: "Learnie",
    url: "views://main/index.html",
    frame: { width: 1380, height: 900, x: 80, y: 80 },
    titleBarStyle: "default",
    rpc,
  });
}
