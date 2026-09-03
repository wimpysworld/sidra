import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import log from 'electron-log/main';
import { CONTROLLER_ACTION_CHANNEL } from '../src/controller';
import { goBackIfPossible, initControllerIPC } from '../src/controllerIPC';

type ControllerListener = (
  event: Pick<Electron.IpcMainEvent, 'sender'>,
  payload: unknown,
) => void;

function createWindow() {
  const webContents = {
    sendInputEvent: vi.fn(),
    navigationHistory: {
      canGoBack: vi.fn(() => false),
      goBack: vi.fn(),
    },
  };
  const win = {
    webContents,
    isFocused: vi.fn(() => true),
  } as unknown as Electron.BrowserWindow;
  return { win, webContents };
}

function registeredListener(): ControllerListener {
  const call = vi.mocked(ipcMain.on).mock.calls.find(([channel]) =>
    channel === CONTROLLER_ACTION_CHANNEL
  );
  expect(call).toBeDefined();
  return call?.[1] as ControllerListener;
}

describe('controller IPC', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['up', 'Up'],
    ['down', 'Down'],
    ['left', 'Left'],
    ['right', 'Right'],
    ['select', 'Enter'],
  ] as const)('maps %s to ordered key events for %s', (action, keyCode) => {
    const { win, webContents } = createWindow();
    initControllerIPC(win);

    registeredListener()({ sender: win.webContents }, action);

    expect(webContents.sendInputEvent.mock.calls).toEqual([
      [{ type: 'keyDown', keyCode }],
      [{ type: 'keyUp', keyCode }],
    ]);
  });

  it('rejects actions from another sender', () => {
    const { win, webContents } = createWindow();
    initControllerIPC(win);

    registeredListener()({ sender: {} as Electron.WebContents }, 'up');

    expect(webContents.sendInputEvent).not.toHaveBeenCalled();
    expect(log.scope('controller').warn).toHaveBeenCalledWith(
      'rejected controller action from unexpected sender',
    );
  });

  it.each(['invalid', { keyCode: 'Delete' }, null])('rejects invalid payload %j', payload => {
    const { win, webContents } = createWindow();
    initControllerIPC(win);

    registeredListener()({ sender: win.webContents }, payload);

    expect(webContents.sendInputEvent).not.toHaveBeenCalled();
    expect(log.scope('controller').warn).toHaveBeenCalledWith(
      'rejected invalid controller action',
    );
  });

  it('ignores actions while the window is not focused', () => {
    const { win, webContents } = createWindow();
    vi.mocked(win.isFocused).mockReturnValue(false);
    initControllerIPC(win);

    registeredListener()({ sender: win.webContents }, 'select');

    expect(webContents.sendInputEvent).not.toHaveBeenCalled();
  });

  it('routes back through guarded history navigation', () => {
    const { win, webContents } = createWindow();
    initControllerIPC(win);
    const listener = registeredListener();

    listener({ sender: win.webContents }, 'back');
    expect(webContents.navigationHistory.goBack).not.toHaveBeenCalled();

    webContents.navigationHistory.canGoBack.mockReturnValue(true);
    listener({ sender: win.webContents }, 'back');
    expect(webContents.navigationHistory.goBack).toHaveBeenCalledOnce();
    expect(webContents.sendInputEvent).not.toHaveBeenCalled();
  });
});

describe('goBackIfPossible', () => {
  it('checks the history before it navigates', () => {
    const { win, webContents } = createWindow();

    goBackIfPossible(win);
    expect(webContents.navigationHistory.goBack).not.toHaveBeenCalled();

    webContents.navigationHistory.canGoBack.mockReturnValue(true);
    goBackIfPossible(win);
    expect(webContents.navigationHistory.goBack).toHaveBeenCalledOnce();
  });
});
