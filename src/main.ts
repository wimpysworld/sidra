import { app, BrowserWindow, components, ipcMain, Menu, session, shell, Tray, webFrameMain } from 'electron';
import fs from 'fs';
import path from 'path';
import log from 'electron-log/main';
import { getTheme, setLastPageUrl, getZoomFactor } from './config';
import { getLoadingText } from './i18n';
import { getAssetPath } from './paths';
import { Player, IntegrationContext } from './player';
import { buildAppleMusicURL, buildItmsRouteURL, handleStorefrontNavigation } from './storefront';
import { extractItmsUrlFromArgv, type ItmsTarget } from './itms';
import { initThemeCSS, setThemeCssKey } from './theme';
import { createTray, getMenuIcon, initTrayStateManager, rebuildTrayMenu, setApplyZoomCallback, setSendCommandCallback } from './tray';
import { showAboutWindow } from './aboutWindow';
import { checkForUpdates } from './update';
import { isAutoUpdateSupported, initAutoUpdate } from './autoUpdate';
import { init as initNotifications } from './integrations/notifications';
import { init as initDiscordPresence } from './integrations/discord-presence';
import { init as initDock, setDockSendCommandCallback } from './integrations/macos-dock';
import { init as initWindowsTaskbar, setTaskbarSendCommandCallback } from './integrations/windows-taskbar';
import { cleanArtworkCache } from './artwork';
import { init as initWedgeDetector, reset as resetWedgeDetector } from './wedgeDetector';
import { contentReadyProbeScript } from './contentReady';

const SPLASH_MIN_DISPLAY_MS = 500;
const CONTENT_READY_POLL_MS = 100;
const CONTENT_READY_TIMEOUT_MS = 3500;
const UPDATE_CHECK_DELAY_MS = 5000;
const SPLASH_WIDTH_PX = 300;
const SPLASH_HEIGHT_PX = 350;
const MAIN_WINDOW_WIDTH_PX = 1280;
const MAIN_WINDOW_HEIGHT_PX = 800;

// --- Logging: initialise before anything else ---
log.initialize();
log.transports.file.level = 'info';
log.transports.console.level = app.isPackaged ? false : 'debug';
log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}]{scope} {text}';
log.transports.console.format = '{h}:{i}:{s}.{ms} [{level}]{scope} {text}';

