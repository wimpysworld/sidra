import { app, BrowserWindow, components, ipcMain, Menu, nativeTheme, session, shell, Tray } from 'electron';
import fs from 'fs';
import path from 'path';
import log from 'electron-log/main';
import { getStorefront, setStorefront, getLanguage, setLanguage, getCatppuccinEnabled, getStartPage } from './config';
import { getLoadingText, getStorefront as getLocaleStorefront } from './i18n';
import { getAssetPath } from './paths';
import { Player } from './player';
import { createTray, rebuildTrayMenu } from './tray';
import { checkForUpdates } from './update';
import { isAutoUpdateSupported, initAutoUpdate } from './autoUpdate';
import { init as initNotifications } from './integrations/notifications';
import { init as initDiscordPresence } from './integrations/discord-presence';
import { init as initWedgeDetector, reset as resetWedgeDetector } from './wedgeDetector';

// --- Logging: initialise before anything else ---
log.initialize();
log.transports.file.level = 'info';
log.transports.console.level = 'debug';
log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}]{scope} {text}';
log.transports.console.format = '{h}:{i}:{s}.{ms} [{level}]{scope} {text}';

// Override log levels via environment variable (used by `just run-debug`)
if (process.env.ELECTRON_LOG_LEVEL) {
  const level = process.env.ELECTRON_LOG_LEVEL as 'error' | 'warn' | 'info' | 'debug' | 'silly';
  log.transports.file.level = level;
  log.transports.console.level = level;
}

const mainLog = log.scope('main');
const splashLog = log.scope('splash');
mainLog.info(`${app.name} ${app.getVersion()}`);

// --- App identity: required on Windows for notifications to appear ---
if (process.platform === 'win32') {
  app.setAppUserModelId('com.wimpysworld.sidra');
}

// --- Platform switches: must run before app.whenReady() ---
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-features', 'UseOzonePlatform,WaylandWindowDecorations');
  app.commandLine.appendSwitch('disable-features', 'MediaSessionService,WaylandWpColorManagerV1,AudioServiceOutOfProcess');
  // Set the XDG desktop name so GetXdgAppId() returns 'sidra' and
  // GetPossiblyOverriddenApplicationName() can read Name= from sidra.desktop.
  // Required for correct PulseAudio stream identity once Kesefon's patch lands.
  (app as unknown as { setDesktopName(name: string): void }).setDesktopName('sidra.desktop');
  mainLog.info('Linux platform switches applied');
}

// Ensure Discord IPC socket path resolves correctly on macOS GUI launch
if (process.platform === 'darwin') process.env.TMPDIR = app.getPath('temp');

// Use a platform-accurate Chrome UA, stripping Electron identifiers that
// Apple Music detects and blocks. The platform component must be truthful
// to match Sec-CH-UA-Platform Client Hints sent on every request.
// Chrome version 144.0.0.0 matches the Chromium build in CastLabs ECS v40.7.0+wvcus.
function chromeUA(): string {
  const version = '144.0.0.0';
  const webkit = 'AppleWebKit/537.36 (KHTML, like Gecko)';
  const safari = 'Safari/537.36';
  if (process.platform === 'darwin') {
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${webkit} Chrome/${version} ${safari}`;
  }
  if (process.platform === 'win32') {
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${webkit} Chrome/${version} ${safari}`;
  }
  return `Mozilla/5.0 (X11; Linux x86_64) ${webkit} Chrome/${version} ${safari}`;
}

// Set fallback UA before app.whenReady() so any early requests use it
const UA = chromeUA();
app.userAgentFallback = UA;

// Prevent garbage collection of tray icon
let appTray: Tray | null = null;

// Track injected Catppuccin CSS for live toggle
let catppuccinCssKey: string | null = null;

function buildAppleMusicURL(): string {
  let storefront = getStorefront();
  let source: string;

  if (storefront !== undefined) {
    source = 'persisted';
  } else {
    storefront = getLocaleStorefront();
    source = storefront === 'us' ? 'fallback' : 'detected';
  }

  mainLog.info(`storefront resolved: ${storefront} (${source})`);

  const pagePathMap: Record<string, string> = {
    'home': 'home',
    'new': 'new',
    'radio': 'radio',
    'all-playlists': 'library/all-playlists/',
  };
  const pagePath = pagePathMap[getStartPage()];
  let url = `https://music.apple.com/${storefront}/${pagePath}`;
  const language = getLanguage();
  if (language !== undefined && language !== null) {
    url += `?l=${language}`;
  }

  return url;
}

function extractStorefrontFromURL(url: string): { storefront: string; language: string | null } | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'music.apple.com') {
      return null;
    }
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length === 0) {
      return null;
    }
    const storefront = segments[0];
    if (!/^[a-z]{2}$/.test(storefront)) {
      return null;
    }
    const language = parsed.searchParams.get('l');
    return { storefront, language };
  } catch {
    return null;
  }
}

