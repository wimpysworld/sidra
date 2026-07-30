import { Notification } from 'electron';
import log from 'electron-log/main';

import { errorMessage } from './utils';

const notifyLog = log.scope('notify');

// The gate starts closed on Linux and opens on the first probe reply: a
// notification raised before the reply lands has no verified answer, and
// guessing wrong costs a 100 second freeze. macOS and Windows have no daemon
// to probe, so the gate is open from the start and no bus is ever opened.
let daemonAvailable = process.platform !== 'linux';
let failureLatched = false;

export function notificationsAvailable(): boolean {
  return daemonAvailable && !failureLatched;
}

export function initNotificationProbe(): void {
  if (process.platform !== 'linux') {
    return;
  }

  try {
    // ./notificationDaemon bare-requires @holusion/dbus-next, so it is
    // lazy-required after the platform check to keep D-Bus out of the import
    // graph on macOS and Windows
    const { initDaemonProbe } = require('./notificationDaemon') as typeof import('./notificationDaemon');

    initDaemonProbe((hasOwner: boolean) => {
      const wasAvailable = notificationsAvailable();
      daemonAvailable = hasOwner;
      if (hasOwner) {
        // A daemon appearing mid-session must clear a latch left by an earlier
        // failure, or notifications stay dead until a restart
        failureLatched = false;
      }
      if (notificationsAvailable() !== wasAvailable) {
        notifyLog.info(hasOwner
          ? 'notifications enabled'
          : 'notifications disabled: no notification daemon');
      }
    });
  } catch (err: unknown) {
    notifyLog.warn('notification daemon probe unavailable; notifications disabled:', errorMessage(err));
  }
}

export function createNotification(
  options: Electron.NotificationConstructorOptions,
): Notification | null {
  if (!notificationsAvailable()) {
    notifyLog.debug('notification suppressed; no notification daemon:', options.title);
    return null;
  }

  const notification = new Notification(options);

  notification.on('failed', (_event, error) => {
    notifyLog.error('notification failed:', options.title, error);
    // Linux only: NameOwnerChanged re-opens the gate when a daemon appears.
    // macOS and Windows have no such recovery path, so a latch there would
    // kill notifications for the rest of the session.
    if (process.platform === 'linux') {
      failureLatched = true;
    }
  });

  return notification;
}
