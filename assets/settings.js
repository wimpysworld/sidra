(() => {
  'use strict';

  const bridge = window.sidraSettings;
  const byId = (id) => document.getElementById(id);
  const params = new URLSearchParams(window.location.search);
  const lang = params.get('lang') || 'en';
  document.documentElement.lang = lang;
  document.documentElement.dir = /^(ar|he)(-|$)/i.test(lang) ? 'rtl' : 'ltr';
  document.title = params.get('settings') || 'Settings';
  document.querySelector('[data-label="settings"]').textContent = document.title;
  const selects = ['musicService', 'startPage', 'theme', 'zoomFactor'];
  const toggles = ['closeToTray', 'notifications', 'discord', 'lastfmEnabled'];
  let state;
  let revision = 0;
  let closed = false;
  let queue = Promise.resolve();

  function showError() {
    if (closed) return;
    byId('error').textContent = state?.labels.settingsError || params.get('settingsError') || 'Could not update settings. Please try again.';
    byId('error').hidden = false;
  }

  function render(next) {
    if (closed) return;
    const focusedId = document.activeElement?.id;
    state = next;
    document.documentElement.lang = state.lang;
    document.documentElement.dataset.theme = state.theme;
    document.documentElement.dir = /^(ar|he)(-|$)/i.test(state.lang) ? 'rtl' : 'ltr';
    document.title = state.labels.settings;
    for (const element of document.querySelectorAll('[data-label]')) {
      element.textContent = state.labels[element.dataset.label];
    }
    for (const key of selects) {
      const select = byId(key);
      const options = state.options[key];
      if (select.options.length !== options.length || options.some((option, index) =>
        select.options[index].value !== String(option.value) || select.options[index].textContent !== option.label)) {
        select.replaceChildren(...options.map(({ value, label }) => {
          const option = document.createElement('option');
          option.value = String(value);
          option.textContent = label;
          return option;
        }));
      }
      select.value = String(state[key]);
    }
    for (const key of toggles) {
      byId(key).checked = key === 'lastfmEnabled' ? state.lastfm.enabled : state[key];
    }
    byId('lastfm').hidden = !state.lastfm.available;
    byId('lastfmEnabled').disabled = !state.lastfm.connected;
    byId('lastfm-status').textContent = state.lastfm.connected
      ? state.labels.lastfmConnected.replace('{name}', state.lastfm.username) : '';
    byId('lastfmConnect').hidden = state.lastfm.connected;
    byId('lastfmDisconnect').hidden = !state.lastfm.connected;
    if (state.lastfm.available && focusedId === 'lastfmConnect' && state.lastfm.connected) byId('lastfmDisconnect').focus();
    if (state.lastfm.available && focusedId === 'lastfmDisconnect' && !state.lastfm.connected) byId('lastfmConnect').focus();
    byId('preferences').hidden = false;
  }

  async function refresh() {
    const requestedAt = revision;
    const next = await bridge.getState();
    if (requestedAt === revision) render(next);
  }

  function apply(action) {
    queue = queue.then(async () => {
      if (closed) return;
      byId('error').hidden = true;
      try {
        const requestedAt = revision;
        const next = await bridge.apply(action);
        if (requestedAt === revision) render(next);
      } catch {
        try { await refresh(); } catch { if (state) render(state); }
        if (!closed) showError();
      }
    });
  }

  for (const key of selects) {
    byId(key).addEventListener('change', () => {
      const action = { type: key, value: key === 'zoomFactor' ? Number(byId(key).value) : byId(key).value };
      if (key === 'startPage') action.serviceId = state.musicService;
      apply(action);
    });
  }
  for (const key of toggles) {
    byId(key).addEventListener('change', () => apply({ type: key, value: byId(key).checked }));
  }
  for (const key of ['lastfmConnect', 'lastfmDisconnect']) {
    byId(key).addEventListener('click', () => apply({ type: key }));
  }
  const unsubscribe = bridge.onState((next) => {
    revision++;
    render(next);
  });
  window.addEventListener('pagehide', () => {
    closed = true;
    unsubscribe();
  }, { once: true });
  refresh().catch(showError);
})();