function handleStorefrontNavigation(url: string): void {
  const result = extractStorefrontFromURL(url);
  if (!result) {
    return;
  }

  const currentStorefront = getStorefront();
  const currentLanguage = getLanguage();
  const nextLanguage = result.language ?? currentLanguage ?? null;

  if (result.storefront !== currentStorefront) {
    setStorefront(result.storefront);
  }
  if (nextLanguage !== currentLanguage) {
    setLanguage(nextLanguage);
  }
  if (result.storefront !== currentStorefront || nextLanguage !== currentLanguage) {
    mainLog.info(`storefront changed: ${result.storefront} (language: ${nextLanguage})`);
  }
}

// CSS to hide "Get the app" and "Open in Music" banners.
// Selectors confirmed across three independent Electron wrappers
// (apple-music-wrapper, apple-music-electron, apple-music-desktop).
// Semantic class names have been stable for 4+ years.
// Avoid Svelte hash-based selectors (svelte-*) as they change on each deploy.
const STYLE_FIX_CSS = `
  /* "Get the App" CTA in sidebar navigation */
  #navigation > div.navigation__native-cta,
  .web-navigation__native-upsell,
  .native-cta,
  [class*="native-cta"],
  [class*="native-upsell"] {
    display: none !important;
  }

  /* "Open in Music" upsell banner */
  .upsell-banner,
  [class*="upsell-banner"] {
    display: none !important;
  }

  /* Footer (not needed in desktop app) */
  footer.dt-footer {
    display: none !important;
  }
`;

// Apply or remove Catppuccin CSS on the main window.
// Handles enable, disable, and re-injection (variant change) cases.
let applyCatppuccinCSS: (enabled: boolean) => Promise<void>;

