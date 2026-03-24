import { app, BrowserWindow, Menu, nativeTheme, shell, Tray } from 'electron';
import path from 'path';
import log from 'electron-log/main';
import { getTrayStrings, getAboutStrings, getUpdateStrings, getAutoUpdateStrings } from './i18n';
import { getAssetPath } from './paths';
import { getNotificationsEnabled, setNotificationsEnabled, getDiscordEnabled, setDiscordEnabled, getCatppuccinEnabled, setCatppuccinEnabled, getStartPage, setStartPage, getZoomFactor, setZoomFactor } from './config';
import { getUpdateInfo } from './update';
import { quitAndInstall } from './autoUpdate';

const trayLog = log.scope('tray');

const pkg = require(path.join(__dirname, '..', 'package.json'));

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
  aboutWindow = new BrowserWindow({
    width: 400,
    height: 400,
    frame: false,
    resizable: false,
    center: true,
    skipTaskbar: true,
    backgroundColor: '#1a0a10',
    show: false,
  });

  aboutWindow.once('ready-to-show', () => {
    aboutWindow?.show();
  });

  aboutWindow.on('closed', () => {
    aboutWindow = null;
  });

  const iconPath = getAssetPath('assets', 'sidra-logo.png');
  const author = typeof pkg.author === 'string'
    ? pkg.author.replace(/\s*<[^>]+>/, '')
    : (pkg.author?.name ?? '');
  const trayStrings = getTrayStrings();
  const aboutStrings = getAboutStrings();

  aboutWindow.loadFile(path.join(__dirname, 'about.html'), {
    query: {
      icon: iconPath,
      name: pkg.build?.productName ?? app.getName(),
      version: app.getVersion(),
      description: pkg.description ?? '',
      author,
      license: pkg.license ?? '',
      about: trayStrings.about,
      close: aboutStrings.close,
      versionPrefix: aboutStrings.versionPrefix,
      copyrightSuffix: aboutStrings.copyrightSuffix,
      licensePrefix: aboutStrings.licensePrefix,
    },
  });
}

