// Shared src/notify fake with a test-controlled D-Bus daemon gate.
// Production starts with the gate closed on Linux because constructing a Notification without a daemon can freeze the window.
// The fake starts with the gate open. Set notifyFake.available to simulate the daemon probe.
//
// test/notify.test.ts covers the real gate and must not import this file.
//
// 'record' stores options, listeners and show() calls in notifyFake.built.
// 'construct' uses the Electron constructor mock so tests can check that a closed gate prevents construction.
//
// Last.fm handles forced notifications before src/notify, so either mode observes them as construction while the notification preference is off.
//
// Vitest hoists vi.mock() within this file and resolves its paths relative to test/mocks/, hence ../../src/.
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
  close: ReturnType<typeof vi.fn>;
  removeAllListeners: ReturnType<typeof vi.fn>;
}

/** Test controls and recorded notifications. The mock factory reads this object after this module evaluates, so it needs no vi.hoisted(). */
export const notifyFake = {
  /** The daemon gate. Closed, createNotification() returns null. */
  available: true,
  /** Selects recorded objects or the Electron constructor mock. */
  mode: 'record' as 'record' | 'construct',
  /** What 'record' mode built, oldest first. Untouched by 'construct' mode. */
  built: [] as FakeNotification[],
};

/** Opens the daemon gate, selects the mode and clears recorded notifications. */
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
        close: vi.fn(),
        removeAllListeners: vi.fn((event?: string) => {
          if (event) delete handlers[event];
          else for (const name of Object.keys(handlers)) delete handlers[name];
        }),
      };
      notifyFake.built.push(notification);
      return notification;
    }),
  };
});
