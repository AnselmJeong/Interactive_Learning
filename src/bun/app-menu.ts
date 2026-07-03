import { ApplicationMenu, Utils } from "electrobun/bun";

const ABOUT_ACTION = "open-about";
const QUIT_ACTION = "quit-app";
let menuActionHandlerInstalled = false;

export function installApplicationMenu(onOpenAbout: () => void) {
  if (!menuActionHandlerInstalled) {
    ApplicationMenu.on("application-menu-clicked", (event) => {
      const action = (event as { data?: { action?: string } }).data?.action;
      if (action === ABOUT_ACTION) {
        onOpenAbout();
      } else if (action === QUIT_ACTION) {
        Utils.quit();
      }
    });
    menuActionHandlerInstalled = true;
  }

  ApplicationMenu.setApplicationMenu([
    {
      submenu: [
        { label: "About Learnie", action: ABOUT_ACTION },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "showAll" },
        { type: "separator" },
        { label: "Quit Learnie", action: QUIT_ACTION, accelerator: "q" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { type: "separator" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "enterFullScreen" },
        { role: "exitFullScreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { role: "bringAllToFront" },
      ],
    },
  ]);
}
