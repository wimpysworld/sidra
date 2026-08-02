import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

import { AUTH_FIX_TOKEN, PASSKEY_CONTAINER_SELECTORS } from '../src/authFrame';

const authFixSource = fs.readFileSync(
  path.join(__dirname, '..', 'assets', 'authFrameFix.js'),
  'utf-8',
);

// The asset is not standalone-executable JavaScript: loadAssets() in src/main.ts
// substitutes the config token when it reads the file, so this test has to do
// the same before it runs it. The payload is deliberately not the production
// one, so a value that reaches the injected stylesheet or the log line proves it
// came from here and not from a default in the asset.
const CONFIG = {
  css: '.stub-passkey { display: none !important; }\n',
  containerSelectors: PASSKEY_CONTAINER_SELECTORS,
  logPrefix: '[stub] auth-frame hide:',
};

const authFixScript = authFixSource.replace(AUTH_FIX_TOKEN, () => JSON.stringify(CONFIG));

const CAPTION_TEXT = 'Requires iOS 16 or later';

class StubStyle {
  display = '';

  setProperty(name: string, value: string): void {
    if (name === 'display') this.display = value;
  }
}

class StubElement {
  readonly tagName: string;
  readonly children: StubElement[] = [];
  readonly style = new StubStyle();
  parentElement: StubElement | null = null;
  id = '';
  ownText = '';

  // Selectors this element answers to. The script's selectors are attribute and
  // class-substring matchers, so each fixture declares its own rather than the
  // harness parsing CSS.
  readonly selectors: string[];

  constructor(tagName: string, selectors: string[] = []) {
    this.tagName = tagName;
    this.selectors = selectors;
  }

  get textContent(): string {
    return [this.ownText, ...this.children.map((child) => child.textContent)].join('');
  }

  set textContent(value: string) {
    this.children.length = 0;
    this.ownText = value;
  }

  appendChild<T extends StubElement>(child: T): T {
    this.children.push(child);
    child.parentElement = this;
    return child;
  }

  remove(): void {
    const siblings = this.parentElement?.children;
    if (!siblings) return;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentElement = null;
  }

  matches(selector: string): boolean {
    return selector
      .split(',')
      .map((part) => part.trim())
      .some((part) => part === this.tagName || this.selectors.includes(part));
  }

  closest(selector: string): StubElement | null {
    let node: StubElement | null = this;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parentElement;
    }
    return null;
  }

  querySelector(selector: string): StubElement | null {
    return this.descendants().find((element) => element.matches(selector)) ?? null;
  }

  descendants(): StubElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
}

function el(
  tagName: string,
  options: { text?: string; selectors?: string[]; children?: StubElement[] } = {},
): StubElement {
  const element = new StubElement(tagName, options.selectors);
  if (options.text !== undefined) element.ownText = options.text;
  for (const child of options.children ?? []) element.appendChild(child);
  return element;
}

function createHarness(bodyChildren: StubElement[] = []) {
  const html = el('html');
  const head = html.appendChild(el('head'));
  const body = html.appendChild(el('body', { children: bodyChildren }));

  const all = (): StubElement[] => [html, ...html.descendants()];
  const info = vi.fn();
  const observers: Array<{ callback: () => void; target: StubElement }> = [];

  class StubMutationObserver {
    private readonly callback: () => void;

    constructor(callback: () => void) {
      this.callback = callback;
    }

    observe(target: StubElement): void {
      observers.push({ callback: this.callback, target });
    }
  }

  const document = {
    head,
    body,
    documentElement: html,
    getElementById: (id: string): StubElement | null =>
      all().find((element) => element.id === id) ?? null,
    createElement: (tagName: string): StubElement => new StubElement(tagName),
    querySelectorAll: (selector: string): StubElement[] =>
      all().filter((element) => element.matches(selector)),
  };
  const window: { __sidraAuthFixInstalled?: boolean } = {};
  const context = vm.createContext({
    console: { info },
    document,
    window,
    MutationObserver: StubMutationObserver,
  });

  return {
    body,
    head,
    info,
    observers,
    run: () => vm.runInContext(authFixScript, context),
    styles: (): StubElement[] => head.children.filter((child) => child.tagName === 'style'),
  };
}

function hiddenFixtures() {
  const button = el('button', { text: 'Sign in with iPhone' });
  const container = el('div', {
    selectors: ['[class*="passkey-option" i]'],
    children: [button],
  });
  const caption = el('p', { text: CAPTION_TEXT });
  return { button, caption, container };
}

describe('authFrameFix', () => {
  it('carries the config token that src/main.ts substitutes', () => {
    expect(authFixSource).toContain(AUTH_FIX_TOKEN);
  });

  it('appends a stylesheet built from the substituted payload', () => {
    const { run, styles } = createHarness();

    run();

    const [style] = styles();
    expect(style?.id).toBe('sidra-auth-fix');
    expect(style?.textContent).toContain(CONFIG.css);
    for (const selector of PASSKEY_CONTAINER_SELECTORS) {
      expect(style?.textContent).toContain(selector);
    }
  });

  it('replaces the stylesheet instead of appending a second one', () => {
    const { run, styles } = createHarness();

    run();
    run();

    expect(styles()).toHaveLength(1);
  });

  it('hides a matching button and the container it names', () => {
    const { button, container } = hiddenFixtures();
    const { run } = createHarness([container]);

    run();

    expect(button.style.display).toBe('none');
    expect(container.style.display).toBe('none');
  });

  it('hides a caption that names an iOS requirement', () => {
    const { caption } = hiddenFixtures();
    const { run } = createHarness([caption]);

    run();

    expect(caption.style.display).toBe('none');
  });

  it('leaves an unrelated button and its container alone', () => {
    const button = el('button', { text: 'Sign In' });
    const container = el('div', { selectors: ['[role="group"]'], children: [button] });
    const { run } = createHarness([container]);

    run();

    expect(button.style.display).toBe('');
    expect(container.style.display).toBe('');
  });

  it('leaves a caption that wraps an interactive control alone', () => {
    const caption = el('div', {
      text: CAPTION_TEXT,
      children: [el('a', { selectors: ['a[href]'] })],
    });
    const { run } = createHarness([caption]);

    run();

    expect(caption.style.display).toBe('');
  });

  it('logs the counts behind the substituted prefix', () => {
    const { caption, container } = hiddenFixtures();
    const { info, run } = createHarness([container, caption]);

    run();

    // Two rules: the payload's own, plus the block the script appends.
    expect(info).toHaveBeenCalledWith(
      `${CONFIG.logPrefix} 2 CSS rules injected, 1 buttons hidden, 1 captions hidden, 1 containers hidden`,
    );
  });

  it('observes the body once and hides what a later mutation adds', () => {
    const { body, observers, run } = createHarness();

    run();
    run();

    expect(observers).toHaveLength(1);
    expect(observers[0]?.target).toBe(body);

    const late = el('button', { text: 'Use a passkey' });
    body.appendChild(late);
    observers[0]?.callback();

    expect(late.style.display).toBe('none');
  });
});
