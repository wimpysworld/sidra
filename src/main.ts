import { app, BrowserWindow, components, session, shell } from 'electron';
import path from 'path';
import log from 'electron-log/main';

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

// --- Platform switches: must run before app.whenReady() ---
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-features', 'UseOzonePlatform,WaylandWindowDecorations');
  app.commandLine.appendSwitch('disable-features', 'MediaSessionService,WaylandWpColorManagerV1');
  mainLog.info('Linux platform switches applied');
}

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
app.userAgentFallback = chromeUA();

const APPLE_MUSIC_URL = 'https://music.apple.com';

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

app.whenReady().then(async () => {
  mainLog.info('app ready, waiting for Widevine CDM...');

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
  let minDisplay: Promise<void>;
  splash.once('ready-to-show', () => {
    splash.show();
    splashLog.info('splash shown');
    minDisplay = new Promise(resolve => setTimeout(resolve, 500));
  });
  splash.loadFile(path.join(__dirname, 'splash.html'));
  splashLog.info('splash created');

  await Promise.all([components.whenReady(), minDisplay!]);
  splashLog.info('splash closed');
  splash.close();
  mainLog.info('Widevine CDM ready, status:', components.status());

  // Set UA on the default session (updates navigator.userAgentData Client Hints)
  session.defaultSession.setUserAgent(chromeUA());

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
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

  // Stale service workers from music.apple.com persist between launches in the
  // persist: partition and intercept requests, serving invalid cached responses.
  // Clear service workers and HTTP cache before loading, preserving auth cookies.
  const ses = session.fromPartition('persist:sidra');
  await ses.clearData({
    dataTypes: ['serviceWorkers', 'cache'],
    origins: ['https://music.apple.com'],
  });

  // Set UA on the persist:sidra session used by the window
  ses.setUserAgent(chromeUA());

  // Strip Electron and app name tokens from outgoing request headers
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const ua = details.requestHeaders['User-Agent'];
    if (ua && ua !== chromeUA()) {
      details.requestHeaders['User-Agent'] = chromeUA();
    }
    callback({ requestHeaders: details.requestHeaders });
  });

  win.webContents.on('did-finish-load', () => {
    mainLog.info('page loaded:', win.webContents.getURL());
    win.webContents.insertCSS(STYLE_FIX_CSS);
    mainLog.debug('CSS fixes injected');
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    mainLog.error('page load failed:', errorCode, errorDescription);
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
  win.loadURL(APPLE_MUSIC_URL, { userAgent: chromeUA() });
});

app.on('window-all-closed', () => {
  mainLog.info('all windows closed, quitting');
  app.quit();
});
