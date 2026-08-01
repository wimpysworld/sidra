import { contextBridge, ipcRenderer } from 'electron';

/**
 * Builds a channel allowlist from a record keyed by the channel union, so the
 * allowlist and the union cannot drift: a missing key and an unknown key are
 * both compile errors. Object.keys() is typed string[], so the cast lives here
 * rather than at the two call sites. allows() takes a string because the value
 * it checks arrives from the main world, where nothing is typed; the predicate
 * narrows it to C for the caller.
 */
function channelSet<C extends string>(
  channels: Record<C, true>,
): { all: readonly C[]; allows(value: string): value is C } {
  const all = Object.keys(channels) as C[];
  const set = new Set<string>(all);
  return { all, allows: (value: string): value is C => set.has(value) };
}

// Channels the renderer is allowed to send to the main process.
// Extend this list and SendChannel in src/types/hook.d.ts together.
const SEND_CHANNELS = channelSet<SendChannel>({
  playbackStateDidChange: true,
  nowPlayingItemDidChange: true,
  playbackTimeDidChange: true,
  repeatModeDidChange: true,
  shuffleModeDidChange: true,
  volumeDidChange: true,
  'nav:back': true,
  'nav:forward': true,
  'nav:reload': true,
});

// Channels the main process is allowed to send to the renderer.
// Each channel maps to a window.__sidra method dispatched via ipcRenderer.on().
// The command allowlist in assets/musicKitHook.js must stay in sync.
const RECEIVE_CHANNELS = channelSet<ReceiveChannel>({
  'player:play': true,
  'player:pause': true,
  'player:playPause': true,
  'player:next': true,
  'player:previous': true,
  'player:seek': true,
  'player:setVolume': true,
  'player:setRepeat': true,
  'player:setShuffle': true,
});

// The preload runs in the isolated world (contextIsolation: true), so it cannot
// call window.__sidra directly - that object lives in the main world, set up by
// musicKitHook.js. window.postMessage() crosses the isolation boundary, and the
// hook dispatches each sidra:command message to the matching __sidra method.
// The target origin is window.location.origin, so the bridge works on either
// service host without naming one.
for (const channel of RECEIVE_CHANNELS.all) {
  ipcRenderer.on(channel, (_event, ...args: unknown[]) => {
    window.postMessage({ type: 'sidra:command', channel, args }, window.location.origin);
  });
}

/**
 * The renderer-to-main half of the bridge, exposed as window.AMWrapper and used
 * by sendToMain() in assets/musicKitHook.js. Sending is the only capability the
 * renderer gets, and an unlisted channel is dropped with a warning rather than
 * forwarded. The satisfies clause is what type-checks the payload at all:
 * exposeInMainWorld() takes it untyped, so the declaration in
 * src/types/hook.d.ts would otherwise be checked against nothing.
 */
contextBridge.exposeInMainWorld('AMWrapper', {
  ipcRenderer: {
    send: (channel: string, data: unknown) => {
      if (!SEND_CHANNELS.allows(channel)) {
        console.warn(`AMWrapper: blocked send on unlisted channel "${channel}"`);
        return;
      }
      ipcRenderer.send(channel, data);
    },
  },
} satisfies AMWrapperBridge);
