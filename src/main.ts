import { app, BrowserWindow, components, ipcMain, Menu, session, Tray, webFrameMain } from 'electron';
import fs from 'fs';
import path from 'path';
import log from 'electron-log/main';
import { getZoomFactor, getCloseToTrayEnabled, getMusicService } from './config';
import { getLoadingText, getNavigationStrings, NAV_LABELS_TOKEN } from './i18n';
import { getAssetPath } from './paths';
import { Player, IntegrationContext } from './player';
import { buildAppleMusicURL, buildItmsRouteURL, handleStorefrontNavigation, handleLastPageNavigation } from './storefront';
import { extractItmsUrlFromArgv, type ItmsTarget } from './itms';
import { initServiceSwitch, routeToMusicService, switchService } from './serviceSwitch';
import { initThemeCSS, injectThemeCss, setRebuildTrayCallback } from './theme';
import { createTray, getMenuIcon, initTrayStateManager, rebuildTrayMenu, setApplyZoomCallback, setGetMainWindowCallback, setSwitchServiceCallback } from './tray';
import { initCommandBridge } from './commandBridge';
import { showAboutWindow } from './aboutWindow';
import { checkForUpdates } from './update';
import { isAutoUpdateSupported, initAutoUpdate } from './autoUpdate';
import { getService, allServices, isAllowedNavigationUrl } from './musicService';
import { init as initNotifications } from './integrations/notifications';
import { init as initDiscordPresence } from './integrations/discord-presence';
import { init as initLastfm } from './integrations/lastfm';
import { init as initDock } from './integrations/macos-dock';
import { init as initWindowsTaskbar } from './integrations/windows-taskbar';
import { cleanArtworkCache } from './artwork';
import { init as initWedgeDetector, reset as resetWedgeDetector } from './wedgeDetector';
import { contentReadyProbeScript } from './contentReady';
import { initNotificationProbe } from './notify';
import { runSteps } from './utils';
import { openExternalUrl } from './utils/openExternal';

const SPLASH_MIN_DISPLAY_MS = 500;
const CONTENT_READY_POLL_MS = 100;
const CONTENT_READY_TIMEOUT_MS = 3500;
const CSS_READY_TIMEOUT_MS = 10000;
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

// --- App identity: must be set before app.whenReady() on Windows, or neither
// desktop notifications nor the GSMTC media identity attach to Sidra ---
if (process.platform === 'win32') {
  app.setAppUserModelId('com.wimpysworld.sidra');
}

// --- Platform switches: must run before app.whenReady() ---
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-features', 'UseOzonePlatform,WaylandWindowDecorations');
  // MediaSessionService off: Sidra registers its own MPRIS service, and
  // Chromium's would be a second, conflicting registration on the same bus.
  // AudioServiceOutOfProcess off: it moves audio back in-process, which is
  // where SetGlobalAppName can reach PulseAudio at all.
  app.commandLine.appendSwitch('disable-features', 'MediaSessionService,WaylandWpColorManagerV1,AudioServiceOutOfProcess');
  // Set the XDG desktop name so GetXdgAppId() returns 'sidra' and
  // GetPossiblyOverriddenApplicationName() can read Name= from sidra.desktop.
  // Pairs with the AudioServiceOutOfProcess switch above: without both, the
  // PulseAudio stream is labelled "Chromium" and no PULSE_PROP_* override helps.
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

let isQuitting = false;
app.on('before-quit', () => { isQuitting = true; });

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
  const wasHidden = !win.isVisible();
  if (wasHidden) win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
  if (wasHidden && appTray) rebuildTrayMenu(appTray);
}

function routeItmsTarget(target: ItmsTarget | null): void {
  if (!target) return;
  if (!win) {
    pendingItmsTarget = target;
    return;
  }
  // Resolved before the switch; buildItmsRouteURL pins the music origin itself.
  const url = target.kind === 'url' ? target.url : buildItmsRouteURL(target.token);
  routeToMusicService(url);
  mainLog.info(`itms target routed: kind=${target.kind}`);
}