function buildContextMenu(tray: Tray): Menu {
  const strings = getTrayStrings();
  const aboutGlyph = '🛈';
  const quitGlyph = '🆇';
  const isLinux = process.platform === 'linux';
  const notifEnabled = getNotificationsEnabled();
  const discordEnabled = getDiscordEnabled();
  const catppuccinEnabled = getCatppuccinEnabled();

  const notifGlyph = '🕭';
  const notifParentLabel = `${strings.notifications}: ${notifEnabled ? strings.on : strings.off}`;
  const discordGlyph = '🗫';
  const discordParentLabel = `${strings.discord}: ${discordEnabled ? strings.on : strings.off}`;
  const styleGlyph = '🌢';
  const styleParentLabel = `${strings.style}: ${catppuccinEnabled ? strings.catppuccin : strings.styleAppleMusic}`;

  const zoomFactor = getZoomFactor();
  const zoomGlyph = '%';
  const zoomLabelMap: Record<number, string> = { 1.0: strings.zoom100, 1.25: strings.zoom125, 1.5: strings.zoom150, 1.75: strings.zoom175, 2.0: strings.zoom200 };
  const zoomParentLabel = `${strings.zoom}: ${zoomLabelMap[zoomFactor] ?? `${Math.round(zoomFactor * 100)}%`}`;

  const currentStartPage = getStartPage();
  const startPageLabelMap: Record<string, string> = {
    'home': strings.startPageHome,
    'new': strings.startPageNew,
    'radio': strings.startPageRadio,
    'all-playlists': strings.startPageAllPlaylists,
    'last': strings.startPageLast,
  };
  const currentStartPageLabel = startPageLabelMap[currentStartPage];
  const startPageGlyph = '♪';
  const startPageParentLabel = `${strings.startPage}: ${currentStartPageLabel}`;

  const menuItems: Electron.MenuItemConstructorOptions[] = [
    {
      label: isLinux ? `${aboutGlyph} ${strings.about}` : strings.about,
      click: () => showAboutWindow(),
    },
    {
      label: isLinux ? `${startPageGlyph} ${startPageParentLabel}` : startPageParentLabel,
      submenu: [
        {
          label: strings.startPageHome,
          type: 'radio',
          checked: currentStartPage === 'home',
          click: () => { setStartPage('home'); tray.setContextMenu(buildContextMenu(tray)); },
        },
        {
          label: strings.startPageNew,
          type: 'radio',
          checked: currentStartPage === 'new',
          click: () => { setStartPage('new'); tray.setContextMenu(buildContextMenu(tray)); },
        },
        {
          label: strings.startPageRadio,
          type: 'radio',
          checked: currentStartPage === 'radio',
          click: () => { setStartPage('radio'); tray.setContextMenu(buildContextMenu(tray)); },
        },
        {
          label: strings.startPageAllPlaylists,
          type: 'radio',
          checked: currentStartPage === 'all-playlists',
          click: () => { setStartPage('all-playlists'); tray.setContextMenu(buildContextMenu(tray)); },
        },
        {
          label: strings.startPageLast,
          type: 'radio',
          checked: currentStartPage === 'last',
          click: () => { setStartPage('last'); tray.setContextMenu(buildContextMenu(tray)); },
        },
      ],
    },
    {
      label: isLinux ? `${notifGlyph} ${notifParentLabel}` : notifParentLabel,
      submenu: [
        {
          label: strings.on,
          type: 'radio',
          checked: notifEnabled,
          click: () => { setNotificationsEnabled(true); tray.setContextMenu(buildContextMenu(tray)); },
        },
        {
          label: strings.off,
          type: 'radio',
          checked: !notifEnabled,
          click: () => { setNotificationsEnabled(false); tray.setContextMenu(buildContextMenu(tray)); },
        },
      ],
    },
    {
      label: isLinux ? `${discordGlyph} ${discordParentLabel}` : discordParentLabel,
      submenu: [
        {
          label: strings.on,
          type: 'radio',
          checked: discordEnabled,
          click: () => { setDiscordEnabled(true); tray.setContextMenu(buildContextMenu(tray)); },
        },
        {
          label: strings.off,
          type: 'radio',
          checked: !discordEnabled,
          click: () => { setDiscordEnabled(false); tray.setContextMenu(buildContextMenu(tray)); },
        },
      ],
    },
    {
      label: isLinux ? `${styleGlyph} ${styleParentLabel}` : styleParentLabel,
      submenu: [
        {
          label: strings.styleAppleMusic,
          type: 'radio',
          checked: !catppuccinEnabled,
          click: () => { setCatppuccinEnabled(false); app.emit('catppuccin-toggle', {}, false); tray.setContextMenu(buildContextMenu(tray)); },
        },
        {
          label: strings.catppuccin,
          type: 'radio',
          checked: catppuccinEnabled,
          click: () => { setCatppuccinEnabled(true); app.emit('catppuccin-toggle', {}, true); tray.setContextMenu(buildContextMenu(tray)); },
        },
      ],
    },
    {
      label: isLinux ? `${zoomGlyph} ${zoomParentLabel}` : zoomParentLabel,
      submenu: [
        {
          label: strings.zoom100,
          type: 'radio',
          checked: zoomFactor === 1.0,
          click: () => { setZoomFactor(1.0); if (applyZoomCallback) applyZoomCallback(1.0); tray.setContextMenu(buildContextMenu(tray)); },
        },
        {
          label: strings.zoom125,
          type: 'radio',
          checked: zoomFactor === 1.25,
          click: () => { setZoomFactor(1.25); if (applyZoomCallback) applyZoomCallback(1.25); tray.setContextMenu(buildContextMenu(tray)); },
        },
        {
          label: strings.zoom150,
          type: 'radio',
          checked: zoomFactor === 1.5,
          click: () => { setZoomFactor(1.5); if (applyZoomCallback) applyZoomCallback(1.5); tray.setContextMenu(buildContextMenu(tray)); },
        },
        {
          label: strings.zoom175,
          type: 'radio',
          checked: zoomFactor === 1.75,
          click: () => { setZoomFactor(1.75); if (applyZoomCallback) applyZoomCallback(1.75); tray.setContextMenu(buildContextMenu(tray)); },
        },
        {
          label: strings.zoom200,
          type: 'radio',
          checked: zoomFactor === 2.0,
          click: () => { setZoomFactor(2.0); if (applyZoomCallback) applyZoomCallback(2.0); tray.setContextMenu(buildContextMenu(tray)); },
        },
      ],
    },
  ];

  const update = getUpdateInfo();
  const updateStrings = getUpdateStrings();
  if (update && update.ready) {
    const autoUpdateStrings = getAutoUpdateStrings();
    const readyGlyph = '⟳';
    menuItems.push(
      { type: 'separator' },
      {
        label: isLinux ? `${readyGlyph} ${autoUpdateStrings.ready}` : autoUpdateStrings.ready,
        click: () => {
          quitAndInstall();
        },
      },
    );
  } else if (update) {
    const updateLabel = updateStrings.updateAvailable.replace('{version}', update.version);
    const updateGlyph = '⬆';
    menuItems.push(
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
    );
  } else {
    menuItems.push(
      { type: 'separator' },
      {
        label: updateStrings.upToDate,
        enabled: false,
      },
    );
  }

  menuItems.push(
    { type: 'separator' },
    {
      label: isLinux ? `${quitGlyph} ${strings.quit}` : strings.quit,
      click: () => app.quit(),
    },
  );

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
  const productName: string = pkg.build?.productName ?? app.getName();
  tray.setToolTip(productName);

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
