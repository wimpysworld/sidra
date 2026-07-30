import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const navBarScript = fs.readFileSync(
  path.join(__dirname, '..', 'assets', 'navigationBar.js'),
  'utf-8',
);

const ANCHOR_SELECTOR = '.navigation__header .logo';

type StubListener = (this: StubElement) => void;

class StubElement {
  readonly tagName: string;
  readonly namespaceURI: string | null;
  readonly children: StubElement[] = [];
  readonly style = { setProperty: vi.fn() };
  id = '';

  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, StubListener[]>();

  constructor(tagName: string, namespaceURI: string | null = null) {
    this.tagName = tagName;
    this.namespaceURI = namespaceURI;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  appendChild<T extends StubElement>(child: T): T {
    this.children.push(child);
    return child;
  }

  addEventListener(type: string, listener: StubListener): void {
    const existing = this.listeners.get(type);
    if (existing) existing.push(listener);
    else this.listeners.set(type, [listener]);
  }

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener.call(this);
  }

  // Only tag-name selectors are needed; the script queries its own 'svg' child.
  querySelector(selector: string): StubElement | null {
    return this.descendants().find((element) => element.tagName === selector) ?? null;
  }

  descendants(): StubElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
}

function createHarness({ withAnchor = true }: { withAnchor?: boolean } = {}) {
  const root = new StubElement('body');
  const anchor = withAnchor ? root.appendChild(new StubElement('div')) : null;
  const send = vi.fn();
  const warn = vi.fn();
  const log = vi.fn();

  const document = {
    // Resolves against the live tree so the script's double-injection guard
    // sees the container a previous run appended.
    getElementById: (id: string): StubElement | null =>
      root.descendants().find((element) => element.id === id) ?? null,
    querySelector: (selector: string): StubElement | null =>
      selector === ANCHOR_SELECTOR ? anchor : null,
    createElement: (tagName: string): StubElement => new StubElement(tagName),
    createElementNS: (namespaceURI: string, tagName: string): StubElement =>
      new StubElement(tagName, namespaceURI),
  };
  const window = { AMWrapper: { ipcRenderer: { send } } };
  const context = vm.createContext({ console: { log, warn }, document, window });

  return {
    anchor,
    bar: (): StubElement | null =>
      root.descendants().find((element) => element.id === 'sidra-nav-buttons') ?? null,
    buttons: (): StubElement[] =>
      root.descendants().filter((element) => element.tagName === 'button'),
    root,
    run: () => vm.runInContext(navBarScript, context),
    send,
    warn,
  };
}

function labelsOf(elements: StubElement[]): Array<string | null> {
  return elements.map((element) => element.getAttribute('aria-label'));
}

describe('navigationBar', () => {
  it('appends the button container to the matched anchor', () => {
    const { anchor, bar, run } = createHarness();

    run();

    expect(bar()).not.toBeNull();
    expect(anchor?.children).toContain(bar());
  });

  it('builds Back, Forward and Reload buttons inside the container', () => {
    const { bar, run } = createHarness();

    run();

    expect(labelsOf(bar()?.children ?? [])).toEqual(['Back', 'Forward', 'Reload']);
  });

  it('appends nothing and throws nothing when the anchor is missing', () => {
    const { bar, root, run } = createHarness({ withAnchor: false });

    expect(() => run()).not.toThrow();

    expect(root.descendants()).toHaveLength(0);
    expect(bar()).toBeNull();
  });

  it('warns when the anchor is missing', () => {
    const { run, warn } = createHarness({ withAnchor: false });

    run();

    expect(warn).toHaveBeenCalledWith(`Sidra: ${ANCHOR_SELECTOR} not found`);
  });

  it('appends no duplicate buttons when the script runs again', () => {
    const { anchor, buttons, run } = createHarness();

    run();

    expect(buttons()).toHaveLength(3);

    run();

    expect(buttons()).toHaveLength(3);
    expect(anchor?.children).toHaveLength(1);
  });

  it.each([
    ['Back', 'nav:back'],
    ['Forward', 'nav:forward'],
    ['Reload', 'nav:reload'],
  ])('sends %s clicks on the %s channel', (label, channel) => {
    const { buttons, run, send } = createHarness();

    run();
    const button = buttons().find((element) => element.getAttribute('aria-label') === label);
    button?.dispatch('click');

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(channel);
  });
});
