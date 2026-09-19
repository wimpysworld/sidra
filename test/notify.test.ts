import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Module from 'node:module';
import type { Notification } from 'electron';
import { MessageFlag, MessageType, sessionBus } from '@holusion/dbus-next';
import { setPlatform, restorePlatform } from './mocks/platform';

vi.mock('@holusion/dbus-next', async (importOriginal) => ({
  ...await importOriginal<typeof import('@holusion/dbus-next')>(),
  sessionBus: vi.fn(),
}));

interface DbusMessage {
  type?: MessageType;
  sender?: string;
  interface?: string;
  path?: string;
  member?: string;
  body?: unknown[];
  flags?: MessageFlag;
}

type BusListener = (msg: DbusMessage) => void;

const busStub = {
  on: vi.fn<(event: string, listener: BusListener) => void>(),
  call: vi.fn<(msg: DbusMessage) => Promise<DbusMessage | null>>(),
  disconnect: vi.fn(),
};

/** The owner that the stubbed bus gives to the GetNameOwner probe. */
let probeOwner = '';

/**
 * Routes initNotificationProbe()'s Node require to the real Linux adapter module with its stubbed bus.
 * Module._load needs patching because Node require bypasses Vitest's module registry and cannot resolve the TypeScript file.
 */
const moduleApi = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const realLoad = moduleApi._load;
let linuxModule: typeof import('../src/linuxNotifications') | null = null;
/** Makes the lazy require of the Linux adapter module throw, as a packaging fault would. */
let adapterLoadFails = false;

/** The 'failed' listeners src/notify.ts attached to the notifications it built. */
const failedListeners: Array<(event: unknown, error: string) => void> = [];

interface FakeNotification {
  on: (event: string, listener: (event: unknown, error: string) => void) => FakeNotification;
}

// src/notify.ts calls `new Notification(...)`, and Vitest constructs the
// implementation it is given with the mock as the prototype source. So the
// stand-in is a plain function assigning its own `on`, not an arrow function
// (not constructible) and not a class (its prototype methods are lost).
function buildFakeNotification(this: FakeNotification): void {
  this.on = (event, listener) => {
    if (event === 'failed') failedListeners.push(listener);
    return this;
  };
}

interface Loaded {
  notify: typeof import('../src/notify');
  NotificationMock: ReturnType<typeof vi.mocked<typeof Notification>>;
}

/**
 * Loads a fresh notification gate after setting the platform.
 * The module reads process.platform at import and retains failure state, so each test needs its own copy.
 */
async function loadNotify(platform: NodeJS.Platform): Promise<Loaded> {
  setPlatform(platform);
  vi.resetModules();
  failedListeners.length = 0;

  linuxModule = await import('../src/linuxNotifications');
  const electron = await import('electron');
  const NotificationMock = vi.mocked(electron.Notification);
  NotificationMock.mockReset();
  NotificationMock.mockImplementation(
    buildFakeNotification as unknown as (...args: ConstructorParameters<typeof Notification>) => Notification,
  );

  const notify = await import('../src/notify');
  return { notify, NotificationMock };
}

/** Runs after the probe's already-resolved promises have settled. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** The listener src/linuxNotifications.ts attached for D-Bus signals. */
function messageListener(): BusListener {
  const registration = busStub.on.mock.calls.find(([event]) => event === 'message');
  if (!registration) throw new Error('no message listener registered');
  return registration[1];
}

/** Delivers a NameOwnerChanged signal for the notifications name. */
function announceOwner(newOwner: string): void {
  messageListener()({
    type: MessageType.SIGNAL,
    sender: 'org.freedesktop.DBus',
    interface: 'org.freedesktop.DBus',
    path: '/org/freedesktop/DBus',
    member: 'NameOwnerChanged',
    body: ['org.freedesktop.Notifications', probeOwner, newOwner],
  });
  probeOwner = newOwner;
}

const OPTIONS = { title: 'Blue Monday', body: 'New Order' };

beforeEach(() => {
  vi.clearAllMocks();
  probeOwner = '';
  linuxModule = null;
  adapterLoadFails = false;
  busStub.call.mockImplementation((msg) => {
    if (msg.member === 'GetNameOwner') {
      return probeOwner
        ? Promise.resolve({ body: [probeOwner] })
        : Promise.reject(new Error('Name has no owner'));
    }
    return Promise.resolve({ body: [] });
  });
  vi.mocked(sessionBus).mockReturnValue(busStub as unknown as ReturnType<typeof sessionBus>);
  moduleApi._load = (request, parent, isMain) => {
    if (request !== './linuxNotifications') {
      return Reflect.apply(realLoad, Module, [request, parent, isMain]);
    }
    if (adapterLoadFails) throw new Error('cannot find module');
    return linuxModule;
  };
});

afterEach(() => {
  moduleApi._load = realLoad;
  restorePlatform();
});

