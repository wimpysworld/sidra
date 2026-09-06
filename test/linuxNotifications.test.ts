import { EventEmitter } from 'node:events';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Message, MessageFlag, MessageType, sessionBus } from '@holusion/dbus-next';
import { createLinuxNotifications } from '../src/linuxNotifications';

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
const track = () => ({ title: 'Song', body: 'Artist & <Album>', icon: '/tmp/art.jpg', previous: 'Zurück', next: 'Weiter', onAction });
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
      if (message.member === 'Notify') return { body: [nextId++] };
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
      'Sidra', 0, '/tmp/art.jpg', 'Song', 'Artist &amp; &lt;Album&gt;',
      ['default', '', 'previous', 'Zurück', 'next', 'Weiter'],
    ]);
    expect(message.body[6]['suppress-sound'].value).toBe(true);
    expect(message.body[6]['desktop-entry'].value).toBe('sidra');
  });

  it('routes only known actions for an active id from the current daemon', async () => {
    await adapter.show(track(), current);
    signal('ActionInvoked', [1, 'previous']);
    signal('ActionInvoked', [1, 'next']);
    signal('ActionInvoked', [1, 'default']);
    signal('ActionInvoked', [1, 'quit']);
    signal('ActionInvoked', [2, 'next']);
    signal('ActionInvoked', ['1', 'next']);
    signal('ActionInvoked', [1, 'next'], ':1.99');
    expect(onAction.mock.calls).toEqual([['previous'], ['next'], ['default']]);
  });

  it('forgets closed notifications without affecting another id', async () => {
    await adapter.show(track(), current);
    await adapter.show(track(), current);
    signal('NotificationClosed', [1, 2]);
    signal('ActionInvoked', [1, 'next']);
    signal('ActionInvoked', [2, 'previous']);
    expect(onAction.mock.calls).toEqual([['previous']]);
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
    expect(notifyCalls()).toHaveLength(1);
    signal('ActionInvoked', [1, 'next']);
    expect(onAction).not.toHaveBeenCalled();
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
    adapter.dispose();
    adapter.dispose();
    expect(bus.listenerCount('message')).toBe(0);
    expect(() => bus.emit('error', new Error('Late socket error'))).not.toThrow();
    expect(bus.disconnect).toHaveBeenCalledOnce();
    expect(bus._connection.stream.destroy).toHaveBeenCalledOnce();
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
