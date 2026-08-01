import { app, BrowserWindow } from 'electron';
import log from 'electron-log/main';
import { getTrayStrings, getAboutStrings } from './i18n';
import { getAssetPath, getProductInfo } from './paths';
import { getZoomFactor } from './config';

const ABOUT_WINDOW_WIDTH_PX = 400;
const ABOUT_WINDOW_HEIGHT_PX = 400;

const aboutLog = log.scope('about');

let aboutWindow: BrowserWindow | null = null;

/** Show the About window, or focus the one already open. */
export function showAboutWindow(): void {
  if (aboutWindow) {
    aboutWindow.focus();
    return;
  }

  aboutLog.info('showing About window');
  // The window is not resizable, so its size must scale with the zoom factor
  // applied to the contents or the page is clipped
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

  // Held back until the page has rendered, so the window never flashes empty
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

  // The page is sandboxed with no preload, so every string and every product
  // detail reaches it as a query parameter
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
      year: String(new Date().getFullYear()),
    },
  });
}
