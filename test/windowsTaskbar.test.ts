import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import path from 'path';
import type { BrowserWindow } from 'electron';
import { nativeImage, nativeTheme } from 'electron';
import log from 'electron-log/main';
import { getTrayStrings } from '../src/i18n';
import { PlaybackState } from '../src/player';
import type { IntegrationContext, NowPlayingPayload } from '../src/player';
import { init, setTaskbarSendCommandCallback } from '../src/integrations/windows-taskbar';
import { FakePlayer } from './mocks/player';

// The real i18n module resolves against the ['en-GB', 'en'] the app mock in
// test/setup.ts reports, so every expectation reads the record the integration
// reads. A retyped English literal would pass even after the tooltips stopped
// going through getTrayStrings().
const strings = getTrayStrings();

const TRACK: NowPlayingPayload = {
  name: 'Blue Monday',
  artistName: 'New Order',
  durationInMillis: 450_000,
};

interface WindowStub {
  once: ReturnType<typeof vi.fn>;
  setThumbarButtons: ReturnType<typeof vi.fn<(buttons: Electron.ThumbarButton[]) => void>>;
  setOverlayIcon: ReturnType<typeof vi.fn<(icon: Electron.NativeImage | null, description: string) => void>>;
  setProgressBar: ReturnType<typeof vi.fn<(progress: number) => void>>;
}

const sendCommand = vi.fn<(channel: ReceiveChannel, ...args: unknown[]) => void>();

let player: FakePlayer;
let win: WindowStub;

const originalPlatform = process.platform;

function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', { value, writable: true, configurable: true });
}

/**
 * The two colour modes are separate Windows settings. Every test sets both, so
 * a test that reads the wrong one fails on the value rather than on ordering.
 */
function setColourModes(app: boolean, systemUI: boolean): void {
  Object.defineProperty(nativeTheme, 'shouldUseDarkColors', { value: app, configurable: true });
  Object.defineProperty(nativeTheme, 'shouldUseDarkColorsForSystemIntegratedUI', { value: systemUI, configurable: true });
}

/** Only isEmpty() is read, and it decides whether the icon reaches the taskbar. */
function fakeImage(empty: boolean): Electron.NativeImage {
  return { isEmpty: () => empty } as unknown as Electron.NativeImage;
}

function ctx(): IntegrationContext {
  return { player, getMainWindow: () => win as unknown as BrowserWindow };
}

function iconPaths(): string[] {
  return vi.mocked(nativeImage.createFromPath).mock.calls.map((call) => call[0]);
}

function lastThumbar(): Electron.ThumbarButton[] {
  const calls = win.setThumbarButtons.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0];
}

function lastOverlay(): [Electron.NativeImage | null, string] {
  const calls = win.setOverlayIcon.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1];
}

/**
 * Every scope method shares one mock in the electron-log stand-in, so the text
 * of the call is what identifies a warning.
 */
function logged(): string {
  return vi.mocked(log.scope('taskbar').warn).mock.calls.flat().join(' ');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(nativeImage.createFromPath).mockImplementation(() => fakeImage(false));
  setPlatform('win32');
  setColourModes(true, false);
  player = new FakePlayer();
  win = {
    once: vi.fn(),
    setThumbarButtons: vi.fn(),
    setOverlayIcon: vi.fn(),
    setProgressBar: vi.fn(),
  };
  setTaskbarSendCommandCallback(sendCommand);
});

afterAll(() => {
  setPlatform(originalPlatform);
});

describe('windows-taskbar init', () => {
  it('registers no listeners and touches no window off win32', () => {
    setPlatform('linux');

    init(ctx());

    expect(player.listenerCount('nowPlayingItemDidChange')).toBe(0);
    expect(player.listenerCount('playbackStateDidChange')).toBe(0);
    expect(player.listenerCount('playbackTimeDidChange')).toBe(0);
    expect(vi.mocked(nativeTheme.on)).not.toHaveBeenCalled();
    expect(win.once).not.toHaveBeenCalled();
  });
});

