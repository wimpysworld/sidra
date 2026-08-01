import { app, BrowserWindow, Menu, nativeImage, nativeTheme, ShareMenu, Tray } from 'electron';
import path from 'path';
import log from 'electron-log/main';
import { getTrayStrings, getUpdateStrings, getAutoUpdateStrings, type TrayStrings } from './i18n';
import { getAssetPath, getProductInfo } from './paths';
import { Player, isTerminalPlaybackState, getShareUrl, type NowPlayingPayload } from './player';
import { getNotificationsEnabled, setNotificationsEnabled, getDiscordEnabled, setDiscordEnabled, getLastfmEnabled, setLastfmEnabled, getLastfmSessionKey, getLastfmUsername, setTheme, getStartPage, setStartPage, getZoomFactor, setZoomFactor, getCloseToTrayEnabled, setCloseToTrayEnabled, getMusicService, getClassicalStartPage, setClassicalStartPage } from './config';
import { showAboutWindow } from './aboutWindow';
import { getUpdateInfo } from './update';
import { quitAndInstall } from './autoUpdate';
import { BUNDLED_THEMES, themeLabel } from './palettes';
import { applyTheme, hasCustomCss, resolveTheme } from './theme';
import { enable as enableDiscord, disable as disableDiscord } from './integrations/discord-presence';
import { enable as enableLastfm, disable as disableLastfm, startAuth as startLastfmAuth, disconnect as disconnectLastfm, isConfigured as isLastfmConfigured } from './integrations/lastfm';
import { downloadArtwork } from './artwork';
import { sendCommand } from './commandBridge';
import { createPauseTimer } from './pauseTimer';
import { openExternalUrl } from './utils/openExternal';
import { allServices, getService, MUSIC_SERVICES, type AnyStartPageId, type MusicService, type MusicServiceId } from './musicService';

const trayLog = log.scope('tray');

const iconsDir = getAssetPath('assets', 'icons');
const menuIconsDir = path.join(iconsDir, 'tray', 'menu');

// Every action a menu item can carry an icon for. Both maps below are typed
// against it, so a key in one and not the other is either declared as a gap or
// fails tsc, and a misspelt call site fails at the call rather than rendering
// an iconless row.
export type MenuIconKey =
  | 'about'
  | 'player'
  | 'start-page'
  | 'notifications'
  | 'discord'
  | 'lastfm'
  | 'style'
  | 'zoom'
  | 'update-ready'
  | 'update-available'
  | 'quit'
  | 'share'
  | 'artist'
  | 'album'
  | 'record-vinyl'
  | 'previous'
  | 'play'
  | 'pause'
  | 'next'
  | 'volume'
  | 'close-to-tray'
  | 'show-window'
  | 'hide-window';

// Maps tray action keys to PNG basenames (without extension) in assets/icons/tray/menu/{light,dark}/
// Partial because 'share' ships no PNG: the Share item is macOS-only, so the
// gap is unreachable and the map declares it rather than hiding it.
const menuIconFileMap: Partial<Record<MenuIconKey, string>> = {
  'about': 'circle-info',
  'player': 'headphones',
  'start-page': 'music',
  'notifications': 'bell',
  'discord': 'discord',
  'lastfm': 'lastfm',
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
  'close-to-tray': 'toggle-on',
  'show-window': 'eye',
  'hide-window': 'eye-slash',
};

// Maps tray action keys to SF Symbol names for macOS Tahoe+
const menuIconSFSymbolMap: Record<MenuIconKey, string> = {
  'about': 'info.circle',
  'player': 'headphones',
  'start-page': 'music.note',
  'notifications': 'bell',
  'discord': 'bubble.left.and.bubble.right',
  'lastfm': 'dot.radiowaves.left.and.right',
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
  'close-to-tray': 'menubar.dock.rectangle',
  'show-window': 'eye',
  'hide-window': 'eye.slash',
};

function isMacOSTahoeOrLater(): boolean {
  if (process.platform !== 'darwin') return false;
  const version = process.getSystemVersion();
  const major = parseInt(version.split('.')[0], 10);
  return !isNaN(major) && major >= 26;
}

