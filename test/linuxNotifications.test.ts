import { EventEmitter } from 'node:events';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Message, MessageFlag, MessageType, sessionBus } from '@holusion/dbus-next';
import { createLinuxNotifications } from '../src/linuxNotifications';
import { getAssetPath } from '../src/paths';

vi.mock('@holusion/dbus-next', async (importOriginal) => ({
  ...await importOriginal<typeof import('@holusion/dbus-next')>(),
  sessionBus: vi.fn(),
}));

const NAME = 'org.freedesktop.Notifications';
const PATH = '/org/freedesktop/Notifications';
const BUS_NAME = 'org.freedesktop.DBus';
let bus: EventEmitter & {
  call: ReturnType<typeof vi.fn<(message: Message) => Promise<{ body: unknown[] }>>>;
  disconnect: ReturnType<typeof vi.fn>;
  _connection: { stream: { destroy: ReturnType<typeof vi.fn> } };
};
let adapter: ReturnType<typeof createLinuxNotifications>;
let owner: string;
let capabilities: string[];
let nextId: number;
const onAction = vi.fn();
const track = () => ({ title: 'Song', body: 'Artist & <Album>', icon: '/tmp/art.jpg', previous: 'Zurück', next: 'Weiter', playbackAction: 'play' as const, playbackLabel: 'Abspielen', onAction });
const current = () => true;

function signal(member: string, body: unknown[], sender = owner): void {
  bus.emit('message', new Message({ type: MessageType.SIGNAL, sender, interface: NAME, path: PATH, member, body }));
}

function replaceOwner(newOwner: string): void {
  bus.emit('message', new Message({
    type: MessageType.SIGNAL, sender: BUS_NAME, interface: BUS_NAME,
    path: '/org/freedesktop/DBus', member: 'NameOwnerChanged', body: [NAME, owner, newOwner],
  }));
  owner = newOwner;
}

function notifyCalls(): Message[] {
  return bus.call.mock.calls.map(([message]) => message as Message).filter((message) => message.member === 'Notify');
}

beforeEach(() => {
  vi.clearAllMocks();
  owner = ':1.42';
  capabilities = ['actions', 'body-markup'];
  nextId = 1;
  bus = Object.assign(new EventEmitter(), {
    call: vi.fn(async (message: Message) => {
      if (message.member === 'GetNameOwner') {
        if (!owner) throw new Error('No owner');
        return { body: [owner] };
      }
      if (message.member === 'GetCapabilities') return { body: [capabilities] };
      if (message.member === 'Notify') return { body: [message.body[1] || nextId++] };
      return { body: [] };
    }),
    disconnect: vi.fn(),
    _connection: { stream: { destroy: vi.fn() } },
  });
  vi.mocked(sessionBus).mockReturnValue(bus as unknown as ReturnType<typeof sessionBus>);
  adapter = createLinuxNotifications();
});

afterEach(() => adapter.dispose());

