import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Module from 'node:module';
import type { Notification } from 'electron';
import { setPlatform, restorePlatform } from './mocks/platform';

interface DbusMessage {
  member?: string;
  body?: unknown[];
}

type BusListener = (msg: DbusMessage) => void;

interface DbusBus {
  on: (event: string, listener: BusListener) => void;
  call: (msg: DbusMessage) => Promise<DbusMessage | null>;
}

interface DbusModule {
  sessionBus: () => DbusBus;
}

// src/notificationDaemon.ts pulls @holusion/dbus-next in with a bare require,
// which vi.mock does not intercept. The module loads fine off a bus - only
// sessionBus() opens a socket - so the real one is loaded and that single entry
// point is stubbed. Every case here runs against this stub; no live bus.
const dbus = require('@holusion/dbus-next') as DbusModule;

const busStub = {
  on: vi.fn<(event: string, listener: BusListener) => void>(),
  call: vi.fn<(msg: DbusMessage) => Promise<DbusMessage | null>>(),
};

/** The answer the stubbed bus gives to the NameHasOwner probe. */
let probeOwner = false;

/**
 * src/notify.ts lazy-requires ./notificationDaemon inside initNotificationProbe.
 * That is a real Node require, so it reaches neither Vitest's module registry
 * nor a .ts file, and vi.mock cannot see it. Patching Module._load hands the
 * real daemon module - freshly imported, running against the bus stub - to the
 * gate, so both modules are exercised together as they are in production.
 */
const moduleApi = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const realLoad = moduleApi._load;
let daemonModule: typeof import('../src/notificationDaemon') | null = null;
/** Makes the lazy require of the daemon module throw, as a packaging fault would. */
let daemonLoadFails = false;

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
 * The gate is module-level state in src/notify.ts, and that module reads
 * process.platform at load, so every case forces the platform, resets the
 * registry and re-imports. Without the reset the previous case's latch leaks
 * into the next one.
 */
async function loadNotify(platform: NodeJS.Platform): Promise<Loaded> {
  setPlatform(platform);
  vi.resetModules();
  failedListeners.length = 0;

  daemonModule = await import('../src/notificationDaemon');
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

/** The listener src/notificationDaemon.ts attached for NameOwnerChanged. */
function messageListener(): BusListener {
  const registration = busStub.on.mock.calls.find(([event]) => event === 'message');
  if (!registration) throw new Error('no message listener registered');
  return registration[1];
}

/** Delivers a NameOwnerChanged signal for the notifications name. */
function announceOwner(newOwner: string): void {
  messageListener()({
    member: 'NameOwnerChanged',
    body: ['org.freedesktop.Notifications', '', newOwner],
  });
}

const OPTIONS = { title: 'Blue Monday', body: 'New Order' };

beforeEach(() => {
  vi.clearAllMocks();
  probeOwner = false;
  daemonModule = null;
  daemonLoadFails = false;
  busStub.call.mockImplementation((msg) =>
    Promise.resolve(msg.member === 'NameHasOwner' ? { body: [probeOwner] } : null));
  vi.spyOn(dbus, 'sessionBus').mockReturnValue(busStub);
  moduleApi._load = (request, parent, isMain) => {
    if (!request.endsWith('notificationDaemon')) {
      return Reflect.apply(realLoad, Module, [request, parent, isMain]);
    }
    if (daemonLoadFails) throw new Error('cannot find module');
    return daemonModule;
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
    probeOwner = false;

    notify.initNotificationProbe();
    await flush();

    expect(notify.createNotification(OPTIONS)).toBeNull();
    expect(NotificationMock).not.toHaveBeenCalled();
  });

  it('allows notifications when the probe reports an owner', async () => {
    const { notify, NotificationMock } = await loadNotify('linux');
    probeOwner = true;

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

    const members = busStub.call.mock.calls.map(([msg]) => msg.member);
    expect(members).toEqual(['AddMatch', 'NameHasOwner']);
    expect(busStub.call.mock.calls[1][0].body).toEqual(['org.freedesktop.Notifications']);
  });

  it('opens the gate when NameOwnerChanged reports a new owner', async () => {
    const { notify } = await loadNotify('linux');
    probeOwner = false;

    notify.initNotificationProbe();
    await flush();
    expect(notify.createNotification(OPTIONS)).toBeNull();

    announceOwner(':1.42');

    expect(notify.createNotification(OPTIONS)).not.toBeNull();
  });

  it('closes the gate when NameOwnerChanged reports an empty new owner', async () => {
    const { notify } = await loadNotify('linux');
    probeOwner = true;

    notify.initNotificationProbe();
    await flush();
    expect(notify.createNotification(OPTIONS)).not.toBeNull();

    announceOwner('');

    expect(notify.createNotification(OPTIONS)).toBeNull();
  });

  it('latches the gate closed when a notification fails', async () => {
    const { notify } = await loadNotify('linux');
    probeOwner = true;

    notify.initNotificationProbe();
    await flush();
    expect(notify.createNotification(OPTIONS)).not.toBeNull();

    failedListeners[0](null, 'no daemon');

    expect(notify.notificationsAvailable()).toBe(false);
    expect(notify.createNotification(OPTIONS)).toBeNull();
  });

  it('clears the latch when a daemon appears', async () => {
    const { notify } = await loadNotify('linux');
    probeOwner = true;

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
    vi.mocked(dbus.sessionBus).mockImplementation(() => {
      throw new Error('no session bus');
    });

    expect(() => notify.initNotificationProbe()).not.toThrow();
    await flush();

    expect(notify.createNotification(OPTIONS)).toBeNull();
  });

  // The daemon's own catch cannot cover a module that never loads, so this is
  // the case that guards the try/catch in src/notify.ts. initNotificationProbe
  // runs during app bootstrap, where a throw would take the launch with it.
  it('leaves the gate closed when the daemon module cannot be loaded', async () => {
    const { notify } = await loadNotify('linux');
    daemonLoadFails = true;

    expect(() => notify.initNotificationProbe()).not.toThrow();
    await flush();

    expect(notify.createNotification(OPTIONS)).toBeNull();
  });

  // The gate has its own try/catch, so this asserts the daemon swallows the
  // throw itself rather than relying on its caller to do it.
  it('does not throw out of the probe when the session bus cannot be opened', async () => {
    await loadNotify('linux');
    vi.mocked(dbus.sessionBus).mockImplementation(() => {
      throw new Error('no session bus');
    });
    const onOwnerChange = vi.fn();

    expect(() => daemonModule?.initDaemonProbe(onOwnerChange)).not.toThrow();

    expect(onOwnerChange).not.toHaveBeenCalled();
  });
});

describe('notification gate off Linux', () => {
  it('is open before any probe runs and opens no bus', async () => {
    const { notify, NotificationMock } = await loadNotify('darwin');

    expect(notify.notificationsAvailable()).toBe(true);

    notify.initNotificationProbe();
    await flush();

    expect(dbus.sessionBus).not.toHaveBeenCalled();
    expect(notify.createNotification(OPTIONS)).not.toBeNull();
    expect(NotificationMock).toHaveBeenCalledTimes(1);
  });

  // NameOwnerChanged is the only way back from a latch, and it exists on Linux
  // alone; latching here would kill notifications for the rest of the session.
  it('does not latch closed when a notification fails', async () => {
    const { notify } = await loadNotify('darwin');

    expect(notify.createNotification(OPTIONS)).not.toBeNull();
    failedListeners[0](null, 'delivery failed');

    expect(notify.notificationsAvailable()).toBe(true);
    expect(notify.createNotification(OPTIONS)).not.toBeNull();
  });
});
