import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { getTrayStrings } from '../src/i18n';
import type { SettingsAction, SettingsState } from '../src/settings';

const source = fs.readFileSync(path.join(__dirname, '../assets/settings.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../assets/settings.html'), 'utf8');

class Element {
  value = '';
  textContent = '';
  checked = false;
  hidden = false;
  disabled = false;
  options: Element[] = [];
  dataset: { label?: string } = {};
  listeners = new Map<string, () => void>();
  focus = vi.fn();
  constructor(readonly id = '') {}
  replaceChildren(...children: Element[]): void { this.options = children; }
  addEventListener(event: string, listener: () => void): void { this.listeners.set(event, listener); }
  fire(event: string): void { this.listeners.get(event)?.(); }
}

function fixture(): SettingsState {
  return {
    musicService: 'music', startPage: 'new', theme: 'apple-music', zoomFactor: 1,
    closeToTray: false, notifications: true, discord: false,
    lastfm: { available: true, connected: false, enabled: false, username: '' },
    options: {
      musicService: [{ value: 'music', label: 'Apple Music' }, { value: 'classical', label: 'Apple Music Classical' }],
      startPage: [{ value: 'new', label: 'New' }],
      theme: [{ value: 'apple-music', label: 'Apple Music' }],
      zoomFactor: [{ value: 1, label: '100%' }, { value: 1.25, label: '125%' }],
    },
    labels: getTrayStrings(), lang: 'en',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(initial = fixture()) {
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], new Element(match[1])]));
  const labels = [...html.matchAll(/data-label="([^"]+)"/g)].map(match => {
    const element = new Element();
    element.dataset.label = match[1];
    return element;
  });
  const document = {
    title: '', documentElement: { lang: '', dir: '' }, activeElement: elements.get('theme'),
    getElementById: (id: string) => elements.get(id),
    querySelectorAll: () => labels,
    createElement: () => new Element(),
  };
  let push!: (state: SettingsState) => void;
  let close!: () => void;
  const unsubscribe = vi.fn();
  const getState = vi.fn(async () => initial);
  const apply = vi.fn(async (_action: SettingsAction) => initial);
  const onState = vi.fn((listener: typeof push) => { push = listener; return unsubscribe; });
  vm.runInNewContext(source, {
    document,
    window: { sidraSettings: { getState, apply, onState }, addEventListener: (_event: string, listener: () => void) => { close = listener; } },
  });
  return { document, labels, getState, apply, onState, unsubscribe, push: (state: SettingsState) => push(state), close: () => close(),
    element: (id: string) => elements.get(id)! };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('settings page', () => {
  it('subscribes before reading state and preserves the focused control', async () => {
    const h = harness();
    await settle();
    expect(h.onState.mock.invocationCallOrder[0]).toBeLessThan(h.getState.mock.invocationCallOrder[0]);
    const focused = h.document.activeElement;
    h.push({ ...fixture(), lang: 'he' });
    expect(h.document.activeElement).toBe(focused);
    expect(h.document.documentElement).toEqual({ lang: 'he', dir: 'rtl' });
    expect(h.document.title).toBe(fixture().labels.settings);
  });

  it('serialises edits and converts zoom to a number', async () => {
    const h = harness();
    await settle();
    const pending = deferred<SettingsState>();
    h.apply.mockImplementationOnce(() => pending.promise);
    h.element('zoomFactor').value = '1.25';
    h.element('zoomFactor').fire('change');
    h.element('discord').checked = true;
    h.element('discord').fire('change');
    await settle();
    expect(h.apply).toHaveBeenCalledExactlyOnceWith({ type: 'zoomFactor', value: 1.25 });
    pending.resolve(fixture());
    await settle();
    expect(h.apply).toHaveBeenLastCalledWith({ type: 'discord', value: true });
  });

  it('does not replace a pushed state with an older apply response', async () => {
    const h = harness();
    await settle();
    const pending = deferred<SettingsState>();
    h.apply.mockImplementationOnce(() => pending.promise);
    h.element('discord').fire('change');
    await settle();
    h.push({ ...fixture(), notifications: false });
    pending.resolve(fixture());
    await settle();
    expect(h.element('notifications').checked).toBe(false);
  });

  it('keeps a pushed state when the initial read resolves later', async () => {
    const h = harness();
    h.push({ ...fixture(), notifications: false });
    await settle();
    expect(h.element('notifications').checked).toBe(false);
  });

  it('does not dispatch queued edits after the page closes', async () => {
    const h = harness();
    await settle();
    const pending = deferred<SettingsState>();
    h.apply.mockImplementationOnce(() => pending.promise);
    h.element('discord').fire('change');
    h.element('notifications').fire('change');
    await settle();
    h.close();
    pending.resolve({ ...fixture(), lang: 'ar' });
    await settle();
    expect(h.apply).toHaveBeenCalledOnce();
    expect(h.document.documentElement.lang).toBe('en');
    expect(h.unsubscribe).toHaveBeenCalledOnce();
  });

  it('refreshes rejected actions, displays an error and allows a later edit', async () => {
    const h = harness();
    await settle();
    h.apply.mockRejectedValueOnce(new Error('private details'));
    h.element('discord').checked = true;
    h.element('discord').fire('change');
    await settle();
    expect(h.getState).toHaveBeenCalledTimes(2);
    expect(h.element('discord').checked).toBe(false);
    expect(h.element('error').textContent).toBe(fixture().labels.settingsError);
    expect(h.element('error').hidden).toBe(false);
    h.element('discord').fire('change');
    await settle();
    expect(h.element('error').hidden).toBe(true);
  });

  it('includes the selected service in start-page actions', async () => {
    const h = harness();
    await settle();
    h.element('startPage').fire('change');
    await settle();
    expect(h.apply).toHaveBeenCalledWith({ type: 'startPage', serviceId: 'music', value: 'new' });
  });

  it('renders Last.fm account text literally and hides unavailable controls', async () => {
    const state = fixture();
    state.lastfm = { available: true, connected: true, enabled: true, username: '<img src=x>' };
    const h = harness(state);
    await settle();
    expect(h.element('lastfm-status').textContent).toContain('<img src=x>');
    expect(h.element('lastfmConnect').hidden).toBe(true);
    expect(h.element('lastfmDisconnect').hidden).toBe(false);
    h.push({ ...state, lastfm: { ...state.lastfm, available: false } });
    expect(h.element('lastfm').hidden).toBe(true);
  });

  it('unsubscribes on close and ignores later state updates', async () => {
    const h = harness();
    await settle();
    h.close();
    h.push({ ...fixture(), lang: 'ar' });
    expect(h.unsubscribe).toHaveBeenCalledOnce();
    expect(h.document.documentElement.lang).toBe('en');
  });

  it('uses external scripts and styles without HTML interpolation', () => {
    expect(html).toContain("default-src 'none'; script-src 'self'; style-src 'self'");
    expect(html).not.toContain('unsafe-inline');
    expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
  });
});