describe('Linux track notifications', () => {
  it('sends localised named actions, artwork and silent hints without service activation', async () => {
    await adapter.show(track(), current);
    const [message] = notifyCalls();
    expect(message.destination).toBe(owner);
    expect(message.signature).toBe('susssasa{sv}i');
    expect(message.flags).toBe(MessageFlag.NO_AUTO_START);
    expect(message.body.slice(0, 6)).toEqual([
      'Sidra', 0, getAssetPath('assets', 'sidra-logo.png'), 'Song', 'Artist &amp; &lt;Album&gt;',
      ['default', '', 'play', 'Abspielen', 'previous', 'Zurück', 'next', 'Weiter'],
    ]);
    expect(message.body[6]['suppress-sound'].value).toBe(true);
    expect(message.body[6].transient.signature).toBe('b');
    expect(message.body[6].transient.value).toBe(true);
    expect(message.body[7]).toBe(-1);
    expect(message.body[6]['desktop-entry'].value).toBe('sidra');
    expect(message.body[6]['image-path'].signature).toBe('s');
    expect(message.body[6]['image-path'].value).toBe('file:///tmp/art.jpg');
  });

  it('encodes artwork paths with spaces, non-ASCII characters and URI delimiters', async () => {
    await adapter.show({ ...track(), icon: '/tmp/Album art/Björk #1%.jpg' }, current);
    expect(notifyCalls()[0].body[6]['image-path'].value)
      .toBe('file:///tmp/Album%20art/Bj%C3%B6rk%20%231%25.jpg');
  });

  it('keeps the application icon without an artwork hint when artwork is absent', async () => {
    await adapter.show({ ...track(), icon: undefined }, current);
    const [message] = notifyCalls();
    expect(message.body[2]).toBe(getAssetPath('assets', 'sidra-logo.png'));
    expect(message.body[6]).not.toHaveProperty('image-path');
    expect(message.body[6]['desktop-entry'].value).toBe('sidra');
    signal('ActionInvoked', [1, 'next']);
    expect(onAction).toHaveBeenCalledExactlyOnceWith('next');
  });

  it('routes only known actions for an active id from the current daemon', async () => {
    await adapter.show(track(), current);
    signal('ActionInvoked', [1, 'previous']);
    signal('ActionInvoked', [1, 'next']);
    signal('ActionInvoked', [1, 'default']);
    signal('ActionInvoked', [1, 'play']);
    signal('ActionInvoked', [1, 'pause']);
    signal('ActionInvoked', [1, 'quit']);
    signal('ActionInvoked', [2, 'next']);
    signal('ActionInvoked', ['1', 'next']);
    signal('ActionInvoked', [1, 'next'], ':1.99');
    expect(onAction.mock.calls).toEqual([['previous'], ['next'], ['default'], ['play'], ['pause']]);
  });

  it('refreshes a playback button only on an existing notification with actions', async () => {
    await adapter.show(track(), current);
    await adapter.show({ ...track(), playbackAction: 'pause', playbackLabel: 'Pause' }, current, true);
    expect(notifyCalls()[1].body[1]).toBe(1);
    expect(notifyCalls()[1].body[5]).toEqual(['default', '', 'pause', 'Pause', 'previous', 'Zurück', 'next', 'Weiter']);
    capabilities = [];
    await adapter.show(track(), current, true);
    expect(notifyCalls()).toHaveLength(2);
    signal('NotificationClosed', [1, 2]);
    await adapter.show(track(), current, true);
    expect(notifyCalls()).toHaveLength(2);
  });

  it('does not turn a queued state refresh into a new notification after daemon replacement', async () => {
    let resolveNotify!: (reply: { body: unknown[] }) => void;
    const original = bus.call.getMockImplementation()!;
    bus.call.mockImplementation((message: Message) => {
      if (message.member === 'Notify') return new Promise(resolve => { resolveNotify = resolve; });
      return original(message);
    });
    const first = adapter.show(track(), current);
    await vi.waitFor(() => expect(notifyCalls()).toHaveLength(1));
    const refreshing = adapter.show(track(), current, true);
    replaceOwner(':1.43');
    await Promise.all([first, refreshing]);
    resolveNotify({ body: [1] });
    expect(notifyCalls()).toHaveLength(1);
  });

  it('forgets the closed playback notification and ignores unrelated closed ids', async () => {
    await adapter.show(track(), current);
    signal('NotificationClosed', [99, 2]);
    signal('ActionInvoked', [1, 'previous']);
    signal('NotificationClosed', [1, 2]);
    signal('ActionInvoked', [1, 'next']);
    await adapter.show(track(), current);
    expect(notifyCalls().map(message => message.body[1])).toEqual([0, 0]);
    expect(onAction.mock.calls).toEqual([['previous']]);
  });

  it.each([true, false])('replaces the previous id when actions are supported: %s', async (actions) => {
    capabilities = actions ? ['actions'] : [];
    const oldAction = vi.fn();
    await adapter.show({ ...track(), onAction: oldAction }, current);
    await adapter.show(track(), current);
    expect(notifyCalls().map(message => message.body[1])).toEqual([0, 1]);
    signal('ActionInvoked', [1, 'next']);
    expect(oldAction).not.toHaveBeenCalled();
    expect(onAction).toHaveBeenCalledTimes(actions ? 1 : 0);
  });

  it('serialises Notify replies and skips a queued notification that becomes stale', async () => {
    let resolveNotify!: (reply: { body: unknown[] }) => void;
    const original = bus.call.getMockImplementation()!;
    bus.call.mockImplementation(async (message: Message) => {
      if (message.member === 'Notify' && !resolveNotify) {
        return new Promise(resolve => { resolveNotify = resolve; });
      }
      return original(message);
    });
    const first = adapter.show(track(), current);
    await vi.waitFor(() => expect(notifyCalls()).toHaveLength(1));
    let isCurrent = true;
    const stale = adapter.show(track(), () => isCurrent);
    const latest = adapter.show(track(), current);
    isCurrent = false;
    expect(notifyCalls()).toHaveLength(1);
    resolveNotify({ body: [42] });
    await Promise.all([first, stale, latest]);
    expect(notifyCalls().map(message => message.body[1])).toEqual([0, 42]);
  });

  it('sends a plain notification when the daemon lacks actions and markup', async () => {
    capabilities = [];
    await adapter.show(track(), current);
    expect(notifyCalls()[0].body[4]).toBe('Artist & <Album>');
    expect(notifyCalls()[0].body[5]).toEqual([]);
    signal('ActionInvoked', [1, 'next']);
    expect(onAction).not.toHaveBeenCalled();
  });

  it('sends nothing when the daemon is unavailable', async () => {
    owner = '';
    await adapter.show(track(), current);
    expect(notifyCalls()).toEqual([]);
  });

  it('does not retry an uncertain Notify failure', async () => {
    const original = bus.call.getMockImplementation()!;
    bus.call.mockImplementation(async (message: Message) => {
      if (message.member === 'Notify') throw new Error('Reply lost');
      return original(message);
    });
    await adapter.show(track(), current);
    await adapter.show(track(), current);
    expect(notifyCalls()).toHaveLength(1);
    signal('ActionInvoked', [1, 'next']);
    expect(onAction).not.toHaveBeenCalled();
  });

  it('discards the previous callback after an uncertain replacement reply', async () => {
    await adapter.show(track(), current);
    const original = bus.call.getMockImplementation()!;
    bus.call.mockImplementation(async (message: Message) => {
      if (message.member === 'Notify') throw new Error('Reply lost');
      return original(message);
    });
    await adapter.show(track(), current);
    signal('ActionInvoked', [1, 'next']);
    expect(onAction).not.toHaveBeenCalled();
    expect(notifyCalls()).toHaveLength(2);
  });

  it('clears ids on daemon replacement and accepts reused ids from its successor', async () => {
    await adapter.show(track(), current);
    replaceOwner(':1.43');
    signal('ActionInvoked', [1, 'next']);
    signal('ActionInvoked', [1, 'next'], ':1.42');
    expect(onAction).not.toHaveBeenCalled();
    nextId = 1;
    await adapter.show(track(), current);
    signal('ActionInvoked', [1, 'previous']);
    expect(onAction).toHaveBeenCalledExactlyOnceWith('previous');
  });

  it('discards an in-flight Notify reply after daemon replacement', async () => {
    const original = bus.call.getMockImplementation()!;
    bus.call.mockImplementation(async (message: Message) => {
      if (message.member === 'Notify') {
        replaceOwner(':1.43');
        return { body: [1] };
      }
      return original(message);
    });
    await adapter.show(track(), current);
    signal('ActionInvoked', [1, 'next']);
    expect(onAction).not.toHaveBeenCalled();
  });

  it.each([false, true])('releases a hung Notify on daemon replacement, after timeout: %s', async (expire) => {
    let resolveNotify!: (reply: { body: unknown[] }) => void;
    const oldAction = vi.fn();
    const original = bus.call.getMockImplementation()!;
    bus.call.mockImplementation((message: Message) => {
      if (message.member === 'Notify' && message.destination === ':1.42') {
        return new Promise(resolve => { resolveNotify = resolve; });
      }
      return original(message);
    });
    vi.useFakeTimers();
    try {
      const first = adapter.show({ ...track(), onAction: oldAction }, current);
      await vi.advanceTimersByTimeAsync(0);
      expect(notifyCalls()).toHaveLength(1);
      if (expire) {
        await vi.advanceTimersByTimeAsync(5000);
        await first;
        await adapter.show(track(), current);
        expect(notifyCalls()).toHaveLength(1);
      }
      replaceOwner(':1.43');
      nextId = 7;
      await first;
      await adapter.show(track(), current);
      expect(notifyCalls()).toHaveLength(2);
      expect(notifyCalls()[1]).toMatchObject({ destination: ':1.43' });
      expect(notifyCalls()[1].body[1]).toBe(0);

      resolveNotify({ body: [7] });
      await vi.advanceTimersByTimeAsync(0);
      signal('ActionInvoked', [7, 'next'], ':1.42');
      signal('ActionInvoked', [7, 'previous']);
      expect(oldAction).not.toHaveBeenCalled();
      expect(onAction).toHaveBeenCalledExactlyOnceWith('previous');
      await adapter.show(track(), current);
      expect(notifyCalls()[2].body[1]).toBe(7);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not unblock uncertain delivery when its timed-out reply arrives late', async () => {
    let resolveNotify!: (reply: { body: unknown[] }) => void;
    const original = bus.call.getMockImplementation()!;
    bus.call.mockImplementation((message: Message) => message.member === 'Notify'
      ? new Promise(resolve => { resolveNotify = resolve; }) : original(message));
    vi.useFakeTimers();
    try {
      const sending = adapter.show(track(), current);
      await vi.advanceTimersByTimeAsync(5000);
      await sending;
      resolveNotify({ body: [1] });
      await vi.advanceTimersByTimeAsync(0);
      await adapter.show(track(), current);
      signal('ActionInvoked', [1, 'next']);
      expect(notifyCalls()).toHaveLength(1);
      expect(onAction).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps actions on a notification already sent when the track changes', async () => {
    let isCurrent = true;
    const original = bus.call.getMockImplementation()!;
    bus.call.mockImplementation(async (message: Message) => {
      if (message.member === 'Notify') isCurrent = false;
      return original(message);
    });
    await adapter.show(track(), () => isCurrent);
    signal('ActionInvoked', [1, 'next']);
    expect(onAction).toHaveBeenCalledExactlyOnceWith('next');
  });

  it('detaches listeners and destroys the socket on quit', async () => {
    await adapter.show(track(), current);
    await adapter.dispose();
    await adapter.dispose();
    expect(bus.listenerCount('message')).toBe(0);
    expect(() => bus.emit('error', new Error('Late socket error'))).not.toThrow();
    expect(bus.disconnect).toHaveBeenCalledOnce();
    expect(bus._connection.stream.destroy).toHaveBeenCalledOnce();
    const close = bus.call.mock.calls.map(([message]) => message).filter(message => message.member === 'CloseNotification');
    expect(close).toHaveLength(1);
    expect(close[0]).toMatchObject({ destination: owner, flags: MessageFlag.NO_AUTO_START, signature: 'u', body: [1] });
    signal('ActionInvoked', [1, 'next']);
    await adapter.show(track(), current);
    expect(onAction).not.toHaveBeenCalled();
    expect(notifyCalls()).toHaveLength(1);
  });

  it('disables delivery and releases resources after a connection error', async () => {
    await adapter.show(track(), current);
    bus.emit('error', new Error('Bus disconnected'));
    await adapter.show(track(), current);
    expect(notifyCalls()).toHaveLength(1);
    expect(bus._connection.stream.destroy).toHaveBeenCalledOnce();
  });

  it('bounds cleanup when CloseNotification never replies', async () => {
    await adapter.show(track(), current);
    const original = bus.call.getMockImplementation()!;
    bus.call.mockImplementation((message: Message) => message.member === 'CloseNotification'
      ? new Promise(() => {}) : original(message));
    vi.useFakeTimers();
    try {
      const disposing = adapter.dispose();
      signal('ActionInvoked', [1, 'next']);
      await adapter.show(track(), current);
      expect(onAction).not.toHaveBeenCalled();
      expect(notifyCalls()).toHaveLength(1);
      expect(bus.disconnect).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(500);
      await disposing;
      expect(bus.disconnect).toHaveBeenCalledOnce();
      expect(bus._connection.stream.destroy).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases the socket when CloseNotification fails', async () => {
    await adapter.show(track(), current);
    const original = bus.call.getMockImplementation()!;
    bus.call.mockImplementation((message: Message) => message.member === 'CloseNotification'
      ? Promise.reject(new Error('No owner')) : original(message));
    await expect(adapter.dispose()).resolves.toBeUndefined();
    expect(bus.disconnect).toHaveBeenCalledOnce();
  });

  it('handles a session bus that cannot be opened', async () => {
    adapter.dispose();
    vi.mocked(sessionBus).mockImplementationOnce(() => { throw new Error('No bus'); });
    adapter = createLinuxNotifications();
    await expect(adapter.show(track(), current)).resolves.toBeUndefined();
    expect(notifyCalls()).toEqual([]);
  });

  it('sends nothing after the track or preference changes', async () => {
    await adapter.show(track(), () => false);
    expect(notifyCalls()).toEqual([]);
  });
});
