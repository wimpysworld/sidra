// Back, forward and reload buttons for the Apple Music sidebar header. The web
// UI has no need for them; a desktop window with no browser chrome does.
(function () {
  // The script runs on every page load and on SPA navigation, which can keep
  // the existing header, so bail out rather than add a second set of buttons.
  if (document.getElementById('sidra-nav-buttons')) return;

  // Not standalone-executable JavaScript: loadAssets() in src/main.ts replaces
  // this bare token with the translated labels as JSON, because the script is
  // injected with executeJavaScript() and cannot take the query parameters the
  // splash screen uses. NAV_LABELS_TOKEN in src/i18n.ts is the shared spelling.
  /** @type {{ back: string, forward: string, reload: string }} */
  var LABELS = __SIDRA_NAV_LABELS__;

  const logoEl = document.querySelector('.navigation__header .logo');
  if (!logoEl) {
    console.warn('Sidra: .navigation__header .logo not found');
    return;
  }

  // The buttons are appended to the logo row, so it has to lay out as a flex
  // container before the margin-left: auto below can push them to the right.
  logoEl.setAttribute('style', [
    'display: flex !important',
    'align-items: center !important',
    'justify-content: space-between !important',
  ].join('; '));

  const container = document.createElement('div');
  container.id = 'sidra-nav-buttons';
  container.setAttribute('style', [
    'display: flex !important',
    'align-items: center !important',
    'gap: 4px !important',
    'margin-left: auto !important',
    'pointer-events: auto !important',
  ].join('; '));

  /**
   * Send to the main process, tolerating an absent bridge.
   *
   * window.AMWrapper is installed by the preload script. It is normally there
   * before this runs, but the script is injected into a page it does not
   * control and cannot assume it. sendToMain() in assets/musicKitHook.js guards
   * the same bridge for the same reason; an unguarded send here would throw a
   * TypeError out of a click listener with no catch above it.
   *
   * @param {string} channel - IPC channel name
   * @returns {void}
   */
  function sendToMain(channel) {
    const bridge = window.AMWrapper;
    if (!bridge || !bridge.ipcRenderer) return;
    bridge.ipcRenderer.send(channel);
  }

  /** @type {string} */
  var SVG_NS = 'http://www.w3.org/2000/svg';

  /**
   * Create an SVG element with the given tag and attributes.
   * @param {string} tag - SVG element tag name (e.g. 'svg', 'polyline', 'path')
   * @param {Record<string, string>} attrs - Attribute key-value pairs
   * @returns {SVGElement}
   */
  function createSvgElement(tag, attrs) {
    var el = document.createElementNS(SVG_NS, tag);
    for (var key in attrs) {
      el.setAttribute(key, attrs[key]);
    }
    return el;
  }

  /** @type {string} */
  var IDLE_COLOR = 'var(--systemPrimary, #ffffff)';
  /** @type {string} */
  var HOVER_COLOR = 'var(--keyColor, #fa586a)';

  var sharedAttrs = {
    width: '20',
    height: '20',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: IDLE_COLOR,
    'stroke-width': '1.5',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  };

  // Icon geometry only; the wrapping svg carries sharedAttrs.
  /** @type {Array<{ label: string, channel: string, icon: Array<[string, Record<string, string>]> }>} */
  var BUTTONS = [
    { label: LABELS.back, channel: 'nav:back', icon: [['polyline', { points: '15 18 9 12 15 6' }]] },
    {
      label: LABELS.forward,
      channel: 'nav:forward',
      icon: [['polyline', { points: '9 6 15 12 9 18' }]],
    },
    {
      label: LABELS.reload,
      channel: 'nav:reload',
      icon: [
        ['polyline', { points: '23 4 23 10 17 10' }],
        ['path', { d: 'M20.49 15a9 9 0 1 1-2.12-9.36L23 10' }],
      ],
    },
  ];

  /**
   * Paint a button and its icon. The base styles are inline and !important, so a
   * :hover rule in an injected stylesheet could never beat them; hover has to be
   * written from JavaScript.
   *
   * @param {HTMLButtonElement} button - Button to paint
   * @param {string} color - Colour for the button and the icon stroke
   * @param {string} opacity - Button opacity
   * @returns {void}
   */
  function paintButton(button, color, opacity) {
    button.style.setProperty('opacity', opacity, 'important');
    button.style.setProperty('color', color, 'important');
    var svg = button.querySelector('svg');
    if (svg) svg.style.setProperty('stroke', color, 'important');
  }

  /**
   * Create a navigation button that sends an IPC message on click.
   * @param {string} label - Accessible label for the button
   * @param {SVGSVGElement} svgElement - Icon to display inside the button
   * @param {string} channel - IPC channel name sent via window.AMWrapper
   * @returns {HTMLButtonElement}
   */
  function createButton(label, svgElement, channel) {
    const btn = document.createElement('button');
    btn.setAttribute('aria-label', label);
    btn.setAttribute('style', [
      'background: none !important',
      'border: none !important',
      'cursor: pointer !important',
      'padding: 6px !important',
      'border-radius: 6px !important',
      'display: flex !important',
      'align-items: center !important',
      'justify-content: center !important',
      'color: ' + IDLE_COLOR + ' !important',
      'opacity: 0.7 !important',
      'transition: opacity 0.15s ease, color 0.15s ease !important',
    ].join('; '));

    btn.appendChild(svgElement);

    btn.addEventListener('mouseenter', function () {
      paintButton(this, HOVER_COLOR, '1');
    });
    btn.addEventListener('mouseleave', function () {
      paintButton(this, IDLE_COLOR, '0.7');
    });

    btn.addEventListener('click', function () {
      sendToMain(channel);
    });

    return btn;
  }

  BUTTONS.forEach(function (spec) {
    var svg = createSvgElement('svg', sharedAttrs);
    spec.icon.forEach(function (child) {
      svg.appendChild(createSvgElement(child[0], child[1]));
    });
    container.appendChild(createButton(spec.label, svg, spec.channel));
  });

  logoEl.appendChild(container);

  console.log('[Sidra] Navigation bar injected');
})();
