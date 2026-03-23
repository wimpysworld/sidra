(function () {
  if (document.getElementById('sidra-nav-buttons')) return;

  const logoEl = document.querySelector('.navigation__header .logo');
  if (!logoEl) {
    console.warn('Sidra: .navigation__header .logo not found');
    return;
  }

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

  function createButton(label, svgContent, channel) {
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
      'color: var(--systemPrimary, #ffffff) !important',
      'opacity: 0.7 !important',
      'transition: opacity 0.15s ease, color 0.15s ease !important',
    ].join('; '));

    btn.innerHTML = svgContent;

    btn.addEventListener('mouseenter', function () {
      this.style.setProperty('opacity', '1', 'important');
      this.style.setProperty('color', 'var(--keyColor, #fa586a)', 'important');
      var svg = this.querySelector('svg');
      if (svg) svg.style.setProperty('stroke', 'var(--keyColor, #fa586a)', 'important');
    });
    btn.addEventListener('mouseleave', function () {
      this.style.setProperty('opacity', '0.7', 'important');
      this.style.setProperty('color', 'var(--systemPrimary, #ffffff)', 'important');
      var svg = this.querySelector('svg');
      if (svg) svg.style.setProperty('stroke', 'var(--systemPrimary, #ffffff)', 'important');
    });

    btn.addEventListener('click', function () {
      window.AMWrapper.ipcRenderer.send(channel);
    });

    return btn;
  }

  var svgAttrs = 'xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--systemPrimary, #ffffff)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';

  var backSvg = '<svg ' + svgAttrs + '><polyline points="15 18 9 12 15 6"></polyline></svg>';
  var forwardSvg = '<svg ' + svgAttrs + '><polyline points="9 6 15 12 9 18"></polyline></svg>';
  var reloadSvg = '<svg ' + svgAttrs + '><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>';

  container.appendChild(createButton('Back', backSvg, 'nav:back'));
  container.appendChild(createButton('Forward', forwardSvg, 'nav:forward'));
  container.appendChild(createButton('Reload', reloadSvg, 'nav:reload'));

  logoEl.appendChild(container);

  console.log('[Sidra] Navigation bar injected');
})();
