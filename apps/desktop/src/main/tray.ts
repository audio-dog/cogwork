import { Menu, nativeImage, Tray } from "electron";
import icon from "../../resources/icon.png?asset";

export interface TrayDeps {
  readonly onShow: () => void;
  readonly onQuit: () => void;
}

export const createTray = (deps: TrayDeps): Tray => {
  const image = nativeImage.createFromPath(icon).resize({ width: 18, height: 18 });
  const tray = new Tray(image);
  tray.setToolTip("clanker-forge");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show clanker-forge", click: deps.onShow },
      { type: "separator" },
      { label: "Quit (stops the engine)", click: deps.onQuit },
    ]),
  );
  tray.on("click", deps.onShow);
  return tray;
};
