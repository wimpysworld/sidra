import { app, BrowserWindow, Menu, nativeTheme, Tray } from 'electron';
import path from 'path';
import log from 'electron-log/main';
import { getTrayStrings, getAboutStrings } from './i18n';
import { getAssetPath } from './paths';
import { getNotificationsEnabled, setNotificationsEnabled, getDiscordEnabled, setDiscordEnabled, getCatppuccinEnabled, setCatppuccinEnabled } from './config';

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
  const notifGlyph = notifEnabled ? '●' : '○';
  const discordEnabled = getDiscordEnabled();
  const discordGlyph = discordEnabled ? '●' : '○';
  const catppuccinEnabled = getCatppuccinEnabled();
  const catppuccinGlyph = catppuccinEnabled ? '●' : '○';
  const menuItems: Electron.MenuItemConstructorOptions[] = [
    {
      label: isLinux ? `${aboutGlyph} ${strings.about}` : strings.about,
      click: () => showAboutWindow(),
    },
    {
      label: isLinux ? `${notifGlyph} ${strings.notifications}` : strings.notifications,
      type: 'checkbox',
      checked: notifEnabled,
      click: (menuItem) => {
        setNotificationsEnabled(menuItem.checked);
        tray.setContextMenu(buildContextMenu(tray));
      },
    },
    {
      label: isLinux ? `${discordGlyph} ${strings.discord}` : strings.discord,
      type: 'checkbox',
      checked: discordEnabled,
      click: (menuItem) => {
        setDiscordEnabled(menuItem.checked);
        tray.setContextMenu(buildContextMenu(tray));
      },
    },
    {
      label: isLinux ? `${catppuccinGlyph} ${strings.catppuccin}` : strings.catppuccin,
      type: 'checkbox',
      checked: catppuccinEnabled,
      click: (menuItem) => {
        setCatppuccinEnabled(menuItem.checked);
        app.emit('catppuccin-toggle', {}, menuItem.checked);
        tray.setContextMenu(buildContextMenu(tray));
      },
    },
  ];

  menuItems.push(
    { type: 'separator' },
    {
      label: isLinux ? `${quitGlyph} ${strings.quit}` : strings.quit,
      click: () => app.quit(),
    },
  );

  return Menu.buildFromTemplate(menuItems);
}

export function createTray(): Tray {
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