describe('notification gate on Linux', () => {
  it('starts closed before the probe replies', async () => {
    const { notify } = await loadNotify('linux');

    expect(notify.notificationsAvailable()).toBe(false);
  });

  it('suppresses notifications when the probe reports no owner', async () => {
    const { notify, NotificationMock } = await loadNotify('linux');
    probeOwner = '';

    notify.initNotificationProbe();
    await flush();

    expect(notify.createNotification(OPTIONS)).toBeNull();
    expect(NotificationMock).not.toHaveBeenCalled();
  });

  it('allows notifications when the probe reports an owner', async () => {
    const { notify, NotificationMock } = await loadNotify('linux');
    probeOwner = ':1.42';

    notify.initNotificationProbe();
    await flush();

    expect(notify.createNotification(OPTIONS)).not.toBeNull();
    expect(NotificationMock).toHaveBeenCalledTimes(1);
    expect(NotificationMock).toHaveBeenCalledWith(OPTIONS);
  });

  // AddMatch must go first, or an owner change can slip through between the
  // probe reply and the subscription taking effect.
  it('sends AddMatch before it probes the notifications name', async () => {
    const { notify } = await loadNotify('linux');

    notify.initNotificationProbe();
    await flush();

    const calls = busStub.call.mock.calls.map(([msg]) => msg);
    expect(calls.map((msg) => msg.member)).toEqual(['AddMatch', 'AddMatch', 'GetNameOwner']);
    expect(calls[2].body).toEqual(['org.freedesktop.Notifications']);
    expect(calls.every((msg) => msg.flags === MessageFlag.NO_AUTO_START)).toBe(true);
    expect(sessionBus).toHaveBeenCalledOnce();
    expect(linuxModule?.createLinuxNotifications()).toBe(linuxModule?.createLinuxNotifications());
    expect(sessionBus).toHaveBeenCalledOnce();
  });

  it('opens the gate when NameOwnerChanged reports a new owner', async () => {
    const { notify } = await loadNotify('linux');
    probeOwner = '';

    notify.initNotificationProbe();
    await flush();
    expect(notify.createNotification(OPTIONS)).toBeNull();

    announceOwner(':1.42');

    expect(notify.createNotification(OPTIONS)).not.toBeNull();
  });

  it('closes the gate when NameOwnerChanged reports an empty new owner', async () => {
    const { notify } = await loadNotify('linux');
    probeOwner = ':1.42';

    notify.initNotificationProbe();
    await flush();
    expect(notify.createNotification(OPTIONS)).not.toBeNull();

    announceOwner('');

    expect(notify.createNotification(OPTIONS)).toBeNull();
  });

  it('latches the gate closed when a notification fails', async () => {
    const { notify } = await loadNotify('linux');
    probeOwner = ':1.42';

    notify.initNotificationProbe();
    await flush();
    expect(notify.createNotification(OPTIONS)).not.toBeNull();

    failedListeners[0](null, 'no daemon');

    expect(notify.notificationsAvailable()).toBe(false);
    expect(notify.createNotification(OPTIONS)).toBeNull();
  });

  it('clears the latch when a daemon appears', async () => {
    const { notify } = await loadNotify('linux');
    probeOwner = ':1.42';

    notify.initNotificationProbe();
    await flush();
    notify.createNotification(OPTIONS);
    failedListeners[0](null, 'no daemon');
    expect(notify.createNotification(OPTIONS)).toBeNull();

    announceOwner(':1.42');

    expect(notify.createNotification(OPTIONS)).not.toBeNull();
  });

  it('leaves the gate closed when the session bus cannot be opened', async () => {
    const { notify } = await loadNotify('linux');
    vi.mocked(sessionBus).mockImplementation(() => {
      throw new Error('no session bus');
    });

    expect(() => notify.initNotificationProbe()).not.toThrow();
    await flush();

    expect(notify.createNotification(OPTIONS)).toBeNull();
  });

  // The adapter's own catch cannot cover a module that never loads, so this is
  // the case that guards the try/catch in src/notify.ts. initNotificationProbe
  // runs during app bootstrap, where a throw would take the launch with it.
  it('leaves the gate closed when the adapter module cannot be loaded', async () => {
    const { notify } = await loadNotify('linux');
    adapterLoadFails = true;

    expect(() => notify.initNotificationProbe()).not.toThrow();
    await flush();

    expect(notify.createNotification(OPTIONS)).toBeNull();
  });

  // Test the adapter directly so the gate's catch cannot hide an escaping error.
  it('closes ownership without throwing when the session bus cannot be opened', async () => {
    await loadNotify('linux');
    vi.mocked(sessionBus).mockImplementation(() => {
      throw new Error('no session bus');
    });
    const onOwnerChange = vi.fn();

    expect(() => linuxModule?.createLinuxNotifications(onOwnerChange)).not.toThrow();
    await flush();

    expect(onOwnerChange).toHaveBeenCalledWith(false);
  });
});

describe('notification gate off Linux', () => {
  it('is open before any probe runs and opens no bus', async () => {
    const { notify, NotificationMock } = await loadNotify('darwin');

    expect(notify.notificationsAvailable()).toBe(true);

    notify.initNotificationProbe();
    await flush();

    expect(sessionBus).not.toHaveBeenCalled();
    expect(notify.createNotification(OPTIONS)).not.toBeNull();
    expect(NotificationMock).toHaveBeenCalledTimes(1);
  });

  // Only Linux receives NameOwnerChanged to clear failure state. Other platforms must keep notifications available after a failure.
  it('does not latch closed when a notification fails', async () => {
    const { notify } = await loadNotify('darwin');

    expect(notify.createNotification(OPTIONS)).not.toBeNull();
    failedListeners[0](null, 'delivery failed');

    expect(notify.notificationsAvailable()).toBe(true);
    expect(notify.createNotification(OPTIONS)).not.toBeNull();
  });
});
