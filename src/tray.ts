import { app, BrowserWindow, Menu, nativeTheme, shell, Tray } from 'electron';
import path from 'path';
import log from 'electron-log/main';
import { getTrayStrings, getAboutStrings, getUpdateStrings, getAutoUpdateStrings, type TrayStrings } from './i18n';
import { getAssetPath, getProductInfo } from './paths';
import { getNotificationsEnabled, setNotificationsEnabled, getDiscordEnabled, setDiscordEnabled, getTheme, setTheme, getStartPage, setStartPage, getZoomFactor, setZoomFactor } from './config';
import { getUpdateInfo } from './update';
import { quitAndInstall } from './autoUpdate';
import { applyTheme } from './theme';

const ABOUT_WINDOW_WIDTH_PX = 400;
const ABOUT_WINDOW_HEIGHT_PX = 400;

const trayLog = log.scope('tray');

const iconsDir = getAssetPath('assets', 'icons');

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

let aboutWindow: BrowserWindow | null = null;
let applyZoomCallback: ((factor: number) => void) | null = null;

function showAboutWindow(): void {
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
  const { strings, isLinux, refresh } = ctx;
  const currentStartPage = getStartPage();
  const startPageLabelMap: Record<string, string> = {
    'home': strings.startPageHome,
    'new': strings.startPageNew,
    'radio': strings.startPageRadio,
    'all-playlists': strings.startPageAllPlaylists,
    'last': strings.startPageLast,
  };
  const startPageGlyph = '♪';
  const parentLabel = `${strings.startPage}: ${startPageLabelMap[currentStartPage]}`;
  return {
    label: isLinux ? `${startPageGlyph} ${parentLabel}` : parentLabel,
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
  const { strings, isLinux, refresh } = ctx;
  const notifEnabled = getNotificationsEnabled();
  const notifGlyph = '🕭';
  const parentLabel = `${strings.notifications}: ${notifEnabled ? strings.on : strings.off}`;
  return {
    label: isLinux ? `${notifGlyph} ${parentLabel}` : parentLabel,
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
  const { strings, isLinux, refresh } = ctx;
  const discordEnabled = getDiscordEnabled();
  const discordGlyph = '🗫';
  const parentLabel = `${strings.discord}: ${discordEnabled ? strings.on : strings.off}`;
  return {
    label: isLinux ? `${discordGlyph} ${parentLabel}` : parentLabel,
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
  const { strings, isLinux, refresh } = ctx;
  const currentTheme = getTheme();
  const styleGlyph = '🌢';
  const parentLabel = `${strings.style}: ${currentTheme === 'catppuccin' ? strings.catppuccin : strings.styleAppleMusic}`;
  return {
    label: isLinux ? `${styleGlyph} ${parentLabel}` : parentLabel,
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
  const { strings, isLinux, refresh, applyZoom } = ctx;
  const zoomFactor = getZoomFactor();
  const zoomGlyph = '%';
  const zoomLabelMap: Record<number, string> = { 1.0: strings.zoom100, 1.25: strings.zoom125, 1.5: strings.zoom150, 1.75: strings.zoom175, 2.0: strings.zoom200 };
  const parentLabel = `${strings.zoom}: ${zoomLabelMap[zoomFactor] ?? `${Math.round(zoomFactor * 100)}%`}`;
  const makeClick = (factor: number) => () => { setZoomFactor(factor); if (applyZoom) applyZoom(factor); refresh(); };
  return {
    label: isLinux ? `${zoomGlyph} ${parentLabel}` : parentLabel,
    submenu: [
      { label: strings.zoom100, type: 'radio', checked: zoomFactor === 1.0, click: makeClick(1.0) },
      { label: strings.zoom125, type: 'radio', checked: zoomFactor === 1.25, click: makeClick(1.25) },
      { label: strings.zoom150, type: 'radio', checked: zoomFactor === 1.5, click: makeClick(1.5) },
      { label: strings.zoom175, type: 'radio', checked: zoomFactor === 1.75, click: makeClick(1.75) },
      { label: strings.zoom200, type: 'radio', checked: zoomFactor === 2.0, click: makeClick(2.0) },
    ],
  };
}

function buildUpdateMenuItems(isLinux: boolean): Electron.MenuItemConstructorOptions[] {
  const update = getUpdateInfo();
  const updateStrings = getUpdateStrings();
  if (update && update.ready) {
    const autoUpdateStrings = getAutoUpdateStrings();
    const readyGlyph = '⟳';
    return [
      { type: 'separator' },
      {
        label: isLinux ? `${readyGlyph} ${autoUpdateStrings.ready}` : autoUpdateStrings.ready,
        click: () => { quitAndInstall(); },
      },
    ];
  } else if (update) {
    const updateLabel = updateStrings.updateAvailable.replace('{version}', update.version);
    const updateGlyph = '⬆';
    return [
      { type: 'separator' },
      {
        label: isLinux ? `${updateGlyph} ${updateLabel}` : updateLabel,
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

function buildContextMenu(tray: Tray): Menu {
  const refresh = () => tray.setContextMenu(buildContextMenu(tray));
  const strings = getTrayStrings();
  const isLinux = process.platform === 'linux';
  const ctx: SubmenuContext = { strings, isLinux, refresh };
  const aboutGlyph = '🛈';
  const quitGlyph = '🆇';

  const menuItems: Electron.MenuItemConstructorOptions[] = [
    {
      label: isLinux ? `${aboutGlyph} ${strings.about}` : strings.about,
      click: () => showAboutWindow(),
    },
    buildStartPageSubmenu(ctx),
    buildNotificationsSubmenu(ctx),
    buildDiscordSubmenu(ctx),
    buildStyleSubmenu(ctx),
    buildZoomSubmenu({ ...ctx, applyZoom: applyZoomCallback }),
    ...buildUpdateMenuItems(isLinux),
    { type: 'separator' },
    {
      label: isLinux ? `${quitGlyph} ${strings.quit}` : strings.quit,
      click: () => app.quit(),
    },
  ];

  return Menu.buildFromTemplate(menuItems);
}

export function setApplyZoomCallback(callback: (factor: number) => void): void {
  applyZoomCallback = callback;
}

export function rebuildTrayMenu(tray: Tray): void {
  tray.setContextMenu(buildContextMenu(tray));
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
      trayLog.info('theme changed, switching icon:', newIconPath);
      tray.setImage(newIconPath);
    });
  }

  trayLog.info('tray created');

  return tray;
}