// Override log levels via environment variable (used by `just run-debug`).
type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'silly';
const VALID_LEVELS = new Set<LogLevel>(['error', 'warn', 'info', 'debug', 'silly']);
const envLevel = process.env.ELECTRON_LOG_LEVEL;
if (envLevel && VALID_LEVELS.has(envLevel as LogLevel)) {
  const level = envLevel as LogLevel;
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
  app.setDesktopName('sidra.desktop');
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

// Promoted to module scope so second-instance and pending-target handlers can
// access the main window without threading it through closures.
let win: BrowserWindow | null = null;

// Single-instance lock: forward subsequent launches to the running instance so
// itms:// URLs from a second invocation are routed instead of opening a new
// window. macOS uses LSOpenURLSpec (open-url event) and never spawns a second
// process, so the lock is unnecessary there.
const gotLock = process.platform === 'darwin' || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// Capture any itms:// argument from initial launch argv. macOS delivers URLs
// via the open-url event, not argv, and itms:// is not registered there
// (Music.app handles it natively).
let pendingItmsTarget: ItmsTarget | null =
  process.platform !== 'darwin' ? extractItmsUrlFromArgv(process.argv) : null;

function focusMainWindow(): void {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
}

function routeItmsTarget(target: ItmsTarget | null): void {
  if (!target) return;
  if (!win) {
    pendingItmsTarget = target;
    return;
  }
  if (target.kind === 'url') {
    win.loadURL(target.url, { userAgent: UA }).catch(err =>
      mainLog.warn('itms loadURL failed:', (err as Error).message)
    );
  } else {
    const url = buildItmsRouteURL(target.token);
    win.loadURL(url, { userAgent: UA }).catch(err =>
      mainLog.warn('itms route loadURL failed:', (err as Error).message)
    );
  }
  mainLog.info(`itms target routed: kind=${target.kind}`);
}

export interface Assets {
  STYLE_FIX_CSS: string;
  CATPPUCCIN_CSS: string;
  AUTH_STYLE_FIX_CSS: string;
  navBarScript: string;
  hookScript: string;
}

function createSplash(): { splash: BrowserWindow; minDisplay: Promise<void>; cssReady: Promise<void>; markCssReady: () => void } {
  const splashZoom = getZoomFactor();
  const splash = new BrowserWindow({
    width: Math.round(SPLASH_WIDTH_PX * splashZoom),
    height: Math.round(SPLASH_HEIGHT_PX * splashZoom),
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
  const { text: loadingText, lang: loadingLang } = getLoadingText();
  splash.loadFile(getAssetPath('assets', 'splash.html'), { query: { text: loadingText, lang: loadingLang } });
  splash.show();
  splashLog.info('splash shown');
  splash.webContents.on('did-finish-load', () => {
    splash.webContents.setZoomFactor(getZoomFactor());
  });
  let resolveMinDisplay!: () => void;
  const minDisplay = new Promise<void>(resolve => { resolveMinDisplay = resolve; });
  setTimeout(resolveMinDisplay, SPLASH_MIN_DISPLAY_MS);
  let resolveCssReady!: () => void;
  const cssReady = new Promise<void>(resolve => { resolveCssReady = resolve; });
  splashLog.info('splash created');
  return { splash, minDisplay, cssReady, markCssReady: () => resolveCssReady() };
}

function setupApplicationMenu(): void {
  if (process.env.SIDRA_DEVTOOLS === '1') {
    const menuTemplate: Electron.MenuItemConstructorOptions[] = [
      {
        label: 'View',
        submenu: [{ role: 'toggleDevTools' }],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
  } else if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{
      label: app.name,
      submenu: [
        { label: `About ${app.name}`, ...(getMenuIcon('about') ? { icon: getMenuIcon('about') } : {}), click: () => showAboutWindow() },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }]));
  } else {
    Menu.setApplicationMenu(null);
  }
  mainLog.info('application menu set');
}

function initPlayerIPC(): Player {
  const player = new Player();
  ipcMain.on('playbackStateDidChange', (_event, data) => player.handlePlaybackStateDidChange(data));
  ipcMain.on('nowPlayingItemDidChange', (_event, data) => player.handleNowPlayingItemDidChange(data));
  ipcMain.on('playbackTimeDidChange', (_event, data) => player.handlePlaybackTimeDidChange(data));
  ipcMain.on('repeatModeDidChange', (_event, data) => player.handleRepeatModeDidChange(data));
  ipcMain.on('shuffleModeDidChange', (_event, data) => player.handleShuffleModeDidChange(data));
  ipcMain.on('volumeDidChange', (_event, data) => player.handleVolumeDidChange(data));
  return player;
}

async function initSession(): Promise<Electron.Session> {
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
  interface CdmComponentStatus {
    status: string;
    title: string;
    version: string;
  }

  const cdmStatus = Object.values(components.status())[0] as CdmComponentStatus | undefined;
  if (cdmStatus) {
    mainLog.info(`Widevine CDM ready: ${cdmStatus.title} v${cdmStatus.version} (${cdmStatus.status})`);
  } else {
    mainLog.warn('Widevine CDM ready: status unavailable');
  }

  // Set UA on the default session (updates navigator.userAgentData Client Hints)
  session.defaultSession.setUserAgent(UA);

  return ses;
}

function loadAssets(): Assets {
  const styleFixCssPath = getAssetPath('assets', 'styleFix.css');
  const STYLE_FIX_CSS = fs.readFileSync(styleFixCssPath, 'utf-8');
  const catppuccinCssPath = getAssetPath('assets', 'catppuccin.css');
  const CATPPUCCIN_CSS = fs.readFileSync(catppuccinCssPath, 'utf-8');
  const authStyleFixCssPath = getAssetPath('assets', 'authStyleFix.css');
  const AUTH_STYLE_FIX_CSS = fs.readFileSync(authStyleFixCssPath, 'utf-8');
  const navBarPath = getAssetPath('assets', 'navigationBar.js');
  const navBarScript = fs.readFileSync(navBarPath, 'utf-8');
  const hookPath = getAssetPath('assets', 'musicKitHook.js');
  const hookScript = fs.readFileSync(hookPath, 'utf-8');
  return { STYLE_FIX_CSS, CATPPUCCIN_CSS, AUTH_STYLE_FIX_CSS, navBarScript, hookScript };
}

function createMainWindow(ses: Electron.Session): { win: BrowserWindow; winReady: Promise<void> } {
  const win = new BrowserWindow({
    title: 'Sidra',
    width: MAIN_WINDOW_WIDTH_PX,
    height: MAIN_WINDOW_HEIGHT_PX,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    webPreferences: {
      partition: 'persist:sidra',
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      plugins: true,
      sandbox: true,
    },
  });

  let pollCancelled = false;
  const winReady = Promise.race([
    new Promise<void>(resolve => {
      win.webContents.once('did-navigate-in-page', () => {
        const poll = () => {
          if (pollCancelled) return;
          win.webContents.executeJavaScript(contentReadyProbeScript())
            .then(ready => { if (ready) resolve(); else if (!pollCancelled) setTimeout(poll, CONTENT_READY_POLL_MS); })
            .catch(() => { if (!pollCancelled) setTimeout(poll, CONTENT_READY_POLL_MS); });
        };
        poll();
      });
    }),
    new Promise<void>(resolve => setTimeout(resolve, CONTENT_READY_TIMEOUT_MS)),
  ]);
  winReady.then(() => { pollCancelled = true; });

  return { win, winReady };
}

function setupSplashTransition(win: BrowserWindow, splash: BrowserWindow, minDisplay: Promise<void>, cssReady: Promise<void>, winReady: Promise<void>): void {
  Promise.all([minDisplay, cssReady, winReady]).then(() => {
    win.show();
    splashLog.info('splash closed');
    splash.close();
  });
}

function setupSessionHeaders(ses: Electron.Session): void {
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
}

function setupWindowZoomAndNav(win: BrowserWindow): void {
  win.webContents.setZoomFactor(getZoomFactor());
  setApplyZoomCallback((factor) => win.webContents.setZoomFactor(factor));

  ipcMain.on('nav:back', () => win.webContents.navigationHistory.goBack());
  ipcMain.on('nav:forward', () => win.webContents.navigationHistory.goForward());
  ipcMain.on('nav:reload', () => {
    resetWedgeDetector();
    win.webContents.reload();
  });
}

function setupNavigationHandlers(win: BrowserWindow, navBarScript: string, hookScript: string): void {
  win.webContents.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
    if (isMainFrame) {
      mainLog.debug('did-start-navigation:', url);
    }
  });
  win.webContents.on('did-navigate', (_event, url) => {
    mainLog.debug('did-navigate:', url);
    handleStorefrontNavigation(url);
  });
  win.webContents.on('did-navigate-in-page', async (_event, url) => {
    handleStorefrontNavigation(url);
    try {
      const parsed = new URL(url);
      if (parsed.hostname === 'music.apple.com') {
        const segments = parsed.pathname.split('/').filter(Boolean);
        const pageSegments = segments[0] && /^[a-z]{2}$/.test(segments[0]) ? segments.slice(1) : segments;
        if (pageSegments.length > 0) setLastPageUrl(pageSegments.join('/'));
      }
    } catch {
      mainLog.warn('failed to parse URL for last-page tracking:', url);
    }
    try {
      await win.webContents.executeJavaScript(hookScript);
    } catch (e: unknown) {
      mainLog.warn('failed to inject hookScript on SPA navigation:', e);
    }
    try {
      await win.webContents.executeJavaScript(navBarScript);
    } catch (e: unknown) {
      mainLog.warn('failed to inject navBarScript on SPA navigation:', e);
    }
  });
}

