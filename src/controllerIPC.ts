import { BrowserWindow, ipcMain } from 'electron';
import log from 'electron-log/main';
import { CONTROLLER_ACTION_CHANNEL, isControllerAction, type ControllerAction } from './controller';

const controllerLog = log.scope('controller');

const ACTION_KEYS: Readonly<Record<Exclude<ControllerAction, 'back'>, string>> = {
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  select: 'Enter',
};

/** Navigate back only when the window has a previous history entry. */
export function goBackIfPossible(win: BrowserWindow): void {
  if (win.webContents.navigationHistory.canGoBack()) {
    win.webContents.navigationHistory.goBack();
  }
}

/** Accept fixed controller actions from this window and send native keys only while focused. */
export function initControllerIPC(win: BrowserWindow): void {
  ipcMain.on(CONTROLLER_ACTION_CHANNEL, (event, payload: unknown) => {
    if (event.sender !== win.webContents) {
      controllerLog.warn('rejected controller action from unexpected sender');
      return;
    }
    if (!isControllerAction(payload)) {
      controllerLog.warn('rejected invalid controller action');
      return;
    }
    if (!win.isFocused()) return;

    if (payload === 'back') {
      goBackIfPossible(win);
      return;
    }

    const keyCode = ACTION_KEYS[payload];
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
  });
}
