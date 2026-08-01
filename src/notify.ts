import { Notification } from 'electron';
import log from 'electron-log/main';

import { errorMessage } from './utils';

const notifyLog = log.scope('notify');

// The only place in Sidra a Notification is constructed, because on Linux
// Notification.show() blocks the browser UI thread when nothing owns
// org.freedesktop.Notifications. Electron calls notify_notification_show()
// inline, libnotify builds its GDBusProxy without DO_NOT_AUTO_START, so GLib
// runs StartServiceByName in a nested main loop and waits the 25 second D-Bus
// activation timeout; Electron queries server capabilities three times before
// the show, so one notification freezes the window for about 100 seconds.
// createNotification() returns null while the gate is closed, and constructing
// a Notification anywhere else reopens the freeze.

// The gate starts closed on Linux and opens on the first probe reply: a
// notification raised before the reply lands has no verified answer, and
// guessing wrong costs a 100 second freeze. macOS and Windows have no daemon
// to probe, so the gate is open from the start and no bus is ever opened.
let daemonAvailable = process.platform !== 'linux';
let failureLatched = false;

/** True when a notification can be raised without risking the freeze above. */
export function notificationsAvailable(): boolean {
  return daemonAvailable && !failureLatched;
}

/**
 * Open the gate on Linux once a notification daemon is confirmed, and follow it
 * for the rest of the session. Called once from app.whenReady(); a no-op on
 * every other platform.
 */
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

/**
 * Build a Notification, or return null when nothing can receive it. Callers
 * must handle the null rather than assume a notification exists.
 */
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