describe('windows-taskbar thumbnail toolbar', () => {
  beforeEach(() => {
    init(ctx());
  });

  it('labels the buttons with the localised tray strings', () => {
    player.emitNowPlaying(TRACK);

    expect(lastThumbar().map((button) => button.tooltip)).toEqual([
      strings.previous,
      strings.play,
      strings.next,
    ]);
  });

  it('labels the middle button with the localised pause string while playing', () => {
    player.setPlaybackState(PlaybackState.Playing);
    player.emitNowPlaying(TRACK);

    expect(lastThumbar()[1].tooltip).toBe(strings.pause);
    expect(iconPaths()).toContainEqual(expect.stringContaining('pause.png'));
  });

  it('sends the command that belongs to each button', () => {
    player.emitNowPlaying(TRACK);

    for (const button of lastThumbar()) button.click();

    expect(sendCommand.mock.calls.map((call) => call[0])).toEqual([
      'player:previous',
      'player:playPause',
      'player:next',
    ]);
  });

  it('clears the toolbar, the overlay and the progress bar on a null payload', () => {
    player.emitNowPlaying(TRACK);
    player.emitNowPlaying(null);

    expect(lastThumbar()).toEqual([]);
    expect(win.setOverlayIcon).toHaveBeenLastCalledWith(null, '');
    expect(win.setProgressBar).toHaveBeenLastCalledWith(-1);
  });

  it('reports playback position against the duration of the current track', () => {
    player.emitNowPlaying(TRACK);
    player.setPositionUs(225_000_000);

    expect(win.setProgressBar).toHaveBeenLastCalledWith(0.5);
  });
});

describe('windows-taskbar overlay icon', () => {
  beforeEach(() => {
    init(ctx());
  });

  it('describes the playing overlay with the localised play string', () => {
    player.emitPlaybackState(PlaybackState.Playing);

    const [icon, description] = lastOverlay();
    expect(icon).not.toBeNull();
    expect(description).toBe(strings.play);
  });

  it('describes the paused overlay with the localised pause string', () => {
    player.emitPlaybackState(PlaybackState.Paused);

    const [icon, description] = lastOverlay();
    expect(icon).not.toBeNull();
    expect(description).toBe(strings.pause);
  });

  it('clears the overlay on a terminal state', () => {
    player.emitPlaybackState(PlaybackState.Playing);
    player.emitPlaybackState(PlaybackState.Stopped);

    expect(lastOverlay()).toEqual([null, '']);
    expect(lastThumbar()).toEqual([]);
    expect(win.setProgressBar).toHaveBeenLastCalledWith(-1);
  });

  it('leaves the overlay alone on a transient state', () => {
    player.emitPlaybackState(PlaybackState.Playing);
    const settled = win.setOverlayIcon.mock.calls.length;

    player.emitPlaybackState(PlaybackState.Loading);

    expect(win.setOverlayIcon.mock.calls.length).toBe(settled);
  });
});

describe('windows-taskbar icon loading', () => {
  it('takes the icon variant from the system colour mode, not the app one', () => {
    setColourModes(false, true);
    init(ctx());

    player.emitNowPlaying(TRACK);

    expect(iconPaths().length).toBeGreaterThan(0);
    for (const iconPath of iconPaths()) expect(iconPath).toContain(path.join('menu', 'dark'));
  });

  it('uses the light variant when the system colour mode is light and the app one is dark', () => {
    setColourModes(true, false);
    init(ctx());

    player.emitNowPlaying(TRACK);

    expect(iconPaths().length).toBeGreaterThan(0);
    for (const iconPath of iconPaths()) expect(iconPath).toContain(path.join('menu', 'light'));
  });

  it('drops the button whose icon cannot be read and warns with the path', () => {
    vi.mocked(nativeImage.createFromPath).mockImplementation((iconPath: string) =>
      fakeImage(iconPath.endsWith('backward-step.png')));
    init(ctx());

    player.emitNowPlaying(TRACK);

    expect(lastThumbar().map((button) => button.tooltip)).toEqual([strings.play, strings.next]);
    expect(logged()).toContain(path.join('menu', 'light', 'backward-step.png'));
  });

  it('clears the overlay rather than badging it blank when its icon cannot be read', () => {
    vi.mocked(nativeImage.createFromPath).mockImplementation(() => fakeImage(true));
    init(ctx());

    player.emitPlaybackState(PlaybackState.Playing);

    expect(lastOverlay()).toEqual([null, '']);
  });
});