const AUTH_FRAME_HOSTS = new Set<string>(['auth.music.apple.com', 'idmsa.apple.com']);
const AUTH_FRAME_LOG_PREFIX = '[sidra] auth-frame hide:';

function buildAuthFrameInjectionScript(authCss: string): string {
  // The script runs in the iframe's main world via executeJavaScript. It must
  // be self-contained - no closure on outer variables. The CSS payload is
  // embedded as a JSON-stringified literal so it survives escaping safely.
  const cssLiteral = JSON.stringify(authCss);
  return `(() => {
    const css = ${cssLiteral};
    const STYLE_ID = 'sidra-auth-fix';
    const TEXT_RE = /(sign in with )?iphone|passkey/i;
    const CAPTION_RE = /requires .{0,30}(ios|iphone|ipad)|(ios|ipados) ?\\d+ or later/i;
    const CONTAINER_SELECTOR = '[class*="passkey" i], [class*="iphone" i], [class*="cross-device" i], [role="group"], fieldset';
    const CAPTION_TAGS = 'p, small, span, div';
    const CAPTION_MAX_LEN = 200;

    const root = document.head || document.documentElement;
    if (root) {
      const existing = document.getElementById(STYLE_ID);
      if (existing) existing.remove();
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = css;
      root.appendChild(style);
    }

    function hideEl(el) {
      el.style.setProperty('display', 'none', 'important');
    }

    function isHidden(el) {
      return el.style && el.style.display === 'none';
    }

    function hideContainerFor(btn) {
      // Prefer a structural container matched by class/role; fall back to a
      // shallow parent walk (max 2 levels) whose textContent matches the
      // caption regex. Strictly capped so we never collapse the whole form.
      const container = btn.closest(CONTAINER_SELECTOR);
      if (container && container !== document.body && container !== document.documentElement) {
        hideEl(container);
        return 1;
      }
      let parent = btn.parentElement;
      for (let depth = 0; depth < 2 && parent; depth++) {
        if (parent === document.body || parent === document.documentElement) break;
        const text = (parent.textContent || '').trim();
        if (text && CAPTION_RE.test(text)) {
          hideEl(parent);
          return 1;
        }
        parent = parent.parentElement;
      }
      return 0;
    }

    function hideMatchingButtons() {
      let buttonsHidden = 0;
      let containersHidden = 0;
      const buttons = document.querySelectorAll('button');
      for (const el of buttons) {
        const text = (el.textContent || '').trim();
        if (text && TEXT_RE.test(text)) {
          hideEl(el);
          buttonsHidden++;
          containersHidden += hideContainerFor(el);
        }
      }
      return { buttonsHidden, containersHidden };
    }

    function hideCaptionElements() {
      // Standalone caption scan: the helper text may sit outside any passkey
      // container. Skip elements that wrap interactive controls so legitimate
      // form rows survive.
      let count = 0;
      const candidates = document.querySelectorAll(CAPTION_TAGS);
      for (const el of candidates) {
        if (isHidden(el)) continue;
        const text = (el.textContent || '').trim();
        if (!text || text.length > CAPTION_MAX_LEN) continue;
        if (!CAPTION_RE.test(text)) continue;
        if (el.querySelector('input, button, a[href]')) continue;
        hideEl(el);
        count++;
      }
      return count;
    }

    function runHidePasses() {
      const { buttonsHidden, containersHidden } = hideMatchingButtons();
      const captionsHidden = hideCaptionElements();
      return { buttonsHidden, captionsHidden, containersHidden };
    }

    const result = runHidePasses();

    if (!window.__sidraAuthFixInstalled) {
      window.__sidraAuthFixInstalled = true;
      const target = document.body || document.documentElement;
      if (target && typeof MutationObserver !== 'undefined') {
        const observer = new MutationObserver(() => { runHidePasses(); });
        observer.observe(target, { childList: true, subtree: true });
      }
    }

    const cssRuleCount = css.split('}').length - 1;
    console.info('${AUTH_FRAME_LOG_PREFIX} ' + cssRuleCount + ' CSS rules injected, ' + result.buttonsHidden + ' buttons hidden, ' + result.captionsHidden + ' captions hidden, ' + result.containersHidden + ' containers hidden');
  })();`;
}

