import { app } from 'electron';
import log from 'electron-log/main';
import { Message, MessageType, MessageFlag, Variant, sessionBus } from '@holusion/dbus-next';
import type { MessageBus } from '@holusion/dbus-next';
import type { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { getAssetPath } from './paths';

const NAME = 'org.freedesktop.Notifications';
const PATH = '/org/freedesktop/Notifications';
const BUS_NAME = 'org.freedesktop.DBus';
const BUS_PATH = '/org/freedesktop/DBus';
const DELIVERY_TIMEOUT_MS = 5000;
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
  let notificationId = 0;
  let onAction: TrackNotification['onAction'] | null = null;
  let pending = Promise.resolve();
  let blockedOwner: string | null = null;
  let cancelDelivery: (() => void) | null = null;

  const dispose = async (): Promise<void> => {
    generation++;
    cancelDelivery?.();
    const previousOwner = owner;
    const previousId = notificationId;
    owner = '';
    notificationId = 0;
    onAction = null;
    if (!bus) return;
    const connection = bus;
    bus = null;
    (connection as unknown as EventEmitter).removeListener('message', onMessage);
    if (previousOwner && previousId) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          connection.call(new Message({
            destination: previousOwner, path: PATH, interface: NAME,
            member: 'CloseNotification', signature: 'u', body: [previousId],
            flags: MessageFlag.NO_AUTO_START,
          })),
          new Promise<void>((resolve) => { timeout = setTimeout(resolve, 500); }),
        ]);
      } catch {
        notificationLog.warn('track notification cleanup unavailable');
      } finally {
        clearTimeout(timeout);
      }
    }
    connection.disconnect();
    // disconnect() only half-closes the socket in dbus-next 0.11.2.
    (connection as unknown as BusInternals)._connection?.stream?.destroy();
  };

  const onError = (): void => {
    if (!bus) return;
    notificationLog.warn('notification bus unavailable');
    notificationId = 0;
    void dispose();
  };

  const onMessage = (message: Message): void => {
    if (message.type !== MessageType.SIGNAL) return;
    if (message.sender === BUS_NAME && message.interface === BUS_NAME
      && message.path === BUS_PATH && message.member === 'NameOwnerChanged'
      && message.body[0] === NAME) {
      generation++;
      cancelDelivery?.();
      blockedOwner = null;
      owner = typeof message.body[2] === 'string' ? message.body[2] : '';
      notificationId = 0;
      onAction = null;
      return;
    }
    if (!owner || message.sender !== owner || message.interface !== NAME || message.path !== PATH) return;
    const id: unknown = message.body[0];
    if (typeof id !== 'number') return;
    if (message.member === 'NotificationClosed') {
      if (id === notificationId) {
        notificationId = 0;
        onAction = null;
      }
    } else if (message.member === 'ActionInvoked') {
      const action: unknown = message.body[1];
      if (action === 'previous' || action === 'next' || action === 'default') {
        if (id === notificationId) onAction?.(action);
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
      void dispose();
    }
  })();

  const deliver = async (
    notification: TrackNotification,
    isCurrent: () => boolean,
    operation: { active: boolean; notifyOwner: string | null },
  ): Promise<void> => {
    await ready;
    if (!operation.active || !bus || !isCurrent()) return;
    const currentGeneration = generation;
    try {
      const reply = await call(BUS_NAME, 'GetNameOwner', 's', [NAME]);
      const currentOwner: unknown = reply?.body[0];
      if (typeof currentOwner !== 'string' || !currentOwner.startsWith(':')) return;
      if (!operation.active || !bus || generation !== currentGeneration || !isCurrent()) return;
      if (blockedOwner === currentOwner) return;
      if (owner !== currentOwner) {
        notificationId = 0;
        onAction = null;
      }
      owner = currentOwner;
      const capabilities = await call(owner, 'GetCapabilities');
      if (!operation.active || !bus || generation !== currentGeneration || !isCurrent()) return;
      const actions = Array.isArray(capabilities?.body[0]) && capabilities.body[0].includes('actions');
      const hints: Record<string, Variant> = {
        'suppress-sound': new Variant('b', true),
        transient: new Variant('b', true),
        'desktop-entry': new Variant('s', app.getName().toLowerCase()),
      };
      if (notification.icon) hints['image-path'] = new Variant('s', pathToFileURL(notification.icon).href);
      onAction = null;
      operation.notifyOwner = owner;
      const result = await call(owner, 'Notify', 'susssasa{sv}i', [
        app.getName(), notificationId, getAssetPath('assets', 'sidra-logo.png'), notification.title,
        Array.isArray(capabilities?.body[0]) && capabilities.body[0].includes('body-markup')
          ? notification.body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          : notification.body,
        actions ? ['default', '', 'previous', notification.previous, 'next', notification.next] : [],
        hints, -1,
      ]);
      if (!operation.active || !bus || generation !== currentGeneration) return;
      const id: unknown = result?.body[0];
      if (typeof id === 'number' && Number.isInteger(id) && id > 0) {
        notificationId = id;
        onAction = actions ? notification.onAction : null;
      }
    } catch {
      if (!operation.active || generation !== currentGeneration) return;
      if (operation.notifyOwner) blockedOwner = operation.notifyOwner;
      // A failed reply does not prove that Notify failed to display the track.
      notificationLog.warn('track notification unavailable');
    }
  };

  const show = (notification: TrackNotification, isCurrent: () => boolean): Promise<void> => {
    pending = pending.then(async () => {
      const operation = { active: true, notifyOwner: null as string | null };
      let cancel!: () => void;
      const cancelled = new Promise<void>((resolve) => {
        cancel = () => { operation.active = false; resolve(); };
      });
      cancelDelivery = cancel;
      const timeout = setTimeout(() => {
        if (operation.notifyOwner) blockedOwner = operation.notifyOwner;
        cancel();
        notificationLog.warn('track notification delivery timed out');
      }, DELIVERY_TIMEOUT_MS);
      try {
        await Promise.race([deliver(notification, isCurrent, operation), cancelled]);
      } finally {
        operation.active = false;
        clearTimeout(timeout);
        if (cancelDelivery === cancel) cancelDelivery = null;
      }
    });
    return pending;
  };

  return { show, dispose };
}