/**
 * Icon for a menu action, or undefined when the platform or the action has
 * none. Callers spread the result conditionally, because Electron renders a
 * blank gutter for an empty NativeImage. macOS draws SF Symbols and only from
 * Tahoe, where they are available; Linux and Windows use themed PNGs.
 */
export function getMenuIcon(action: MenuIconKey): Electron.NativeImage | undefined {
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

  return getLinuxTrayIconPath();
}

function escapePango(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Replaces `&` with a fullwidth ampersand (U+FF06) for Linux menu labels.
 * Electron escapes labels only partially for GTK/Pango and leaves a bare `&`,
 * which Pango reads as the start of a markup entity and then rejects the label.
 * macOS and Windows need no such substitution, so callers apply this on Linux only.
 */
export function sanitiseLinuxLabel(text: string): string {
  return text.replace(/&/g, '\uFF06');
}

/**
 * Shortens a track, artist or album name for a menu row. The text is first cut
 * at the opening bracket of a trailing qualifier such as "(Remastered 2011)",
 * which carries little for the reader and consumes the whole row, then
 * ellipsised at maxLength so one long title cannot stretch the menu.
 */
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
let applyZoomCallback: ((factor: number) => void) | null = null;
let getMainWindowCallback: (() => BrowserWindow | null) | null = null;
let switchServiceCallback: ((serviceId: MusicServiceId) => void) | null = null;

interface SubmenuContext {
  strings: TrayStrings;
  isLinux: boolean;
  refresh: () => void;
}

function buildPlayerSubmenu(ctx: SubmenuContext): Electron.MenuItemConstructorOptions {
  const { strings } = ctx;
  const activeServiceId = getMusicService();
  const activeService = getService(activeServiceId);
  const parentLabel = `${strings.player}: ${activeService.displayName}`;
  const icon = getMenuIcon('player');
  return {
    label: parentLabel,
    ...(icon ? { icon } : {}),
    submenu: allServices().map(svc => ({
      label: svc.displayName,
      type: 'radio' as const,
      checked: activeServiceId === svc.id,
      // switchService in ./serviceSwitch persists the new id and rebuilds this
      // menu, so the click does neither itself.
      click: () => {
        if (activeServiceId === svc.id) return;
        if (switchServiceCallback) switchServiceCallback(svc.id);
      },
    })),
  };
}

// Typed over every registry id, so adding a start page without a translation
// fails tsc rather than rendering a blank menu entry.
function startPageLabels(strings: TrayStrings): Record<AnyStartPageId | 'last', string> {
  return {
    'home': strings.startPageHome,
    'new': strings.startPageNew,
    'radio': strings.startPageRadio,
    'all-playlists': strings.startPageAllPlaylists,
    'browse': strings.startPageBrowse,
    'playlists': strings.startPagePlaylists,
    'search': strings.startPageSearch,
    'last': strings.startPageLast,
  };
}

function buildStartPageSubmenuFor<PageId extends AnyStartPageId>(
  service: MusicService<PageId>,
  storedPage: PageId | 'last',
  setPage: (page: PageId | 'last') => void,
  ctx: SubmenuContext,
): Electron.MenuItemConstructorOptions {
  const { strings, refresh } = ctx;
  const labels = startPageLabels(strings);
  // 'last' is not a registry page: it is a stored-URL mode both services offer.
  const pageIds: (PageId | 'last')[] = [...service.startPages.map(page => page.id), 'last'];
  // A page id no longer offered resolves to the service's defaultStartPage, matching buildAppleMusicURL.
  const currentPage = pageIds.includes(storedPage) ? storedPage : service.defaultStartPage;
  const icon = getMenuIcon('start-page');
  return {
    label: `${strings.startPage}: ${labels[currentPage]}`,
    ...(icon ? { icon } : {}),
    submenu: pageIds.map(id => ({
      label: labels[id],
      type: 'radio' as const,
      checked: currentPage === id,
      click: () => { setPage(id); refresh(); },
    })),
  };
}

// The registry entries are passed directly rather than through getService(), which
// returns the widened MusicService and would lose each service's page id union.
function buildStartPageSubmenu(ctx: SubmenuContext): Electron.MenuItemConstructorOptions {
  if (getMusicService() === 'classical') {
    return buildStartPageSubmenuFor(MUSIC_SERVICES.classical, getClassicalStartPage(), setClassicalStartPage, ctx);
  }
  return buildStartPageSubmenuFor(MUSIC_SERVICES.music, getStartPage(), setStartPage, ctx);
}

interface ToggleSubmenuOptions {
  label: string;
  iconKey: MenuIconKey;
  get: () => boolean;
  set: (value: boolean) => void;
  onEnable?: () => void;
  onDisable?: () => void;
  extraItems?: Electron.MenuItemConstructorOptions[];
}

/**
 * Parent item for an on/off preference: a "Label: On" row over the two radio
 * choices. The side effect runs after the setter and before refresh, so the
 * rebuilt menu already reads the new state.
 */
function buildToggleSubmenu(options: ToggleSubmenuOptions, ctx: SubmenuContext): Electron.MenuItemConstructorOptions {
  const { strings, refresh } = ctx;
  const { label, iconKey, get, set, onEnable, onDisable, extraItems } = options;
  const enabled = get();
  const icon = getMenuIcon(iconKey);
  return {
    label: `${label}: ${enabled ? strings.on : strings.off}`,
    ...(icon ? { icon } : {}),
    submenu: [
      {
        label: strings.on,
        type: 'radio' as const,
        checked: enabled,
        click: () => { set(true); onEnable?.(); refresh(); },
      },
      {
        label: strings.off,
        type: 'radio' as const,
        checked: !enabled,
        click: () => { set(false); onDisable?.(); refresh(); },
      },
      ...(extraItems ?? []),
    ],
  };
}

function buildNotificationsSubmenu(ctx: SubmenuContext): Electron.MenuItemConstructorOptions {
  return buildToggleSubmenu({
    label: ctx.strings.notifications,
    iconKey: 'notifications',
    get: getNotificationsEnabled,
    set: setNotificationsEnabled,
  }, ctx);
}

function buildCloseToTraySubmenu(ctx: SubmenuContext): Electron.MenuItemConstructorOptions {
  return buildToggleSubmenu({
    label: ctx.strings.closeToTray,
    iconKey: 'close-to-tray',
    get: getCloseToTrayEnabled,
    set: setCloseToTrayEnabled,
    onDisable: () => {
      const mainWin = getMainWindowCallback?.();
      if (mainWin && !mainWin.isVisible()) { mainWin.show(); mainWin.focus(); }
    },
  }, ctx);
}

function buildDiscordSubmenu(ctx: SubmenuContext): Electron.MenuItemConstructorOptions {
  return buildToggleSubmenu({
    label: ctx.strings.discord,
    iconKey: 'discord',
    get: getDiscordEnabled,
    set: setDiscordEnabled,
    onEnable: enableDiscord,
    onDisable: disableDiscord,
  }, ctx);
}

function buildLastfmSubmenu(ctx: SubmenuContext): Electron.MenuItemConstructorOptions {
  const { strings, refresh } = ctx;
  const connected = !!getLastfmSessionKey();

  // Not yet linked: a single, obvious call to action that opens the browser
  // approval flow. No API keys or configuration for the user to deal with.
  if (!connected) {
    const icon = getMenuIcon('lastfm');
    return {
      label: 'Last.fm',
      ...(icon ? { icon } : {}),
      submenu: [
        {
          label: strings.lastfmConnect,
          click: () => { setLastfmEnabled(true); startLastfmAuth(refresh); refresh(); },
        },
      ],
    };
  }

  const username = getLastfmUsername();
  return buildToggleSubmenu({
    label: 'Last.fm',
    iconKey: 'lastfm',
    get: getLastfmEnabled,
    set: setLastfmEnabled,
    onEnable: enableLastfm,
    onDisable: disableLastfm,
    extraItems: [
      { type: 'separator' },
      { label: `✓ ${username}`, enabled: false },
      { label: strings.lastfmDisconnect, click: () => { disconnectLastfm(); refresh(); } },
    ],
  }, ctx);
}

function buildStyleSubmenu(ctx: SubmenuContext): Electron.MenuItemConstructorOptions {
  const { strings, refresh } = ctx;
  const currentTheme = resolveTheme();
  const parentLabel = `${strings.style}: ${currentTheme === 'apple-music' ? strings.styleAppleMusic : themeLabel(currentTheme)}`;
  const icon = getMenuIcon('style');
  const items: Electron.MenuItemConstructorOptions[] = [
    {
      label: strings.styleAppleMusic,
      type: 'radio',
      checked: currentTheme === 'apple-music',
      click: () => { setTheme('apple-music'); applyTheme('apple-music'); refresh(); },
    },
    ...BUNDLED_THEMES.map(theme => ({
      label: theme.label,
      type: 'radio' as const,
      checked: currentTheme === theme.name,
      click: () => { setTheme(theme.name); applyTheme(theme.name); refresh(); },
    })),
  ];
  if (hasCustomCss()) {
    items.push({
      label: themeLabel('custom'),
      type: 'radio',
      checked: currentTheme === 'custom',
      click: () => { setTheme('custom'); applyTheme('custom'); refresh(); },
    });
  }
  return {
    label: parentLabel,
    ...(icon ? { icon } : {}),
    submenu: items,
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
        click: () => { openExternalUrl(update.url, trayLog); },
      },
    ];
  }
  return [
    { type: 'separator' },
    { label: updateStrings.upToDate, enabled: false },
  ];
}

