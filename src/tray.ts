import { app, BrowserWindow, Menu, nativeImage, nativeTheme, ShareMenu, shell, Tray } from 'electron';
import path from 'path';
import log from 'electron-log/main';
import { getTrayStrings, getAboutStrings, getUpdateStrings, getAutoUpdateStrings, type TrayStrings } from './i18n';
import { getAssetPath, getProductInfo } from './paths';
import { Player, PlaybackState, getShareUrl, type NowPlayingPayload } from './player';
import { getNotificationsEnabled, setNotificationsEnabled, getDiscordEnabled, setDiscordEnabled, getTheme, setTheme, getStartPage, setStartPage, getZoomFactor, setZoomFactor } from './config';
import { getUpdateInfo } from './update';
import { quitAndInstall } from './autoUpdate';
import { applyTheme } from './theme';
import { downloadArtwork } from './artwork';
import { createPauseTimer } from './pauseTimer';

const ABOUT_WINDOW_WIDTH_PX = 400;
const ABOUT_WINDOW_HEIGHT_PX = 400;

const trayLog = log.scope('tray');

const iconsDir = getAssetPath('assets', 'icons');
const menuIconsDir = path.join(iconsDir, 'tray', 'menu');

// Maps tray action keys to PNG basenames (without extension) in assets/icons/tray/menu/{light,dark}/
const menuIconFileMap: Record<string, string> = {
  'about': 'circle-info',
  'start-page': 'music',
  'notifications': 'bell',
  'discord': 'discord',
  'style': 'palette',
  'zoom': 'expand',
  'update-ready': 'rotate',
  'update-available': 'parachute-box',
  'quit': 'eject',
  'artist': 'star',
  'album': 'compact-disc',
  'record-vinyl': 'record-vinyl',
  'previous': 'backward-step',
  'play': 'play',
  'pause': 'pause',
  'next': 'forward-step',
  'volume': 'volume',
};

// Maps tray action keys to SF Symbol names for macOS Tahoe+
const menuIconSFSymbolMap: Record<string, string> = {
  'about': 'info.circle',
  'start-page': 'music.note',
  'notifications': 'bell',
  'discord': 'bubble.left.and.bubble.right',
  'style': 'paintpalette',
  'zoom': 'arrow.up.left.and.arrow.down.right',
  'update-ready': 'arrow.clockwise',
  'update-available': 'arrow.down.circle',
  'quit': 'xmark.circle',
  'share': 'square.and.arrow.up',
  'artist': 'star',
  'album': 'opticaldisc',
  'record-vinyl': 'record.circle',
  'previous': 'backward.end',
  'play': 'play',
  'pause': 'pause',
  'next': 'forward.end',
  'volume': 'speaker.wave.2',
};

function isMacOSTahoeOrLater(): boolean {
  if (process.platform !== 'darwin') return false;
  const version = process.getSystemVersion();
  const major = parseInt(version.split('.')[0], 10);
  return !isNaN(major) && major >= 26;
}

export function getMenuIcon(action: string): Electron.NativeImage | undefined {
  if (process.platform === 'darwin') {
    if (!isMacOSTahoeOrLater()) return undefined;

    const symbolName = menuIconSFSymbolMap[action];
    if (!symbolName) return undefined;

    // hslShift [-1, 0, 1] marks the image as a template so macOS
    // automatically adapts its colour to match the menu text (light/dark).
    const raw = nativeImage.createFromNamedImage(symbolName, [-1, 0, 1]);
    if (raw.isEmpty()) return undefined;

    // SF Symbols render at their intrinsic size, which is too large for
    // menu items. Resize to 18px with HiDPI representations.
    const img = nativeImage.createEmpty();
    img.addRepresentation({ scaleFactor: 1.0, buffer: raw.resize({ width: 18, height: 18 }).toPNG() });
    img.addRepresentation({ scaleFactor: 2.0, buffer: raw.resize({ width: 36, height: 36 }).toPNG() });
    return img;
  }

  // Linux and Windows: resolve themed PNG
  const baseName = menuIconFileMap[action];
  if (!baseName) return undefined;

  const variant = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  const iconPath = path.join(menuIconsDir, variant, `${baseName}.png`);
  const img = nativeImage.createFromPath(iconPath);
  return img.isEmpty() ? undefined : img;
}

