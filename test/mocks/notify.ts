// test/mocks/notify.ts
// Shared stand-in for src/notify, the one place in Sidra a Notification is
// constructed. createNotification() returns null while the D-Bus daemon gate is
// closed, and that gate starts closed on Linux, because constructing a
// Notification with no daemon freezes the window for about 100 seconds. The
// probe that opens it never runs under test, so the fake mirrors the gate and a
// test opens or closes it with `notifyFake.available`.
//
// test/notify.test.ts covers the real gate and must not import this file.
//
// Two modes, because the two callers observe different things:
//
//   'record'     builds a plain object and pushes it onto `notifyFake.built`,
//                so a test reads the options it was asked for and the show()
//                the caller made on it.
//   'construct'  builds an electron Notification, so the electron mock in
//                test/setup.ts counts the constructions. A test asserting that
//                nothing was constructed - the daemon gate holding back a
//                forced notification - reads that constructor directly, which
//                is the boundary the freeze sits behind.
//
// Either mode lets a test observe a forced notification, the one Last.fm sends
// past the user's notifications preference: `force` never crosses into
// src/notify, so what a test sees is a notification built while the preference
// is off. In 'record' mode that is `notifyFake.built`, in 'construct' mode the
// electron constructor mock.
//
// Vitest hoists vi.mock() calls to the top of the file they appear in and
// resolves module paths relative to that file. Since this file lives in
// test/mocks/, the path uses ../../src/ instead of ../src/.
//
// Import this file before the modules it stands in for:
// import { notifyFake } from './mocks/notify';
import { vi } from 'vitest';

/** A notification the 'record' mode built. */
export interface FakeNotification {
  options: Electron.NotificationConstructorOptions;
  /** The listeners the caller attached, by event name. */
  handlers: Record<string, (...args: unknown[]) => void>;
  on(event: string, listener: (...args: unknown[]) => void): FakeNotification;
  show: ReturnType<typeof vi.fn>;
}

// A plain object, not vi.hoisted(): Vitest refuses to export a hoisted binding,
// and nothing here needs one. vi.mock() hoists the registration below, but its
// factory body runs only when src/notify is first imported, which is after this
// module has finished evaluating.
export const notifyFake = {
  /** The daemon gate. Closed, createNotification() returns null. */
  available: true,
  /** Which object createNotification() hands back; see the note above. */
  mode: 'record' as 'record' | 'construct',
  /** What 'record' mode built, oldest first. Untouched by 'construct' mode. */
  built: [] as FakeNotification[],
};

/** Clears the gate and the record, as each test file's beforeEach needs. */
export function resetNotifyFake(mode: 'record' | 'construct'): void {
  notifyFake.available = true;
  notifyFake.mode = mode;
  notifyFake.built = [];
}

vi.mock('../../src/notify', async () => {
  const { Notification } = await import('electron');
  return {
    notificationsAvailable: vi.fn(() => notifyFake.available),
    createNotification: vi.fn((options: Electron.NotificationConstructorOptions) => {
      if (!notifyFake.available) return null;
      if (notifyFake.mode === 'construct') return new Notification(options);

      const handlers: Record<string, (...args: unknown[]) => void> = {};
      const notification: FakeNotification = {
        options,
        handlers,
        on(event, listener) {
          handlers[event] = listener;
          return notification;
        },
        show: vi.fn(),
      };
      notifyFake.built.push(notification);
      return notification;
    }),
  };
});
