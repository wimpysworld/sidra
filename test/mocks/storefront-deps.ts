// test/mocks/storefront-deps.ts
// Shared vi.mock() declarations for test files that import storefront.ts
// (or main.ts, which re-exports storefront functions).
//
// These mock the application modules that storefront.ts pulls in transitively.
// Global mocks for electron, electron-log/main, and electron-conf/main live in
// test/setup.ts and are not duplicated here.
//
// Vitest hoists vi.mock() calls to the top of the file they appear in and
// resolves module paths relative to that file. Since this file lives in
// test/mocks/, paths use ../../src/ instead of ../src/.
//
// Import this file as a side-effect: import './mocks/storefront-deps';
import { vi } from 'vitest';

vi.mock('../../src/config', () => ({
  getStorefront: vi.fn(),
  setStorefront: vi.fn(),
  getLanguage: vi.fn(),
  setLanguage: vi.fn(),
  getCatppuccinEnabled: vi.fn(() => false),
  getStartPage: vi.fn(() => 'new'),
  getLastPageUrl: vi.fn(),
  getZoomFactor: vi.fn(() => 1.0),
}));

vi.mock('../../src/i18n', () => ({
  getLoadingText: vi.fn(() => ({ text: 'Loading...', lang: 'en' })),
  getStorefront: vi.fn(() => 'us'),
}));

vi.mock('../../src/paths', () => ({
  getAssetPath: vi.fn((...parts: string[]) => parts.join('/')),
}));

vi.mock('../../src/player', () => ({
  Player: vi.fn(),
}));

vi.mock('../../src/tray', () => ({
  createTray: vi.fn(),
  rebuildTrayMenu: vi.fn(),
  setApplyZoomCallback: vi.fn(),
}));

vi.mock('../../src/update', () => ({
  checkForUpdates: vi.fn(),
}));

vi.mock('../../src/autoUpdate', () => ({
  isAutoUpdateSupported: vi.fn(() => false),
  initAutoUpdate: vi.fn(),
}));

vi.mock('../../src/integrations/notifications', () => ({
  init: vi.fn(),
}));

vi.mock('../../src/integrations/discord-presence', () => ({
  init: vi.fn(),
}));

vi.mock('../../src/wedgeDetector', () => ({
  init: vi.fn(),
  reset: vi.fn(),
}));

vi.mock('fs', () => ({
  default: { readFileSync: vi.fn(() => '') },
  readFileSync: vi.fn(() => ''),
}));