/** Artwork icon for the track row, multi-representation for HiDPI. */
function buildArtworkIcon(artworkPath: string | null, isLinux: boolean): Electron.NativeImage | undefined {
  if (!artworkPath) return undefined;
  const src = nativeImage.createFromPath(artworkPath);
  if (src.isEmpty()) return undefined;

  if (isLinux) {
    // libdbusmenu serialises a single image and the host shell rescales;
    // preserve the on-disk path so libappindicator does not stage a
    // temp-file copy unreachable to the host indicator daemon under snap.
    return src.resize({ width: 24, height: 24 });
  }

  const img = nativeImage.createEmpty();
  const sizes: [number, number][] = [[1.0, 18], [1.25, 23], [1.5, 27], [1.75, 32], [2.0, 36]];
  for (const [scaleFactor, size] of sizes) {
    img.addRepresentation({ scaleFactor, buffer: src.resize({ width: size, height: size }).toPNG() });
  }
  return img;
}

/**
 * One disabled metadata row. The label is user content Apple supplies, so it
 * goes through sanitiseLinuxLabel on Linux to keep Pango from reading it as markup.
 */
function buildMetadataItem(text: string, icon: Electron.NativeImage | undefined, isLinux: boolean): Electron.MenuItemConstructorOptions {
  const label = truncateMenuLabel(text);
  return {
    label: isLinux ? sanitiseLinuxLabel(label) : label,
    enabled: false,
    ...(icon ? { icon } : {}),
  };
}

