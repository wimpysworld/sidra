import { app } from 'electron';
import log from 'electron-log/main';

import { errorMessage } from './utils';

// @holusion/dbus-next is bare-required because this module only loads on Linux
const dbus = require('@holusion/dbus-next');

const daemonLog = log.scope('notificationDaemon');

const NOTIFICATIONS_NAME = 'org.freedesktop.Notifications';
const DBUS_NAME = 'org.freedesktop.DBus';
const DBUS_PATH = '/org/freedesktop/DBus';

const OWNER_MATCH_RULE = [
  "type='signal'",
  `sender='${DBUS_NAME}'`,
  `interface='${DBUS_NAME}'`,
  "member='NameOwnerChanged'",
  `path='${DBUS_PATH}'`,
  `arg0='${NOTIFICATIONS_NAME}'`,
].join(',');

interface DbusMessage {
  member?: string;
  body?: unknown[];
}

// Module-level bus reference for graceful shutdown
let bus: InstanceType<typeof dbus.MessageBus> | null = null;

// Typed interface for dbus-next internal socket access.
// Verified against @holusion/dbus-next 0.11.2.
interface DbusMessageBusInternals {
  _connection?: {
    stream?: {
      destroy: () => void;
    };
  };
}

function disconnectBus(): void {
  if (bus) {
    daemonLog.info('disconnecting from D-Bus');
    // bus.disconnect() calls stream.end() which only half-closes the socket.
    // Force-destroy the underlying stream to release the event loop handle.
    const stream = (bus as DbusMessageBusInternals)._connection?.stream;
    bus.disconnect();
    if (stream && typeof stream.destroy === 'function') {
      stream.destroy();
    }
    bus = null;
  }
}

// A plain method call, never a proxy object: building a proxy on
// org.freedesktop.Notifications would trigger service activation, which is the
// 25 second block this probe exists to avoid.
function dbusCall(member: string, argument: string): Promise<DbusMessage | null> {
  return bus.call(new dbus.Message({
    destination: DBUS_NAME,
    path: DBUS_PATH,
    interface: DBUS_NAME,
    member,
    signature: 's',
    body: [argument],
  }));
}

export function initDaemonProbe(onOwnerChange: (hasOwner: boolean) => void): void {
  try {
    bus = dbus.sessionBus();
  } catch (err: unknown) {
    daemonLog.warn('no session bus; notifications disabled:', errorMessage(err));
    return;
  }

  bus.on('error', (err: Error) => {
    daemonLog.warn('D-Bus connection error:', err.message);
  });

  app.on('will-quit', () => {
    disconnectBus();
  });

  bus.on('message', (msg: DbusMessage) => {
    if (msg.member !== 'NameOwnerChanged') return;
    const body = msg.body ?? [];
    if (body[0] !== NOTIFICATIONS_NAME) return;
    const hasOwner = typeof body[2] === 'string' && body[2] !== '';
    daemonLog.info(hasOwner
      ? 'notification daemon appeared; notifications enabled'
      : 'notification daemon vanished; notifications disabled');
    onOwnerChange(hasOwner);
  });

  // AddMatch is sent before NameHasOwner, so an owner change cannot slip
  // through between the probe reply and the subscription taking effect.
  dbusCall('AddMatch', OWNER_MATCH_RULE).catch((err: unknown) => {
    daemonLog.warn('failed to watch for notification daemon changes:', errorMessage(err));
  });

  dbusCall('NameHasOwner', NOTIFICATIONS_NAME).then((reply: DbusMessage | null) => {
    const hasOwner = Boolean(reply?.body?.[0]);
    daemonLog.info(hasOwner
      ? 'notification daemon present; notifications enabled'
      : 'no notification daemon; notifications disabled');
    onOwnerChange(hasOwner);
  }).catch((err: unknown) => {
    daemonLog.warn('notification daemon probe failed; notifications disabled:', errorMessage(err));
  });
}