app.whenReady().then(async () => {
  mainLog.info('app ready, waiting for Widevine CDM...');

  if (process.env.SIDRA_DEVTOOLS === '1') {
    const menuTemplate: Electron.MenuItemConstructorOptions[] = [
      {
        label: 'View',
        submenu: [{ role: 'toggleDevTools' }],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
  } else {
    Menu.setApplicationMenu(null);
  }
  mainLog.info('application menu set');

  const player = new Player();
  ipcMain.on('playbackStateDidChange', (_event, data) => player.handlePlaybackStateDidChange(data));
  ipcMain.on('nowPlayingItemDidChange', (_event, data) => player.handleNowPlayingItemDidChange(data));
  ipcMain.on('playbackTimeDidChange', (_event, data) => player.handlePlaybackTimeDidChange(data));
  ipcMain.on('repeatModeDidChange', (_event, data) => player.handleRepeatModeDidChange(data));
  ipcMain.on('shuffleModeDidChange', (_event, data) => player.handleShuffleModeDidChange(data));
  ipcMain.on('volumeDidChange', (_event, data) => player.handleVolumeDidChange(data));

  appTray = createTray();

  // Show a splash screen while the Widevine CDM downloads/initialises
  const splash = new BrowserWindow({
    width: 300,
    height: 350,
    frame: false,
    resizable: false,
    center: true,
    skipTaskbar: true,
    backgroundColor: '#1a0a10',
    show: false,
  });
  let resolveMinDisplay!: () => void;
  const minDisplay = new Promise<void>(resolve => { resolveMinDisplay = resolve; });
  let resolveCssReady!: () => void;
  const cssReady = new Promise<void>(resolve => { resolveCssReady = resolve; });
  splash.once('ready-to-show', () => {
    splashLog.info('splash shown');
    splash.show();
    setTimeout(resolveMinDisplay, 500);
  });
  const { text: loadingText, lang: loadingLang } = getLoadingText();
  splash.loadFile(path.join(__dirname, 'splash.html'), { query: { text: loadingText, lang: loadingLang } });
  splashLog.info('splash created');

  // Clear stale service workers concurrently with Widevine CDM init - both are
  // independent async operations and navigation has not started yet.
  const ses = session.fromPartition('persist:sidra');
  await Promise.all([
    components.whenReady(),
    ses.clearData({
      dataTypes: ['serviceWorkers', 'cache'],
      origins: ['https://music.apple.com'],
    }),
  ]);
  mainLog.info('Widevine CDM ready, status:', components.status());

  // Set UA on the default session (updates navigator.userAgentData Client Hints)
  session.defaultSession.setUserAgent(UA);

  const catppuccinCssPath = getAssetPath('assets', 'catppuccin.css');
  const CATPPUCCIN_CSS = fs.readFileSync(catppuccinCssPath, 'utf-8');
  const navBarPath = getAssetPath('assets', 'navigationBar.js');
  const navBarScript = fs.readFileSync(navBarPath, 'utf-8');

  const win = new BrowserWindow({
    title: 'Sidra',
    width: 1280,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    webPreferences: {
      partition: 'persist:sidra',
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      plugins: true,
    },
  });

  initNotifications(player, () => win);
  initDiscordPresence(player);

  ipcMain.on('nav:back', () => win.webContents.navigationHistory.goBack());
  ipcMain.on('nav:forward', () => win.webContents.navigationHistory.goForward());
  ipcMain.on('nav:reload', () => {
    resetWedgeDetector();
    win.webContents.reload();
  });

  // MPRIS D-Bus service (Linux only) - uses require() to avoid loading dbus-next on other platforms
  if (process.platform === 'linux') {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mpris = require('./integrations/mpris');
    mpris.init(player, () => win);
  }

  initWedgeDetector(player, () => win);

  let catppuccinCssOp = Promise.resolve();
  applyCatppuccinCSS = (enabled: boolean) => {
    catppuccinCssOp = catppuccinCssOp
      .catch((error) => {
        mainLog.warn('Catppuccin CSS operation failed', error);
      })
      .then(async () => {
      if (enabled && catppuccinCssKey !== null) {
        await win.webContents.removeInsertedCSS(catppuccinCssKey);
        catppuccinCssKey = await win.webContents.insertCSS(CATPPUCCIN_CSS);
        mainLog.debug('Catppuccin CSS re-injected');
      } else if (enabled) {
        catppuccinCssKey = await win.webContents.insertCSS(CATPPUCCIN_CSS);
        mainLog.debug('Catppuccin CSS injected');
      } else if (catppuccinCssKey !== null) {
        await win.webContents.removeInsertedCSS(catppuccinCssKey);
        catppuccinCssKey = null;
        mainLog.debug('Catppuccin CSS removed');
      }
    });
    return catppuccinCssOp;
  };

  (app as NodeJS.EventEmitter).on('catppuccin-toggle', (_event: unknown, enabled: boolean) => {
    void applyCatppuccinCSS(enabled);
  });

  nativeTheme.on('updated', () => {
    if (getCatppuccinEnabled()) {
      void applyCatppuccinCSS(true);
    }
  });

  Promise.all([minDisplay, cssReady]).then(() => {
    splashLog.info('splash closed');
    splash.close();
    win.show();
  });

  // Set UA on the persist:sidra session used by the window
  ses.setUserAgent(UA);

  // Strip Electron and app name tokens from outgoing request headers
  ses.webRequest.onBeforeSendHeaders({ urls: ['https://music.apple.com/*'] }, (details, callback) => {
    const ua = details.requestHeaders['User-Agent'];
    if (ua && ua !== UA) {
      details.requestHeaders['User-Agent'] = UA;
    }
    callback({ requestHeaders: details.requestHeaders });
  });

  // Prevent the web page title from overriding the window title
  win.on('page-title-updated', (event) => {
    event.preventDefault();
  });

  win.webContents.on('did-finish-load', async () => {
    mainLog.info('page loaded:', win.webContents.getURL());
    win.webContents.insertCSS(STYLE_FIX_CSS);
    mainLog.debug('CSS fixes injected');
    if (getCatppuccinEnabled()) {
      catppuccinCssKey = await win.webContents.insertCSS(CATPPUCCIN_CSS);
      mainLog.debug('Catppuccin CSS injected');
    }
    const hookPath = getAssetPath('assets', 'musicKitHook.js');
    const hookScript = fs.readFileSync(hookPath, 'utf-8');
    win.webContents.executeJavaScript(hookScript);
    mainLog.debug('MusicKit hook injected');
    win.webContents.executeJavaScript(navBarScript);
    mainLog.debug('Navigation bar injected');
  });

  win.webContents.once('did-finish-load', () => {
    resolveCssReady();
    setTimeout(() => {
      if (appTray) {
        if (isAutoUpdateSupported()) {
          initAutoUpdate(appTray, rebuildTrayMenu);
        } else {
          checkForUpdates(appTray, rebuildTrayMenu);
        }
      }
    }, 5000);
  });

  win.webContents.once('did-fail-load', () => {
    resolveCssReady();
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    mainLog.error('page load failed:', errorCode, errorDescription);
  });

  win.webContents.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
    if (isMainFrame) {
      mainLog.debug('did-start-navigation:', url);
    }
  });
  win.webContents.on('did-navigate', (_event, url) => {
    mainLog.debug('did-navigate:', url);
    handleStorefrontNavigation(url);
  });
  win.webContents.on('did-navigate-in-page', (_event, url) => {
    handleStorefrontNavigation(url);
    win.webContents.executeJavaScript(navBarScript);
  });

  win.webContents.on('will-prevent-unload', (event) => {
    event.preventDefault();
  });

  // Open external links in the system browser (only http/https)
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        mainLog.debug('opening external URL in browser:', url);
        shell.openExternal(url);
      } else {
        mainLog.warn('blocked external URL with disallowed protocol:', url);
      }
    } catch {
      mainLog.warn('blocked malformed external URL:', url);
    }
    return { action: 'deny' };
  });

  // Open DevTools when SIDRA_DEVTOOLS=1 (for inspecting CSS, verifying AMWrapper)
  if (process.env.SIDRA_DEVTOOLS === '1') {
    win.webContents.openDevTools();
    mainLog.info('DevTools opened (SIDRA_DEVTOOLS=1)');
  }

  mainLog.info('loading Apple Music...');
  win.loadURL(buildAppleMusicURL(), { userAgent: UA });
});

app.on('window-all-closed', () => {
  mainLog.info('all windows closed, quitting');
  app.quit();
});
