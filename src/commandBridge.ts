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
 * Sends one command to the renderer. Callers must invoke this from the click
 * handler rather than capturing `sender` at build time: a menu built before
 * initCommandBridge() runs still works, because the sender is read when the
 * item is clicked. The warning covers the remaining case, a click that lands
 * before the window exists, which would otherwise fail in silence.
 */
export function sendCommand(channel: ReceiveChannel, ...args: unknown[]): void {
  if (!sender) {
    bridgeLog.warn(`command dropped, no sender wired: ${channel}`);
    return;
  }
  sender(channel, ...args);
}
