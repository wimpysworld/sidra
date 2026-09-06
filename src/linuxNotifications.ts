import { app } from 'electron';
import log from 'electron-log/main';
import { Message, MessageType, MessageFlag, Variant, sessionBus } from '@holusion/dbus-next';
import type { MessageBus } from '@holusion/dbus-next';
import type { EventEmitter } from 'node:events';

const NAME = 'org.freedesktop.Notifications';
const PATH = '/org/freedesktop/Notifications';
const BUS_NAME = 'org.freedesktop.DBus';
const BUS_PATH = '/org/freedesktop/DBus';
const notificationLog = log.scope('linuxNotifications');

export interface TrackNotification {
  title: string;
  body: string;
  icon?: string;
  previous: string;
  next: string;
  onAction: (action: 'previous' | 'next' | 'default') => void;
}

interface BusInternals {
  _connection?: { stream?: { destroy: () => void } };
}

/** Linux-only delivery, loaded after the platform check in the integration. */
export function createLinuxNotifications() {
  let bus: MessageBus | null = null;
  let owner = '';
  let generation = 0;
  const notifications = new Map<number, TrackNotification['onAction']>();

  const dispose = (): void => {
    generation++;
    owner = '';
    notifications.clear();
    if (!bus) return;
    const connection = bus;
    bus = null;
    (connection as unknown as EventEmitter).removeListener('message', onMessage);
    connection.disconnect();
    // disconnect() only half-closes the socket in dbus-next 0.11.2.
    (connection as unknown as BusInternals)._connection?.stream?.destroy();
  };

  const onError = (): void => {
    if (!bus) return;
    notificationLog.warn('notification bus unavailable');
    dispose();
  };

  const onMessage = (message: Message): void => {
    if (message.type !== MessageType.SIGNAL) return;
    if (message.sender === BUS_NAME && message.interface === BUS_NAME
      && message.path === BUS_PATH && message.member === 'NameOwnerChanged'
      && message.body[0] === NAME) {
      generation++;
      owner = typeof message.body[2] === 'string' ? message.body[2] : '';
      notifications.clear();
      return;
    }
    if (!owner || message.sender !== owner || message.interface !== NAME || message.path !== PATH) return;
    const id: unknown = message.body[0];
    if (typeof id !== 'number') return;
    if (message.member === 'NotificationClosed') {
      notifications.delete(id);
    } else if (message.member === 'ActionInvoked') {
      const action: unknown = message.body[1];
      if (action === 'previous' || action === 'next' || action === 'default') {
        notifications.get(id)?.(action);
      }
    }
  };

  const call = (destination: string, member: string, signature = '', body: unknown[] = []) => {
    if (!bus) return Promise.reject(new Error('Notification bus unavailable'));
    return bus.call(new Message({
      destination,
      path: destination === BUS_NAME ? BUS_PATH : PATH,
      interface: destination === BUS_NAME ? BUS_NAME : NAME,
      member, signature, body,
      flags: MessageFlag.NO_AUTO_START,
    }));
  };

  const ready = (async () => {
    try {
      bus = sessionBus();
      bus.on('message', onMessage);
      bus.on('error', onError);
      await call(BUS_NAME, 'AddMatch', 's', [
        `type='signal',sender='${BUS_NAME}',interface='${BUS_NAME}',member='NameOwnerChanged',path='${BUS_PATH}',arg0='${NAME}'`,
      ]);
      await call(BUS_NAME, 'AddMatch', 's', [
        `type='signal',sender='${NAME}',interface='${NAME}',path='${PATH}'`,
      ]);
    } catch {
      notificationLog.warn('notification bus unavailable');
      dispose();
    }
  })();

  const show = async (notification: TrackNotification, isCurrent: () => boolean): Promise<void> => {
    await ready;
    if (!bus || !isCurrent()) return;
    const currentGeneration = generation;
    try {
      const reply = await call(BUS_NAME, 'GetNameOwner', 's', [NAME]);
      const currentOwner: unknown = reply?.body[0];
      if (typeof currentOwner !== 'string' || !currentOwner.startsWith(':')) return;
      if (!bus || generation !== currentGeneration || !isCurrent()) return;
      if (owner !== currentOwner) notifications.clear();
      owner = currentOwner;
      const capabilities = await call(owner, 'GetCapabilities');
      if (!bus || generation !== currentGeneration || !isCurrent()) return;
      const actions = Array.isArray(capabilities?.body[0]) && capabilities.body[0].includes('actions');
      const result = await call(owner, 'Notify', 'susssasa{sv}i', [
        app.getName(), 0, notification.icon ?? '', notification.title,
        Array.isArray(capabilities?.body[0]) && capabilities.body[0].includes('body-markup')
          ? notification.body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          : notification.body,
        actions ? ['default', '', 'previous', notification.previous, 'next', notification.next] : [],
        { 'suppress-sound': new Variant('b', true), 'desktop-entry': new Variant('s', 'sidra') }, -1,
      ]);
      if (!bus || generation !== currentGeneration) return;
      const id: unknown = result?.body[0];
      if (actions && typeof id === 'number' && Number.isInteger(id) && id > 0) {
        notifications.set(id, notification.onAction);
      }
    } catch {
      // A failed reply does not prove that Notify failed to display the track.
      notificationLog.warn('track notification unavailable');
    }
  };

  return { show, dispose };
}
