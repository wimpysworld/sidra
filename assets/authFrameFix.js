// Hide passkey, "Sign in with iPhone" and iOS requirement captions to leave password sign-in visible.
// executeJavaScript() runs this script in the iframe's main world, without access to main-process variables.
(() => {
  // loadAssets() in src/main.ts replaces AUTH_FIX_TOKEN from src/authFrame.ts with JSON.
  // executeJavaScript() cannot supply loadFile() query parameters, so the raw asset requires substitution.
  /** @type {{ css: string, containerSelectors: string[], logPrefix: string }} */
  var CONFIG = __SIDRA_AUTH_FIX__;

  // PASSKEY_CONTAINER_SELECTORS in src/authFrame.ts supplies CSS and ancestor matches.
  // Broad selectors stay script-only: they start at a matched button, but CSS would hide unrelated form groups.
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
    // Prefer a matching container. Limit the caption fallback to two parents
    // to avoid hiding the whole form.
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
    // Captions can sit outside passkey containers. Keep elements that contain
    // interactive controls so other form rows remain visible.
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

  // Without a preload, the frame reports through console.
  // setupAuthFrameInjection() recognises the log prefix.
  const cssRuleCount = css.split('}').length - 1;
  console.info(CONFIG.logPrefix + ' ' + cssRuleCount + ' CSS rules injected, ' + result.buttonsHidden + ' buttons hidden, ' + result.captionsHidden + ' captions hidden, ' + result.containersHidden + ' containers hidden');
})();
