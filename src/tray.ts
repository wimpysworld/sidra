import { app, BrowserWindow, Menu, nativeTheme, Tray } from 'electron';
import path from 'path';
import log from 'electron-log/main';
import { getTrayStrings, getAboutStrings } from './i18n';

const trayLog = log.scope('tray');

const pkg = require(path.join(__dirname, '..', 'package.json'));
const iconsDir = path.join(__dirname, '..', 'assets', 'icons');

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

  const iconPath = path.join(__dirname, '..', 'build', 'icon.png');
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

export function createTray(): Tray {
  const iconPath = getTrayIconPath();
  trayLog.info('creating tray with icon:', iconPath);

  const tray = new Tray(iconPath);
  const productName: string = pkg.build?.productName ?? app.getName();
  tray.setToolTip(productName);

  const strings = getTrayStrings();
  const contextMenu = Menu.buildFromTemplate([
    {
      label: strings.about,
      click: () => showAboutWindow(),
    },
    { type: 'separator' },
    {
      label: strings.quit,
      click: () => app.quit(),
    },
  ]);

  tray.setContextMenu(contextMenu);

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