function getLinuxTrayIconPath(): string {
  // Dark theme = white icon (dark.png); light theme = black icon (light.png)
  return nativeTheme.shouldUseDarkColors
    ? path.join(iconsDir, 'sidra-tray-dark.png')
    : path.join(iconsDir, 'sidra-tray-light.png');
}

function getTrayIconPath(): string {
  if (process.platform === 'darwin') {
    return path.join(iconsDir, 'sidraTemplate.png');
  }

  if (process.platform === 'win32') {
    return path.join(iconsDir, 'sidra-tray.png');
  }

  // Linux: select icon based on current theme
  return getLinuxTrayIconPath();
}

function escapePango(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function sanitiseLinuxLabel(text: string): string {
  return text.replace(/&/g, '\uFF06');
}

export function truncateMenuLabel(text: string, maxLength = 32): string {
  const splitIndex = text.search(/[([]/);
  const trimmed = splitIndex > 0 ? text.slice(0, splitIndex).trimEnd() : text;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength).trimEnd() + '…' : trimmed;
}

interface NowPlayingState {
  payload: NowPlayingPayload | null;
  artworkPath: string | null;
  isPlaying: boolean;
  volume: number;
}

let nowPlayingState: NowPlayingState | null = null;
let sendCommandCallback: ((channel: string, ...args: unknown[]) => void) | null = null;
let aboutWindow: BrowserWindow | null = null;
let applyZoomCallback: ((factor: number) => void) | null = null;

export function showAboutWindow(): void {
  if (aboutWindow) {
    aboutWindow.focus();
    return;
  }

  trayLog.info('showing About window');
  const zoomFactor = getZoomFactor();
  aboutWindow = new BrowserWindow({
    width: Math.round(ABOUT_WINDOW_WIDTH_PX * zoomFactor),
    height: Math.round(ABOUT_WINDOW_HEIGHT_PX * zoomFactor),
    frame: false,
    resizable: false,
    fullscreenable: false,
    fullscreen: false,
    center: true,
    skipTaskbar: true,
    backgroundColor: '#1a0a10',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  aboutWindow.once('ready-to-show', () => {
    aboutWindow?.webContents.setZoomFactor(getZoomFactor());
    aboutWindow?.show();
  });

  aboutWindow.on('closed', () => {
    aboutWindow = null;
  });

  const info = getProductInfo();
  const trayStrings = getTrayStrings();
  const aboutStrings = getAboutStrings();

  aboutWindow.loadFile(getAssetPath('assets', 'about.html'), {
    query: {
      name: info.productName,
      version: app.getVersion(),
      description: info.description,
      author: info.author,
      license: info.license,
      about: trayStrings.about,
      close: aboutStrings.close,
      versionPrefix: aboutStrings.versionPrefix,
      copyrightSuffix: aboutStrings.copyrightSuffix,
      licensePrefix: aboutStrings.licensePrefix,
    },
  });
}

interface SubmenuContext {
  strings: TrayStrings;
  isLinux: boolean;
  refresh: () => void;
}

function buildStartPageSubmenu(ctx: SubmenuContext): Electron.MenuItemConstructorOptions {
  const { strings, refresh } = ctx;
  const currentStartPage = getStartPage();
  const startPageLabelMap: Record<string, string> = {
    'home': strings.startPageHome,
    'new': strings.startPageNew,
    'radio': strings.startPageRadio,
    'all-playlists': strings.startPageAllPlaylists,
    'last': strings.startPageLast,
  };
  const parentLabel = `${strings.startPage}: ${startPageLabelMap[currentStartPage]}`;
  const icon = getMenuIcon('start-page');
  return {
    label: parentLabel,
    ...(icon ? { icon } : {}),
    submenu: [
      {
        label: strings.startPageHome,
        type: 'radio',
        checked: currentStartPage === 'home',
        click: () => { setStartPage('home'); refresh(); },
      },
      {
        label: strings.startPageNew,
        type: 'radio',
        checked: currentStartPage === 'new',
        click: () => { setStartPage('new'); refresh(); },
      },
      {
        label: strings.startPageRadio,
        type: 'radio',
        checked: currentStartPage === 'radio',
        click: () => { setStartPage('radio'); refresh(); },
      },
      {
        label: strings.startPageAllPlaylists,
        type: 'radio',
        checked: currentStartPage === 'all-playlists',
        click: () => { setStartPage('all-playlists'); refresh(); },
      },
      {
        label: strings.startPageLast,
        type: 'radio',
        checked: currentStartPage === 'last',
        click: () => { setStartPage('last'); refresh(); },
      },
    ],
  };
}

function buildNotificationsSubmenu(ctx: SubmenuContext): Electron.MenuItemConstructorOptions {
  const { strings, refresh } = ctx;
  const notifEnabled = getNotificationsEnabled();
  const parentLabel = `${strings.notifications}: ${notifEnabled ? strings.on : strings.off}`;
  const icon = getMenuIcon('notifications');
  return {
    label: parentLabel,
    ...(icon ? { icon } : {}),
    submenu: [
      {
        label: strings.on,
        type: 'radio',
        checked: notifEnabled,
        click: () => { setNotificationsEnabled(true); refresh(); },
      },
      {
        label: strings.off,
        type: 'radio',
        checked: !notifEnabled,
        click: () => { setNotificationsEnabled(false); refresh(); },
      },
    ],
  };
}

function buildDiscordSubmenu(ctx: SubmenuContext): Electron.MenuItemConstructorOptions {
  const { strings, refresh } = ctx;
  const discordEnabled = getDiscordEnabled();
  const parentLabel = `${strings.discord}: ${discordEnabled ? strings.on : strings.off}`;
  const icon = getMenuIcon('discord');
  return {
    label: parentLabel,
    ...(icon ? { icon } : {}),
    submenu: [
      {
        label: strings.on,
        type: 'radio',
        checked: discordEnabled,
        click: () => { setDiscordEnabled(true); refresh(); },
      },
      {
        label: strings.off,
        type: 'radio',
        checked: !discordEnabled,
        click: () => { setDiscordEnabled(false); refresh(); },
      },
    ],
  };
}

function buildStyleSubmenu(ctx: SubmenuContext): Electron.MenuItemConstructorOptions {
  const { strings, refresh } = ctx;
  const currentTheme = getTheme();
  const parentLabel = `${strings.style}: ${currentTheme === 'catppuccin' ? strings.catppuccin : strings.styleAppleMusic}`;
  const icon = getMenuIcon('style');
  return {
    label: parentLabel,
    ...(icon ? { icon } : {}),
    submenu: [
      {
        label: strings.styleAppleMusic,
        type: 'radio',
        checked: currentTheme === 'apple-music',
        click: () => { setTheme('apple-music'); applyTheme('apple-music'); refresh(); },
      },
      {
        label: strings.catppuccin,
        type: 'radio',
        checked: currentTheme === 'catppuccin',
        click: () => { setTheme('catppuccin'); applyTheme('catppuccin'); refresh(); },
      },
    ],
  };
}

function buildZoomSubmenu(ctx: SubmenuContext & { applyZoom: ((factor: number) => void) | null }): Electron.MenuItemConstructorOptions {
  const { strings, refresh, applyZoom } = ctx;
  const zoomFactor = getZoomFactor();
  const zoomLabelMap: Record<number, string> = { 1.0: strings.zoom100, 1.25: strings.zoom125, 1.5: strings.zoom150, 1.75: strings.zoom175, 2.0: strings.zoom200 };
  const parentLabel = `${strings.zoom}: ${zoomLabelMap[zoomFactor] ?? `${Math.round(zoomFactor * 100)}%`}`;
  const makeClick = (factor: number) => () => { setZoomFactor(factor); if (applyZoom) applyZoom(factor); refresh(); };
  const icon = getMenuIcon('zoom');
  return {
    label: parentLabel,
    ...(icon ? { icon } : {}),
    submenu: [
      { label: strings.zoom100, type: 'radio', checked: zoomFactor === 1.0, click: makeClick(1.0) },
      { label: strings.zoom125, type: 'radio', checked: zoomFactor === 1.25, click: makeClick(1.25) },
      { label: strings.zoom150, type: 'radio', checked: zoomFactor === 1.5, click: makeClick(1.5) },
      { label: strings.zoom175, type: 'radio', checked: zoomFactor === 1.75, click: makeClick(1.75) },
      { label: strings.zoom200, type: 'radio', checked: zoomFactor === 2.0, click: makeClick(2.0) },
    ],
  };
}

function buildUpdateMenuItems(): Electron.MenuItemConstructorOptions[] {
  const update = getUpdateInfo();
  const updateStrings = getUpdateStrings();
  if (update && update.ready) {
    const autoUpdateStrings = getAutoUpdateStrings();
    const icon = getMenuIcon('update-ready');
    return [
      { type: 'separator' },
      {
        label: autoUpdateStrings.ready,
        ...(icon ? { icon } : {}),
        click: () => { quitAndInstall(); },
      },
    ];
  } else if (update) {
    const updateLabel = updateStrings.updateAvailable.replace('{version}', update.version);
    const icon = getMenuIcon('update-available');
    return [
      { type: 'separator' },
      {
        label: updateLabel,
        ...(icon ? { icon } : {}),
        click: () => {
          try {
            const parsed = new URL(update.url);
            if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
              void shell.openExternal(parsed.toString());
            } else {
              trayLog.warn('blocked non-http(s) update URL:', update.url);
            }
          } catch {
            trayLog.warn('invalid update URL:', update.url);
          }
        },
      },
    ];
  }
  return [
    { type: 'separator' },
    { label: updateStrings.upToDate, enabled: false },
  ];
}

function buildNowPlayingMenuItems(strings: TrayStrings, isLinux: boolean): Electron.MenuItemConstructorOptions[] {
  if (!nowPlayingState || !nowPlayingState.payload) {
    return [];
  }

  const { payload, artworkPath, isPlaying, volume } = nowPlayingState;
  const sendCommand = sendCommandCallback;

  // Artwork icon for the track name item - multi-representation for HiDPI
  let icon: Electron.NativeImage | undefined;
  if (artworkPath) {
    const src = nativeImage.createFromPath(artworkPath);
    if (!src.isEmpty()) {
      const img = nativeImage.createEmpty();
      img.addRepresentation({ scaleFactor: 1.0, buffer: src.resize({ width: 18, height: 18 }).toPNG() });
      img.addRepresentation({ scaleFactor: 1.25, buffer: src.resize({ width: 23, height: 23 }).toPNG() });
      img.addRepresentation({ scaleFactor: 1.5, buffer: src.resize({ width: 27, height: 27 }).toPNG() });
      img.addRepresentation({ scaleFactor: 1.75, buffer: src.resize({ width: 32, height: 32 }).toPNG() });
      img.addRepresentation({ scaleFactor: 2.0, buffer: src.resize({ width: 36, height: 36 }).toPNG() });
      icon = img;
    }
  }

  // Metadata items - Electron partially escapes labels for GTK/Pango but
  // does not escape bare `&`, which Pango consumes as a markup entity start.
  // sanitiseLinuxLabel replaces `&` with fullwidth ampersand (U+FF06) to
  // avoid this on Linux without affecting macOS or Windows.
  const trackLabel = truncateMenuLabel(payload.name ?? '');
  const trackItem: Electron.MenuItemConstructorOptions = {
    label: isLinux ? sanitiseLinuxLabel(trackLabel) : trackLabel,
    enabled: false,
    ...(icon ? { icon } : {}),
  };
  const artistLabel = truncateMenuLabel(payload.artistName ?? '');
  const artistIcon = getMenuIcon('artist');
  const artistItem: Electron.MenuItemConstructorOptions = {
    label: isLinux ? sanitiseLinuxLabel(artistLabel) : artistLabel,
    enabled: false,
    ...(artistIcon ? { icon: artistIcon } : {}),
  };
  const albumLabel = truncateMenuLabel(payload.albumName ?? '');
  const releaseYear = payload.releaseDate ? parseInt(payload.releaseDate.slice(0, 4), 10) : NaN;
  const albumIconKey = !isNaN(releaseYear) && releaseYear <= 1981 ? 'record-vinyl' : 'album';
  const albumIcon = getMenuIcon(albumIconKey);
  const albumItem: Electron.MenuItemConstructorOptions = {
    label: isLinux ? sanitiseLinuxLabel(albumLabel) : albumLabel,
    enabled: false,
    ...(albumIcon ? { icon: albumIcon } : {}),
  };

  // Playback controls
  const playPauseLabel = isPlaying ? strings.pause : strings.play;
  const playPauseAction = isPlaying ? 'pause' : 'play';
  const previousIcon = getMenuIcon('previous');
  const previousItem: Electron.MenuItemConstructorOptions = {
    label: strings.previous,
    ...(previousIcon ? { icon: previousIcon } : {}),
    click: () => { if (sendCommand) sendCommand('player:previous'); },
  };
  const playPauseIcon = getMenuIcon(playPauseAction);
  const playPauseItem: Electron.MenuItemConstructorOptions = {
    label: playPauseLabel,
    ...(playPauseIcon ? { icon: playPauseIcon } : {}),
    click: () => { if (sendCommand) sendCommand('player:playPause'); },
  };
  const nextIcon = getMenuIcon('next');
  const nextItem: Electron.MenuItemConstructorOptions = {
    label: strings.next,
    ...(nextIcon ? { icon: nextIcon } : {}),
    click: () => { if (sendCommand) sendCommand('player:next'); },
  };

  // Volume submenu with radio items
  const volumePct = Math.round(volume * 100);
  const volumeIcon = getMenuIcon('volume');
  const volumeParentLabel = `${strings.volume}: ${volumePct}%`;
  const volumeItem: Electron.MenuItemConstructorOptions = {
    label: volumeParentLabel,
    ...(volumeIcon ? { icon: volumeIcon } : {}),
    submenu: [
      {
        label: strings.mute,
        type: 'radio',
        checked: volume === 0,
        click: () => { if (sendCommand) sendCommand('player:setVolume', 0); },
      },
      {
        label: '25%',
        type: 'radio',
        checked: volume === 0.25,
        click: () => { if (sendCommand) sendCommand('player:setVolume', 0.25); },
      },
      {
        label: '50%',
        type: 'radio',
        checked: volume === 0.5,
        click: () => { if (sendCommand) sendCommand('player:setVolume', 0.5); },
      },
      {
        label: '75%',
        type: 'radio',
        checked: volume === 0.75,
        click: () => { if (sendCommand) sendCommand('player:setVolume', 0.75); },
      },
      {
        label: '100%',
        type: 'radio',
        checked: volume === 1.0,
        click: () => { if (sendCommand) sendCommand('player:setVolume', 1.0); },
      },
    ],
  };

  // Share item (macOS only) - uses native share sheet via ShareMenu
  const shareItems: Electron.MenuItemConstructorOptions[] = [];
  const shareUrl = getShareUrl(payload);
  if (process.platform === 'darwin' && shareUrl) {
    shareItems.push({
      label: strings.share,
      ...(getMenuIcon('share') ? { icon: getMenuIcon('share') } : {}),
      click: () => {
        const shareMenu = new ShareMenu({ urls: [shareUrl] });
        shareMenu.popup();
      },
    });
  }

  return [
    trackItem,
    artistItem,
    albumItem,
    { type: 'separator' },
    previousItem,
    playPauseItem,
    nextItem,
    volumeItem,
    ...shareItems,
    { type: 'separator' },
  ];
}

function buildContextMenu(tray: Tray): Menu {
  const refresh = () => tray.setContextMenu(buildContextMenu(tray));
  const strings = getTrayStrings();
  const isLinux = process.platform === 'linux';
  const ctx: SubmenuContext = { strings, isLinux, refresh };
  const aboutIcon = getMenuIcon('about');
  const quitIcon = getMenuIcon('quit');

  const menuItems: Electron.MenuItemConstructorOptions[] = [
    ...buildNowPlayingMenuItems(strings, isLinux),
    {
      label: strings.about,
      ...(aboutIcon ? { icon: aboutIcon } : {}),
      click: () => showAboutWindow(),
    },
    buildStartPageSubmenu(ctx),
    buildNotificationsSubmenu(ctx),
    buildDiscordSubmenu(ctx),
    buildStyleSubmenu(ctx),
    buildZoomSubmenu({ ...ctx, applyZoom: applyZoomCallback }),
    ...buildUpdateMenuItems(),
    { type: 'separator' },
    {
      label: strings.quit,
      ...(quitIcon ? { icon: quitIcon } : {}),
      click: () => app.quit(),
    },
  ];

  return Menu.buildFromTemplate(menuItems);
}

export function setApplyZoomCallback(callback: (factor: number) => void): void {
  applyZoomCallback = callback;
}

export function setSendCommandCallback(callback: (channel: string, ...args: unknown[]) => void): void {
  sendCommandCallback = callback;
}

export function updateNowPlayingState(payload: NowPlayingPayload | null, artworkPath: string | null, isPlaying: boolean, volume: number): void {
  nowPlayingState = { payload, artworkPath, isPlaying, volume };
}

export function rebuildTrayMenu(tray: Tray): void {
  tray.setContextMenu(buildContextMenu(tray));
}

export function updateTrayTooltip(tray: Tray, payload: NowPlayingPayload | null): void {
  const fallback = getProductInfo().productName;
  const text = payload?.name
    ? payload.artistName ? `${payload.name} - ${payload.artistName}` : payload.name
    : fallback;
  const tooltip = text || fallback;
  const escaped = process.platform === 'linux' ? escapePango(tooltip) : tooltip;
  trayLog.debug('updateTrayTooltip:', payload ? `name=${payload.name}, artistName=${payload.artistName}` : 'null payload', '->', `"${escaped}"`);
  tray.setToolTip(escaped);
}

export function createTray(applyZoom?: (factor: number) => void): Tray {
  applyZoomCallback = applyZoom ?? null;
  const iconPath = getTrayIconPath();
  trayLog.info('creating tray with icon:', iconPath);

  const tray = new Tray(iconPath);
  tray.setToolTip(getProductInfo().productName);

  tray.setContextMenu(buildContextMenu(tray));

  if (process.platform === 'linux') {
    nativeTheme.on('updated', () => {
      const newIconPath = getLinuxTrayIconPath();
      trayLog.info('theme changed, switching tray icon:', newIconPath);
      tray.setImage(newIconPath);
      trayLog.info('theme changed, rebuilding context menu');
      tray.setContextMenu(buildContextMenu(tray));
    });
  } else if (process.platform === 'win32') {
    nativeTheme.on('updated', () => {
      trayLog.info('theme changed, rebuilding context menu');
      tray.setContextMenu(buildContextMenu(tray));
    });
  }

  trayLog.info('tray created');

  return tray;
}

export function initTrayStateManager(player: Player, tray: Tray): () => void {
  const TRAY_PAUSE_TIMEOUT_MS = 30_000;
  let currentVolume = 1;
  let currentPayload: NowPlayingPayload | null = null;
  let currentArtworkPath: string | null = null;
  let previousPlaying = false;

  const clearNowPlaying = (): void => {
    trayLog.debug('tray pause timeout reached, clearing Now Playing');
    updateTrayTooltip(tray, null);
    currentPayload = null;
    currentArtworkPath = null;
    updateNowPlayingState(null, null, false, currentVolume);
    rebuildTrayMenu(tray);
  };

  const trayPauseTimer = createPauseTimer(TRAY_PAUSE_TIMEOUT_MS, clearNowPlaying);

  const onNowPlayingItemDidChange = async (payload: NowPlayingPayload | null): Promise<void> => {
    // Cancel pause timer on track change
    trayPauseTimer.cancel();
    if (!payload) {
      trayLog.debug('nowPlayingItemDidChange (tray handler): null payload, clearing state');
      currentPayload = null;
      currentArtworkPath = null;
      updateTrayTooltip(tray, null);
      updateNowPlayingState(null, null, false, currentVolume);
      rebuildTrayMenu(tray);
      return;
    }
    trayLog.debug('nowPlayingItemDidChange (tray handler):', `"${payload.name}"`);
    currentPayload = payload;
    updateTrayTooltip(tray, payload);
    let artworkPath: string | null = null;
    if (payload.artworkUrl) {
      const expectedPayload = payload;
      artworkPath = await downloadArtwork(payload.artworkUrl);
      if (currentPayload !== expectedPayload) return;
    }
    currentArtworkPath = artworkPath;
    const { isPlaying } = player.playbackSnapshot();
    updateNowPlayingState(payload, artworkPath, isPlaying, currentVolume);
    rebuildTrayMenu(tray);
  };

  const onPlaybackStateDidChange = (payload: { status: boolean; state: number } | null): void => {
    const state = payload?.state ?? 0;
    if (state === PlaybackState.None || state === PlaybackState.Stopped ||
        state === PlaybackState.Ended || state === PlaybackState.Completed) {
      trayPauseTimer.cancel();
      updateTrayTooltip(tray, null);
      currentPayload = null;
      currentArtworkPath = null;
      updateNowPlayingState(null, null, false, currentVolume);
      rebuildTrayMenu(tray);
      return;
    }
    const { isPlaying } = player.playbackSnapshot();

    // Pause timeout: clear Now Playing after 30s of inactivity
    if (isPlaying) {
      trayPauseTimer.cancel();
    }
    if (!isPlaying && previousPlaying) {
      trayPauseTimer.start();
    }
    previousPlaying = isPlaying;

    updateNowPlayingState(currentPayload, currentArtworkPath, isPlaying, currentVolume);
    rebuildTrayMenu(tray);
  };

  const onVolumeDidChange = (volume: number | null): void => {
    if (volume == null) return;
    currentVolume = volume;
    const { isPlaying } = player.playbackSnapshot();
    updateNowPlayingState(currentPayload, currentArtworkPath, isPlaying, currentVolume);
    rebuildTrayMenu(tray);
  };

  player.on('nowPlayingItemDidChange', onNowPlayingItemDidChange);
  player.on('playbackStateDidChange', onPlaybackStateDidChange);
  player.on('volumeDidChange', onVolumeDidChange);

  return () => {
    trayPauseTimer.destroy();
    player.off('nowPlayingItemDidChange', onNowPlayingItemDidChange);
    player.off('playbackStateDidChange', onPlaybackStateDidChange);
    player.off('volumeDidChange', onVolumeDidChange);
  };
}