// 1981 is the last year before the CD shipped, so 1981 and earlier shows the vinyl icon.
function albumIconKey(releaseDate: string | undefined): MenuIconKey {
  const releaseYear = releaseDate ? parseInt(releaseDate.slice(0, 4), 10) : NaN;
  return !isNaN(releaseYear) && releaseYear <= 1981 ? 'record-vinyl' : 'album';
}

function buildMetadataItems(payload: NowPlayingPayload, artworkIcon: Electron.NativeImage | undefined, isLinux: boolean): Electron.MenuItemConstructorOptions[] {
  return [
    buildMetadataItem(payload.name ?? '', artworkIcon, isLinux),
    buildMetadataItem(payload.artistName ?? '', getMenuIcon('artist'), isLinux),
    buildMetadataItem(payload.albumName ?? '', getMenuIcon(albumIconKey(payload.releaseDate)), isLinux),
  ];
}

function buildTransportItems(strings: TrayStrings, isPlaying: boolean): Electron.MenuItemConstructorOptions[] {
  const item = (label: string, iconKey: MenuIconKey, channel: ReceiveChannel): Electron.MenuItemConstructorOptions => {
    const icon = getMenuIcon(iconKey);
    return {
      label,
      ...(icon ? { icon } : {}),
      click: () => sendCommand(channel),
    };
  };
  return [
    item(strings.previous, 'previous', 'player:previous'),
    item(isPlaying ? strings.pause : strings.play, isPlaying ? 'pause' : 'play', 'player:playPause'),
    item(strings.next, 'next', 'player:next'),
  ];
}