function setupAuthFrameInjection(win: BrowserWindow, authCss: string): void {
  const authLog = log.scope('auth-frame');
  const script = buildAuthFrameInjectionScript(authCss);

  win.webContents.on('did-frame-finish-load', (_event, isMainFrame, frameProcessId, frameRoutingId) => {
    if (isMainFrame) return;
    const frame = webFrameMain.fromId(frameProcessId, frameRoutingId);
    if (!frame) {
      authLog.warn(`webFrameMain.fromId returned null for processId=${frameProcessId} routingId=${frameRoutingId}`);
      return;
    }
    let host: string;
    try {
      host = new URL(frame.url).hostname;
    } catch {
      return;
    }
    if (!AUTH_FRAME_HOSTS.has(host)) return;
    authLog.info(`auth iframe detected: ${frame.url}`);
    frame.executeJavaScript(script).catch(err => {
      authLog.warn('auth iframe injection failed:', (err as Error).message);
    });
  });

  win.webContents.on('console-message', (event) => {
    if (!event.message.startsWith(AUTH_FRAME_LOG_PREFIX)) return;
    const frameHost = (() => {
      try {
        return new URL(event.frame.url).hostname;
      } catch {
        return '';
      }
    })();
    if (!AUTH_FRAME_HOSTS.has(frameHost)) return;
    authLog.info(event.message.slice(AUTH_FRAME_LOG_PREFIX.length).trim());
  });
}

function setupWindowEvents(win: BrowserWindow, markCssReady: () => void): void {
  // Prevent the web page title from overriding the window title
  win.on('page-title-updated', (event) => {
    event.preventDefault();
  });

  // A single did-fail-load handler covers both error logging and splash
  // dismissal. The first-fire markCssReady() call prevents the splash screen
  // from hanging indefinitely when Apple Music fails to load.
  let cssMarked = false;
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    if (!cssMarked) {
      markCssReady();
      cssMarked = true;
    }
    mainLog.error('page load failed:', errorCode, errorDescription);
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
}

