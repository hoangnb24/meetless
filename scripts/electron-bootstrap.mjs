import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, Menu } from "electron";

const userData = process.env.PASEO_ELECTRON_USER_DATA_DIR?.trim();
const runtimeRoot = process.env.MEETLESS_RUNTIME_ROOT?.trim();
if (!userData || !runtimeRoot || path.relative(runtimeRoot, userData).startsWith("..")) {
  throw new Error("Meetless Electron bootstrap requires isolated user-data under its runtime root");
}

// This runs before the first Paseo module import. Vendor main observes the same fixed path.
app.setName("Meetless");
app.setPath("userData", userData);
app.on("browser-window-created", (_event, window) => {
  window.setTitle("Meetless");
  window.webContents.on("page-title-updated", (event) => {
    event.preventDefault();
    window.setTitle("Meetless");
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: "Meetless", submenu: [{ role: "about" }, { type: "separator" }, { role: "quit" }] },
      { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
      { label: "View", submenu: [{ role: "reload" }, { role: "togglefullscreen" }] },
    ]),
  );
});

const desktopMain = path.resolve("vendor/paseo/packages/desktop/dist/main.js");
await import(pathToFileURL(desktopMain).href);
app.setName("Meetless");
