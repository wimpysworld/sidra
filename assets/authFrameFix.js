// Apple's sign-in iframe offers passkey and "Sign in with iPhone" alongside
// password sign-in, plus captions naming an iOS version requirement. This
// hides them so password sign-in is the visible route.
//
// The script runs in the iframe's main world via executeJavaScript, so it must
// be self-contained: nothing here can close over a main-process variable.
(() => {
  // Not standalone-executable JavaScript: loadAssets() in src/main.ts replaces
  // this bare token with the stylesheet and the log prefix as JSON, because the
  // script is injected with executeJavaScript() and cannot take the query
  // parameters the splash screen uses. AUTH_FIX_TOKEN in src/main.ts is the
  // shared spelling.
  /** @type {{ css: string, containerSelectors: string[], logPrefix: string }} */
  var CONFIG = __SIDRA_AUTH_FIX__;

  // PASSKEY_CONTAINER_SELECTORS in src/main.ts, shared by the two jobs below:
  // the stylesheet hides a match on sight, and closest() walks up to one from a
  // matched button. The extras are script-only. A broad class prefix or a bare
  // [role="group"] is safe for the walk, which starts at a button whose text
  // named passkey or iPhone, and would hide unrelated form groups in the sheet.
  const sharedContainers = CONFIG.containerSelectors;
  const SCRIPT_ONLY_CONTAINERS = ['[class*="passkey" i]', '[class*="iphone" i]', '[role="group"]', 'fieldset'];

  const css = CONFIG.css + '\n' + sharedContainers.join(',\n') + ' {\n  display: none !important;\n}\n';
  const STYLE_ID = 'sidra-auth-fix';
  const TEXT_RE = /(sign in with )?iphone|passkey/i;
  const CAPTION_RE = /requires .{0,30}(ios|iphone|ipad)|(ios|ipados) ?\d+ or later/i;
  const CONTAINER_SELECTOR = sharedContainers.concat(SCRIPT_ONLY_CONTAINERS).join(', ');
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

  // The frame re-renders as the user moves through the flow, so the passes run
  // again from a MutationObserver.
  if (!window.__sidraAuthFixInstalled) {
    window.__sidraAuthFixInstalled = true;
    const target = document.body || document.documentElement;
    if (target && typeof MutationObserver !== 'undefined') {
      const observer = new MutationObserver(() => { runHidePasses(); });
      observer.observe(target, { childList: true, subtree: true });
    }
  }

  // console is the only channel out of a frame the main process has not
  // preloaded; setupAuthFrameInjection() reads the line back off the prefix.
  const cssRuleCount = css.split('}').length - 1;
  console.info(CONFIG.logPrefix + ' ' + cssRuleCount + ' CSS rules injected, ' + result.buttonsHidden + ' buttons hidden, ' + result.captionsHidden + ' captions hidden, ' + result.containersHidden + ' containers hidden');
})();
