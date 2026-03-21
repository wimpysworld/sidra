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

// --- Localised splash text ---
const LOADING_TEXT: Record<string, string> = {
  'en': 'Loading...',
  'zh-CN': '加载中…',
  'zh-SG': '加载中…',
  'zh-TW': '載入中…',
  'zh-HK': '載入中…',
  'es': 'Cargando...',
  'hi': 'लोड हो रहा है...',
  'ar': 'جارٍ التحميل...',
  'fr': 'Chargement...',
  'pt': 'A carregar...',
  'de': 'Wird geladen...',
  'ru': 'Загрузка...',
  'ja': '読み込み中…',
  'ko': '로딩 중...',
  'it': 'Caricamento...',
  'nl': 'Laden...',
  'pl': 'Ładowanie...',
  'tr': 'Yükleniyor...',
  'sv': 'Läser in...',
  'da': 'Indlæser...',
  'fi': 'Ladataan...',
  'nb': 'Laster...',
  'no': 'Laster...',
  'cs': 'Načítání...',
  'ro': 'Se încarcă...',
  'hu': 'Betöltés...',
  'el': 'Φόρτωση...',
  'th': 'กำลังโหลด...',
  'id': 'Memuat...',
  'ms': 'Memuatkan...',
  'uk': 'Завантаження...',
  'vi': 'Đang tải...',
  'he': 'טוען...',
};

function getLoadingText(): { text: string; lang: string } {
  const langs = app.getPreferredSystemLanguages();
  for (const lang of langs) {
    // Exact match first (e.g. zh-TW)
    if (LOADING_TEXT[lang]) {
      splashLog.debug(`resolved locale: ${lang} (exact)`);
      return { text: LOADING_TEXT[lang], lang };
    }
    // Language-only match (e.g. zh from zh-TW)
    const base = lang.split('-')[0];
    if (LOADING_TEXT[base]) {
      splashLog.debug(`resolved locale: ${base} (from ${lang})`);
      return { text: LOADING_TEXT[base], lang: base };
    }
  }
  splashLog.debug('resolved locale: en (fallback)');
  return { text: LOADING_TEXT['en'], lang: 'en' };
}

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

  await components.whenReady();
  mainLog.info('Widevine CDM ready, status:', components.status());

  // Set UA on the default session (updates navigator.userAgentData Client Hints)
  session.defaultSession.setUserAgent(chromeUA());

  const win = new BrowserWindow({
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

  Promise.all([minDisplay, cssReady]).then(() => {
    splashLog.info('splash closed');
    splash.close();
    win.show();
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

  win.webContents.once('did-finish-load', () => {
    resolveCssReady();
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
