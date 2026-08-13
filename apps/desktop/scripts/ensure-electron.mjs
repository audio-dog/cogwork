import { createRequire } from "node:module";

// Electron v43+ dropped the `postinstall` hook that used to download the
// platform binary. The binary is now fetched lazily the first time
// `require('electron')` runs. electron-vite, however, reads `path.txt`
// directly and throws `Error: Electron uninstall` when the binary is missing —
// it never triggers that lazy download. So `pnpm dev` breaks on a clean
// install and every time the Electron version is bumped.
//
// Requiring Electron here resolves `getElectronPath()`, which downloads the
// matching binary (writing `path.txt` and `dist/`) when it is absent. Running
// this from the desktop package `postinstall` keeps `pnpm dev` working right
// after `pnpm install` for everyone.
const require = createRequire(import.meta.url);

try {
  const electronPath = require("electron");
  console.log(`Electron binary ready at ${electronPath}`);
} catch (error) {
  console.error(
    "Failed to install the Electron binary. Delete node_modules/electron and reinstall, or check your network.",
  );
  console.error(error);
  process.exit(1);
}