function setupContentHandlers(win: BrowserWindow, player: Player, markCssReady: () => void, assets: Assets): void {
  async function injectContent(): Promise<void> {
    mainLog.info('page loaded:', win.webContents.getURL());
    win.webContents.setZoomFactor(getZoomFactor());
    await win.webContents.insertCSS(assets.STYLE_FIX_CSS);
    mainLog.debug('CSS fixes injected');
    const theme = getTheme();
    if (theme !== 'apple-music') {
      setThemeCssKey(await win.webContents.insertCSS(assets.CATPPUCCIN_CSS));
      mainLog.debug(`Theme CSS injected: ${theme}`);
    }
    await win.webContents.executeJavaScript(assets.hookScript);
    mainLog.debug('MusicKit hook injected');
    await win.webContents.executeJavaScript(assets.navBarScript);
    mainLog.debug('Navigation bar injected');
  }

  let initialized = false;
  win.webContents.on('did-finish-load', async () => {
    await injectContent();

    if (!initialized) {
      initialized = true;

      initNotifications({ player, getMainWindow: () => win });
      initDiscordPresence({ player });
      initDock({ player, getMainWindow: () => win });
      initWindowsTaskbar({ player, getMainWindow: () => win });

      if (process.platform === 'linux') {
        const mpris = require('./integrations/mpris') as { init(ctx: IntegrationContext): void };
        mpris.init({ player, getMainWindow: () => win });
      }

      initWedgeDetector({ player, getMainWindow: () => win });

      if (appTray) {
        initTrayStateManager(player, appTray);
      }

      markCssReady();
      setTimeout(() => {
        if (appTray) {
          if (isAutoUpdateSupported()) {
            initAutoUpdate(appTray, rebuildTrayMenu);
          } else {
            checkForUpdates(appTray, rebuildTrayMenu);
          }
        }
      }, UPDATE_CHECK_DELAY_MS);
    }
  });
}

if (gotLock) {
  app.on('second-instance', (_event, argv) => {
    const target = extractItmsUrlFromArgv(argv);
    routeItmsTarget(target);
    focusMainWindow();
  });

  app.whenReady().then(async () => {
    mainLog.info('app ready, waiting for Widevine CDM...');
    const { splash, minDisplay, cssReady, markCssReady } = createSplash();
    setupApplicationMenu();
    const player = initPlayerIPC();
    appTray = createTray();
    const ses = await initSession();
    cleanArtworkCache();

    if (process.platform === 'linux' || process.platform === 'win32') {
      const ok = app.setAsDefaultProtocolClient('itms');
      mainLog.info(`itms protocol registration: ${ok ? 'ok' : 'failed'}`);
    }
    // macOS open-url intentionally omitted - Music.app handles itms:// natively.

    const assets = loadAssets();
    const created = createMainWindow(ses);
    win = created.win;
    const winReady = created.winReady;
    setSendCommandCallback((channel, ...args) => win!.webContents.send(channel, ...args));
    setDockSendCommandCallback((channel, ...args) => win!.webContents.send(channel, ...args));
    setTaskbarSendCommandCallback((channel, ...args) => win!.webContents.send(channel, ...args));
    setupWindowZoomAndNav(win);
    initThemeCSS(win, assets.CATPPUCCIN_CSS);
    setupSplashTransition(win, splash, minDisplay, cssReady, winReady);
    setupSessionHeaders(ses);
    setupContentHandlers(win, player, markCssReady, assets);
    setupWindowEvents(win, markCssReady);
    setupNavigationHandlers(win, assets.navBarScript, assets.hookScript);
    setupAuthFrameInjection(win, assets.AUTH_STYLE_FIX_CSS);
    if (process.env.SIDRA_DEVTOOLS === '1') {
      win.webContents.openDevTools();
      mainLog.info('DevTools opened (SIDRA_DEVTOOLS=1)');
    }
    mainLog.info('loading Apple Music...');
    win.loadURL(buildAppleMusicURL(), { userAgent: UA });

    // Drain any itms target captured at launch. Routed after the initial home
    // load so the content-ready probe binds to its first did-navigate-in-page.
    winReady.then(() => {
      if (pendingItmsTarget) {
        routeItmsTarget(pendingItmsTarget);
        pendingItmsTarget = null;
      }
    });
  });
}

app.on('window-all-closed', () => {
  mainLog.info('all windows closed, quitting');
  app.quit();
});
