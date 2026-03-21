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

// --- Platform switches: must run before app.whenReady() ---
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-features', 'UseOzonePlatform,WaylandWindowDecorations');
  app.commandLine.appendSwitch('disable-features', 'MediaSessionService');
  mainLog.info('Linux platform switches applied');
}

// Always send a Linux Chrome UA regardless of platform.
// Apple Music does not enforce production Widevine on Linux clients;
// spoofing a Linux UA bypasses DRM enforcement that blocks playback on macOS.
// Chromium 144 matches CastLabs Electron v40.7.0+wvcus.
const CHROME_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36';

// Set fallback UA before app.whenReady() so any early requests use it
app.userAgentFallback = CHROME_UA;

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
  await components.whenReady();
  mainLog.info('Widevine CDM ready, status:', components.status());

  // Set UA on the default session (updates navigator.userAgentData Client Hints)
  session.defaultSession.setUserAgent(CHROME_UA);

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
  ses.setUserAgent(CHROME_UA);

  // Strip Electron and app name tokens from outgoing request headers
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const ua = details.requestHeaders['User-Agent'];
    if (ua && ua !== CHROME_UA) {
      details.requestHeaders['User-Agent'] = CHROME_UA;
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
  win.loadURL(APPLE_MUSIC_URL, { userAgent: CHROME_UA });
});

app.on('window-all-closed', () => {
  mainLog.info('all windows closed, quitting');
  app.quit();
});