// 0 is offered as Mute; the other four take their label from the value.
const VOLUME_LEVELS = [0, 0.25, 0.5, 0.75, 1];

function buildVolumeSubmenu(strings: TrayStrings, volume: number): Electron.MenuItemConstructorOptions {
  const icon = getMenuIcon('volume');
  return {
    label: `${strings.volume}: ${Math.round(volume * 100)}%`,
    ...(icon ? { icon } : {}),
    submenu: VOLUME_LEVELS.map(level => ({
      label: level === 0 ? strings.mute : `${Math.round(level * 100)}%`,
      type: 'radio' as const,
      checked: volume === level,
      click: () => sendCommand('player:setVolume', level),
    })),
  };
}

// macOS only - uses the native share sheet via ShareMenu.
function buildShareItems(strings: TrayStrings, payload: NowPlayingPayload): Electron.MenuItemConstructorOptions[] {
  const shareUrl = getShareUrl(payload);
  if (process.platform !== 'darwin' || !shareUrl) return [];
  const icon = getMenuIcon('share');
  return [{
    label: strings.share,
    ...(icon ? { icon } : {}),
    click: () => {
      const shareMenu = new ShareMenu({ urls: [shareUrl] });
      shareMenu.popup();
    },
  }];
}

function buildNowPlayingMenuItems(strings: TrayStrings, isLinux: boolean): Electron.MenuItemConstructorOptions[] {
  if (!nowPlayingState || !nowPlayingState.payload) {
    return [];
  }

  const { payload, artworkPath, isPlaying, volume } = nowPlayingState;

  return [
    ...buildMetadataItems(payload, buildArtworkIcon(artworkPath, isLinux), isLinux),
    { type: 'separator' },
    ...buildTransportItems(strings, isPlaying),
    buildVolumeSubmenu(strings, volume),
    ...buildShareItems(strings, payload),
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

  const showWindowItems: Electron.MenuItemConstructorOptions[] = [];
  if (getCloseToTrayEnabled()) {
    const windowVisible = getMainWindowCallback?.()?.isVisible() ?? true;
    if (windowVisible) {
      const hideIcon = getMenuIcon('hide-window');
      showWindowItems.push({
        label: strings.hideWindow,
        ...(hideIcon ? { icon: hideIcon } : {}),
        click: () => { getMainWindowCallback?.()?.hide(); refresh(); },
      });
    } else {
      const showIcon = getMenuIcon('show-window');
      showWindowItems.push({
        label: strings.showWindow,
        ...(showIcon ? { icon: showIcon } : {}),
        click: () => { const w = getMainWindowCallback?.(); w?.show(); w?.focus(); refresh(); },
      });
    }
  }

  const menuItems: Electron.MenuItemConstructorOptions[] = [
    ...showWindowItems,
    ...buildNowPlayingMenuItems(strings, isLinux),
    {
      label: strings.about,
      ...(aboutIcon ? { icon: aboutIcon } : {}),
      click: () => showAboutWindow(),
    },
    buildPlayerSubmenu(ctx),
    buildStartPageSubmenu(ctx),
    buildCloseToTraySubmenu(ctx),
    buildNotificationsSubmenu(ctx),
    buildDiscordSubmenu(ctx),
    ...(isLastfmConfigured() ? [buildLastfmSubmenu(ctx)] : []),
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

export function setGetMainWindowCallback(callback: () => BrowserWindow | null): void {
  getMainWindowCallback = callback;
}

export function setSwitchServiceCallback(callback: (serviceId: MusicServiceId) => void): void {
  switchServiceCallback = callback;
}

export function updateNowPlayingState(payload: NowPlayingPayload | null, artworkPath: string | null, isPlaying: boolean, volume: number): void {
  nowPlayingState = { payload, artworkPath, isPlaying, volume };
}

export function rebuildTrayMenu(tray: Tray): void {
  tray.setContextMenu(buildContextMenu(tray));
}

// Playback, volume and now-playing events arrive in bursts: the hook polls
// mk.volume every 250ms while the slider moves, and the renderer can emit far
// faster than that. Each rebuild walks every submenu, reads custom.css and
// resizes the artwork five times, so a burst is collapsed into one rebuild.
const TRAY_REBUILD_COALESCE_MS = 250;

let rebuildTimer: NodeJS.Timeout | null = null;
let pendingRebuildTray: Tray | null = null;

// A fixed window rather than a debounce: a debounce that restarts on every
// event never expires under a sustained flood, so the menu would never rebuild.
function scheduleTrayRebuild(tray: Tray): void {
  pendingRebuildTray = tray;
  if (rebuildTimer) return;
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    const target = pendingRebuildTray;
    pendingRebuildTray = null;
    if (target) rebuildTrayMenu(target);
  }, TRAY_REBUILD_COALESCE_MS);
}

export function cancelTrayRebuild(): void {
  if (rebuildTimer) {
    clearTimeout(rebuildTimer);
    rebuildTimer = null;
  }
  pendingRebuildTray = null;
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

  tray.on('click', () => {
    if (!getCloseToTrayEnabled()) return;
    const mainWin = getMainWindowCallback?.();
    if (!mainWin) return;
    if (mainWin.isVisible()) {
      mainWin.focus();
    } else {
      mainWin.show();
      mainWin.focus();
      rebuildTrayMenu(tray);
    }
  });

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

/**
 * Keeps the tray menu and tooltip in step with playback, and clears Now Playing
 * once a pause has lasted TRAY_PAUSE_TIMEOUT_MS. The caller must register the
 * returned closure on will-quit: it destroys the pause timer, cancels a pending
 * rebuild and removes the three player listeners, all of which otherwise outlive
 * the tray they act on.
 */
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
    scheduleTrayRebuild(tray);
  };

  const trayPauseTimer = createPauseTimer(TRAY_PAUSE_TIMEOUT_MS, clearNowPlaying);

  const onNowPlayingItemDidChange = async (payload: NowPlayingPayload | null): Promise<void> => {
    trayPauseTimer.cancel();
    if (!payload) {
      trayLog.debug('nowPlayingItemDidChange (tray handler): null payload, clearing state');
      currentPayload = null;
      currentArtworkPath = null;
      updateTrayTooltip(tray, null);
      updateNowPlayingState(null, null, false, currentVolume);
      scheduleTrayRebuild(tray);
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
    scheduleTrayRebuild(tray);
  };

  const onPlaybackStateDidChange = (payload: { status: boolean; state: number } | null): void => {
    const state = payload?.state ?? 0;
    if (isTerminalPlaybackState(state)) {
      trayPauseTimer.cancel();
      updateTrayTooltip(tray, null);
      currentPayload = null;
      currentArtworkPath = null;
      updateNowPlayingState(null, null, false, currentVolume);
      scheduleTrayRebuild(tray);
      return;
    }
    const { isPlaying } = player.playbackSnapshot();

    // The timer is armed on the playing-to-paused edge only. Paused states
    // repeat, and starting it on each one would push the clear-down further
    // away every time, so a paused player would keep its Now Playing rows.
    if (isPlaying) {
      trayPauseTimer.cancel();
    }
    if (!isPlaying && previousPlaying) {
      trayPauseTimer.start();
    }
    previousPlaying = isPlaying;

    updateNowPlayingState(currentPayload, currentArtworkPath, isPlaying, currentVolume);
    scheduleTrayRebuild(tray);
  };

  const onVolumeDidChange = (volume: number | null): void => {
    if (volume == null) return;
    currentVolume = volume;
    const { isPlaying } = player.playbackSnapshot();
    updateNowPlayingState(currentPayload, currentArtworkPath, isPlaying, currentVolume);
    scheduleTrayRebuild(tray);
  };

  player.on('nowPlayingItemDidChange', onNowPlayingItemDidChange);
  player.on('playbackStateDidChange', onPlaybackStateDidChange);
  player.on('volumeDidChange', onVolumeDidChange);

  return () => {
    trayPauseTimer.destroy();
    cancelTrayRebuild();
    player.off('nowPlayingItemDidChange', onNowPlayingItemDidChange);
    player.off('playbackStateDidChange', onPlaybackStateDidChange);
    player.off('volumeDidChange', onVolumeDidChange);
  };
}
