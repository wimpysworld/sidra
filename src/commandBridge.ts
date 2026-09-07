import log from 'electron-log/main';

const bridgeLog = log.scope('command');

let sender: ((channel: ReceiveChannel, ...args: unknown[]) => void) | null = null;

/**
 * Supplies the main-process sender every menu surface reaches the renderer
 * through. main.ts calls this once, after the window exists.
 */
export function initCommandBridge(send: (channel: ReceiveChannel, ...args: unknown[]) => void): void {
  sender = send;
}

/**
 * Send a command through the current renderer sender, warning if none exists.
 * Call from click handlers so menus built before initCommandBridge() still work once the window exists.
 */
export function sendCommand(channel: ReceiveChannel, ...args: unknown[]): void {
  if (!sender) {
    bridgeLog.warn(`command dropped, no sender wired: ${channel}`);
    return;
  }
  sender(channel, ...args);
}