export interface Assets {
  STYLE_FIX_CSS: string;
  authFrameScript: string;
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
  // Raced against a timeout rather than left open-ended. Every other path that
  // resolves this sits inside an event handler that can fail, and an unsettled
  // cssReady holds the Promise.all in setupSplashTransition() forever, so the
  // splash never closes and the main window never shows.
  const cssReady = Promise.race([
    new Promise<void>(resolve => { resolveCssReady = resolve; }),
    new Promise<void>(resolve => setTimeout(resolve, CSS_READY_TIMEOUT_MS)),
  ]);
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

// The renderer→main channels split by owner: the nav: prefix is the navigation
// bar's namespace, and every other channel is a MusicKit event for the Player.
// Each table below is a total record over its half, so a channel renamed in
// src/types/hook.d.ts and a channel added there with no listener both fail tsc
// here rather than compiling on and never firing.
type NavSendChannel = Extract<SendChannel, `nav:${string}`>;
type PlayerSendChannel = Exclude<SendChannel, NavSendChannel>;
type SendListener = Parameters<typeof ipcMain.on>[1];

// Object.keys() preserves insertion order, so listeners register in the order
// the table lists them.
function onSendChannels<C extends SendChannel>(listeners: Record<C, SendListener>): void {
  for (const channel of Object.keys(listeners) as C[]) {
    ipcMain.on(channel, listeners[channel]);
  }
}

function initPlayerIPC(): Player {
  const player = new Player();
  onSendChannels<PlayerSendChannel>({
    playbackStateDidChange: (_event, data) => player.handlePlaybackStateDidChange(data),
    nowPlayingItemDidChange: (_event, data) => player.handleNowPlayingItemDidChange(data),
    playbackTimeDidChange: (_event, data) => player.handlePlaybackTimeDidChange(data),
    repeatModeDidChange: (_event, data) => player.handleRepeatModeDidChange(data),
    shuffleModeDidChange: (_event, data) => player.handleShuffleModeDidChange(data),
    volumeDidChange: (_event, data) => player.handleVolumeDidChange(data),
  });
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
      origins: allServices().map(svc => svc.origin),
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
  const authStyleFixCssPath = getAssetPath('assets', 'authStyleFix.css');
  const authCss = fs.readFileSync(authStyleFixCssPath, 'utf-8');
  const authFramePath = getAssetPath('assets', 'authFrameFix.js');
  const authFrameScript = fs
    .readFileSync(authFramePath, 'utf-8')
    .replace(AUTH_FIX_TOKEN, () => JSON.stringify({
      css: authCss,
      containerSelectors: PASSKEY_CONTAINER_SELECTORS,
      logPrefix: AUTH_FRAME_LOG_PREFIX,
    }));
  const navBarPath = getAssetPath('assets', 'navigationBar.js');
  const navBarScript = fs
    .readFileSync(navBarPath, 'utf-8')
    .replace(NAV_LABELS_TOKEN, () => JSON.stringify(getNavigationStrings()));
  const hookPath = getAssetPath('assets', 'musicKitHook.js');
  const hookScript = fs.readFileSync(hookPath, 'utf-8');
  return { STYLE_FIX_CSS, authFrameScript, navBarScript, hookScript };
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

  // did-finish-load fires while Apple Music is still an empty shell, so the
  // window is held back until the service's contentReadySelector appears in the
  // page. The poll starts at the first in-page navigation, which is where the
  // SPA takes over rendering, and a timeout shows the window regardless so a
  // selector Apple has renamed delays the launch instead of blocking it.
  let pollCancelled = false;
  const winReady = Promise.race([
    new Promise<void>(resolve => {
      win.webContents.once('did-navigate-in-page', () => {
        const poll = () => {
          if (pollCancelled) return;
          const selector = getService(getMusicService()).contentReadySelector;
          win.webContents.executeJavaScript(contentReadyProbeScript(selector))
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
  const urlFilters = allServices().map(svc => `${svc.origin}/*`);
  ses.webRequest.onBeforeSendHeaders({ urls: urlFilters }, (details, callback) => {
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

  onSendChannels<NavSendChannel>({
    'nav:back': () => win.webContents.navigationHistory.goBack(),
    'nav:forward': () => win.webContents.navigationHistory.goForward(),
    'nav:reload': () => {
      resetWedgeDetector();
      win.webContents.reload();
    },
  });
}

// Injects the MusicKit hook and then the navigation bar. Called from
// did-finish-load and from did-navigate-in-page, which is why it never rejects:
// in did-finish-load an escaping rejection skips markCssReady(), and that is the
// only thing that dismisses the splash, so the app would show it for the life of
// the process. Every await sits in its own try/catch, and the gate's getURL()
// read is inside the first one because a destroyed webContents throws there.
// A hook failure still injects the nav bar: back and forward buttons that work
// beat none at all on a page whose media controls are already dead.
async function injectRendererScripts(win: BrowserWindow, assets: Assets, context: string): Promise<void> {
  try {
    const currentUrl = win.webContents.getURL();
    if (isAllowedNavigationUrl(currentUrl)) {
      await win.webContents.executeJavaScript(assets.hookScript);
      mainLog.debug('MusicKit hook injected');
    } else {
      mainLog.warn('skipped hookScript injection on disallowed host:', currentUrl);
    }
  } catch (e: unknown) {
    mainLog.warn(`failed to inject hookScript ${context}:`, e);
  }
  try {
    await win.webContents.executeJavaScript(assets.navBarScript);
    mainLog.debug('Navigation bar injected');
  } catch (e: unknown) {
    mainLog.warn(`failed to inject navBarScript ${context}:`, e);
  }
}

function setupNavigationHandlers(win: BrowserWindow, assets: Assets): void {
  // Keeps the main frame on Apple's hosts, so the preload command bridge and the
  // injected hook can only ever reach Apple Music. Main-process loadURL() calls do
  // not raise this event, so launch, service switching and itms:// routing are unaffected.
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigationUrl(url)) {
      event.preventDefault();
      mainLog.warn('blocked navigation to disallowed host:', url);
    }
  });
  win.webContents.on('did-start-navigation', (_event, url, _isInPlace, isMainFrame) => {
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
    handleLastPageNavigation(url);
    await injectRendererScripts(win, assets, 'on SPA navigation');
  });
}

const AUTH_FRAME_HOSTS = new Set<string>(allServices().flatMap(svc => [...svc.authFrameHosts]));
const AUTH_FRAME_LOG_PREFIX = '[sidra] auth-frame hide:';
// Substituted by loadAssets(); assets/authFrameFix.js carries the same spelling.
const AUTH_FIX_TOKEN = '__SIDRA_AUTH_FIX__';

// Containers that name the passkey or "Sign in with iPhone" option. Both jobs
// in assets/authFrameFix.js need them: the injected stylesheet hides a match on
// sight, and closest() walks up to one from a button it has already matched.
// Only selectors that name the feature belong here. The broad class prefixes
// and the structural [role="group"] and fieldset entries stay in the script,
// where the walk starts at a matched button; in the stylesheet they would hide
// unrelated form groups.
const PASSKEY_CONTAINER_SELECTORS = [
  '[class*="passkey-option" i]',
  '[class*="passkey-section" i]',
  '[class*="passkey-container" i]',
  '[class*="iphone-signin" i]',
  '[class*="cross-device" i]',
  '[data-component-name*="passkey" i]',
  '[data-testid*="passkey" i][role="group"]',
];

// assets/authFrameFix.js hides the passkey and "Sign in with iPhone" routes in
// Apple's sign-in iframe, and reports what it hid back over console-message,
// which is the only channel out of a frame the main process has not preloaded.
function setupAuthFrameInjection(win: BrowserWindow, script: string): void {
  const authLog = log.scope('auth-frame');

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

  // Apple Music registers a beforeunload handler while audio plays. Electron
  // shows no confirmation dialog, so the handler silently blocks close() and
  // app.quit() with no error; overriding it here is what lets Sidra exit.
  win.webContents.on('will-prevent-unload', (event) => {
    event.preventDefault();
  });

  win.on('close', (event) => {
    if (!isQuitting && getCloseToTrayEnabled()) {
      event.preventDefault();
      win.hide();
      mainLog.info('close intercepted: hiding window to tray');
      if (appTray) rebuildTrayMenu(appTray);
    }
  });

  // Open external links in the system browser (only http/https)
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url, mainLog);
    return { action: 'deny' };
  });
}

function setupContentHandlers(win: BrowserWindow, player: Player, markCssReady: () => void, assets: Assets): void {
  async function injectContent(): Promise<void> {
    mainLog.info('page loaded:', win.webContents.getURL());
    win.webContents.setZoomFactor(getZoomFactor());
    await win.webContents.insertCSS(assets.STYLE_FIX_CSS);
    mainLog.debug('CSS fixes injected');
    await injectThemeCss(win.webContents);
    await injectRendererScripts(win, assets, 'on load');
  }

  let initialized = false;
  win.webContents.on('did-finish-load', async () => {
    // Claimed before the await, not after. injectContent() yields on every call,
    // so two did-finish-load events inside one round trip would both pass a
    // check placed below it and register every integration twice.
    const firstLoad = !initialized;
    initialized = true;

    // Injection failure must not abandon the rest of this handler. A renderer
    // torn down mid-injection rejects the CSS calls above, and without this the
    // handler stops before markCssReady() and the splash never closes.
    // injectRendererScripts() contains its own failures and never rejects.
    try {
      await injectContent();
    } catch (e: unknown) {
      mainLog.warn('failed to inject content on load:', e);
    }

    if (firstLoad) {
      // Integration failures are contained for the same reason: markCssReady()
      // below is the only thing that dismisses the splash. Each initialiser is
      // its own step, so a throw from one cannot cancel the rest for the
      // lifetime of the process.
      runSteps([
        ['notifications', () => initNotifications({ player, getMainWindow: () => win })],
        ['discord', () => initDiscordPresence({ player })],
        ['lastfm', () => initLastfm({ player, getMainWindow: () => win })],
        ['dock', () => initDock({ player, getMainWindow: () => win })],
        ['windowsTaskbar', () => initWindowsTaskbar({ player, getMainWindow: () => win })],
        ['mpris', () => {
          if (process.platform !== 'linux') return;
          const mpris = require('./integrations/mpris') as { init(ctx: IntegrationContext): void };
          mpris.init({ player, getMainWindow: () => win });
        }],
        ['wedgeDetector', () => initWedgeDetector({ player, getMainWindow: () => win })],
        ['trayState', () => {
          if (!appTray) return;
          // The returned closure is the teardown for all four resources it
          // holds, so it must reach will-quit; called as a bare statement it
          // would be discarded and every one of them would stay attached.
          const teardownTrayState = initTrayStateManager(player, appTray);
          app.on('will-quit', teardownTrayState);
        }],
      ], (name, e) => mainLog.error(`integration initialisation failed: ${name}:`, e));

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
    initNotificationProbe();
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
    initCommandBridge((channel, ...args) => win!.webContents.send(channel, ...args));
    setGetMainWindowCallback(() => win);
    initServiceSwitch({
      getTray: () => appTray,
      loadURL: url => {
        win?.loadURL(url, { userAgent: UA }).catch(err =>
          mainLog.warn('service navigation loadURL failed:', (err as Error).message)
        );
      },
    });
    setSwitchServiceCallback(switchService);
    setRebuildTrayCallback(() => {
      if (appTray) rebuildTrayMenu(appTray);
    });
    setupWindowZoomAndNav(win);
    initThemeCSS(win);
    setupSplashTransition(win, splash, minDisplay, cssReady, winReady);
    setupSessionHeaders(ses);
    setupContentHandlers(win, player, markCssReady, assets);
    setupWindowEvents(win, markCssReady);
    setupNavigationHandlers(win, assets);
    setupAuthFrameInjection(win, assets.authFrameScript);
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

// macOS: clicking the dock icon when the window is hidden (close-to-tray)
// should restore it rather than doing nothing.
app.on('activate', () => {
  focusMainWindow();
});
