import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

import { AUTH_FIX_TOKEN, PASSKEY_CONTAINER_SELECTORS } from '../src/authFrame';

const authFixSource = fs.readFileSync(
  path.join(__dirname, '..', 'assets', 'authFrameFix.js'),
  'utf-8',
);

// Substitute the config token before execution, as loadAssets() does in src/main.ts.
// Distinct fixture values show that the stylesheet and log use the supplied payload, not asset defaults.
const CONFIG = {
  css: '.stub-passkey { display: none !important; }\n',
  containerSelectors: PASSKEY_CONTAINER_SELECTORS,
  logPrefix: '[stub] auth-frame hide:',
};

const authFixScript = authFixSource.replace(AUTH_FIX_TOKEN, () => JSON.stringify(CONFIG));

const CAPTION_TEXT = 'Requires iOS 16 or later';

class StubStyle {
  private readonly properties = new Map<string, { value: string; priority: string }>();

  get display(): string {
    return this.getPropertyValue('display');
  }

  getPropertyValue(name: string): string {
    return this.properties.get(name)?.value ?? '';
  }

  getPropertyPriority(name: string): string {
    return this.properties.get(name)?.priority ?? '';
  }

  setProperty(name: string, value: string, priority = ''): void {
    if (value) this.properties.set(name, { value, priority });
    else this.properties.delete(name);
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
    expect(style?.textContent).toBe(CONFIG.css);
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

  it.each(PASSKEY_CONTAINER_SELECTORS)('hides localised controls inside %s', (selector) => {
    const button = el('button', { text: 'Mit Sicherheitsschlüssel anmelden' });
    const caption = el('p', { text: 'Erfordert iOS 16 oder neuer' });
    const container = el('div', { selectors: [selector], children: [button, caption] });
    const { run } = createHarness([container]);

    run();

    expect(container.style.display).toBe('none');
  });

  it.each([...PASSKEY_CONTAINER_SELECTORS, '[role="group"]', 'fieldset'])(
    'preserves an input inside a matching %s container',
    (selector) => {
      const button = el('button', { text: 'Sign in with iPhone' });
      const input = el('input');
      const container = el('div', {
        selectors: [selector],
        children: [button, el('div', { children: [input] })],
      });
      const { run } = createHarness([container]);

      run();

      expect(button.style.display).toBe('none');
      expect(container.style.display).toBe('');
      expect(input.style.display).toBe('');
    },
  );

  it('preserves a shared input wrapper around a localised passkey container', () => {
    const button = el('button', { text: 'Mit Sicherheitsschlüssel anmelden' });
    const container = el('div', {
      selectors: ['[data-component-name*="passkey" i]'],
      children: [button],
    });
    const input = el('input');
    const shared = el('div', {
      selectors: ['[class*="passkey-section" i]'],
      children: [input, container],
    });
    const { run } = createHarness([shared]);

    run();

    expect(shared.style.display).toBe('');
    expect(input.style.display).toBe('');
    expect(container.style.display).toBe('none');
  });

  it('preserves an input that carries a feature selector itself', () => {
    const input = el('input', { selectors: ['[data-component-name*="passkey" i]'] });
    const { run } = createHarness([input]);

    run();

    expect(input.style.display).toBe('');
  });

  it.each([1, 2])('preserves an input in a caption fallback at depth %i', (depth) => {
    const button = el('button', { text: 'Sign in with iPhone' });
    const child = depth === 1 ? button : el('div', { children: [button] });
    const input = el('input');
    const container = el('div', {
      children: [child, input, el('p', { text: CAPTION_TEXT })],
    });
    const { run } = createHarness([container]);

    run();

    expect(button.style.display).toBe('none');
    expect(container.style.display).toBe('');
    expect(input.style.display).toBe('');
  });

  it.each([1, 2, 3])('limits caption fallback hiding at depth %i', (depth) => {
    const button = el('button', { text: 'Sign in with iPhone' });
    let child = button;
    for (let level = 1; level < depth; level++) child = el('div', { children: [child] });
    const container = el('div', { children: [child, el('p', { text: CAPTION_TEXT })] });
    const { run } = createHarness([container]);

    run();

    expect(button.style.display).toBe('none');
    expect(container.style.display).toBe(depth <= 2 ? 'none' : '');
  });

  it('does not hide the document body when it carries a feature selector', () => {
    const { body, run } = createHarness([el('button', { text: 'Use a passkey' })]);
    body.selectors.push(PASSKEY_CONTAINER_SELECTORS[0]!);

    run();

    expect(body.style.display).toBe('');
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

    expect(info).toHaveBeenCalledWith(
      `${CONFIG.logPrefix} 1 CSS rules injected, 1 buttons hidden, 1 captions hidden, 1 containers hidden`,
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

    const localised = el('div', {
      selectors: ['[data-component-name*="passkey" i]'],
      children: [el('button', { text: 'Mit Sicherheitsschlüssel anmelden' })],
    });
    body.appendChild(localised);
    observers[0]?.callback();

    expect(localised.style.display).toBe('none');
  });

  const lateInputContainers = [
    {
      name: 'feature container',
      create: () => el('div', {
        selectors: ['[data-component-name*="passkey" i]'],
        children: [el('button', { text: 'Mit Sicherheitsschlüssel anmelden' })],
      }),
    },
    {
      name: 'matched ancestor',
      create: () => el('div', {
        selectors: ['[role="group"]'],
        children: [el('button', { text: 'Use a passkey' })],
      }),
    },
    ...[1, 2].map((depth) => ({
      name: `caption fallback at depth ${depth}`,
      create: () => {
        const button = el('button', { text: 'Sign in with iPhone' });
        return el('div', {
          children: [depth === 1 ? button : el('div', { children: [button] }), el('p', { text: CAPTION_TEXT })],
        });
      },
    })),
    { name: 'standalone caption', create: () => el('p', { text: CAPTION_TEXT }) },
  ];

  it.each(lateInputContainers)('restores $name when an input arrives', ({ create }) => {
    const container = create();
    const { observers, run } = createHarness([container]);
    run();
    expect(container.style.display).toBe('none');

    observers[0]?.callback();
    const input = el('input');
    container.appendChild(el('div', { children: [input] }));
    observers[0]?.callback();

    expect(container.style.display).toBe('');
    expect(container.style.getPropertyPriority('display')).toBe('');
    expect(input.style.display).toBe('');
  });

  it.each([['flex', 'important'], ['grid', '']])(
    'restores the original display %s with priority %s across reinjection',
    (value, priority) => {
      const { body, observers, run } = createHarness();
      run();
      const { container } = hiddenFixtures();
      container.style.setProperty('display', value, priority);
      body.appendChild(container);
      run();
      observers[0]?.callback();
      expect(container.style.display).toBe('none');

      container.style.setProperty('color', 'red', 'important');
      container.appendChild(el('input'));
      observers[0]?.callback();

      expect(container.style.display).toBe(value);
      expect(container.style.getPropertyPriority('display')).toBe(priority);
      expect(container.style.getPropertyValue('color')).toBe('red');
      expect(container.style.getPropertyPriority('color')).toBe('important');
    },
  );

  it.each(lateInputContainers)('preserves Apple-owned hiding on $name', ({ create }) => {
    const container = create();
    container.style.setProperty('display', 'none');
    const { observers, run } = createHarness([container]);
    run();
    container.appendChild(el('input'));
    observers[0]?.callback();

    expect(container.style.display).toBe('none');
    expect(container.style.getPropertyPriority('display')).toBe('');
  });

  it.each([['flex', 'important'], ['grid', ''], ['none', '']])(
    'preserves a later Apple display %s with priority %s',
    (value, priority) => {
      const { container } = hiddenFixtures();
      const { observers, run } = createHarness([container]);
      run();
      container.style.setProperty('display', value, priority);
      container.appendChild(el('input'));
      observers[0]?.callback();

      expect(container.style.display).toBe(value);
      expect(container.style.getPropertyPriority('display')).toBe(priority);
    },
  );

  it('restores all hidden ancestors after a detached subtree is reinserted', () => {
    const { button, container } = hiddenFixtures();
    const outer = el('div', {
      selectors: ['[class*="passkey-section" i]'],
      children: [container],
    });
    const { body, observers, run } = createHarness([outer]);
    run();
    expect(outer.style.display).toBe('none');
    expect(container.style.display).toBe('none');

    outer.remove();
    observers[0]?.callback();
    outer.selectors.length = 0;
    container.selectors.length = 0;
    button.remove();
    container.appendChild(el('input'));
    body.appendChild(outer);
    observers[0]?.callback();

    expect(outer.style.display).toBe('');
    expect(container.style.display).toBe('');
  });
});
