// Pure module: no electron imports so tests can exercise it directly.
//
// Renders a complete Apple Music override stylesheet from a 12-slot
// palette. The template reproduces the structure of the original
// hand-written catppuccin.css; the Catppuccin palette renders to the
// same values it shipped with (see test/themes.test.ts).

export interface SchemeColours {
  /** Page background */
  base: string;
  /** Opaque shelf, player, and material backgrounds (darker than base) */
  mantle: string;
  /** Footer background and deepest shadows (darker than mantle) */
  crust: string;
  /** LCD fill, tracklist rows, banner dropdowns */
  surface0: string;
  /** Scrollbar thumb, segmented control selection, generic accents */
  surface1: string;
  /** Borders and dividers */
  surface2: string;
  /** Tertiary text */
  overlay: string;
  /** Primary text */
  text: string;
  /** Secondary text */
  subtext1: string;
  /** Emphasised secondary text */
  subtext0: string;
  /** Key colour: brand, selection, scrubber fill, platter buttons */
  accent: string;
  /** Accent rollover and pressed states */
  accentHover: string;
}

export interface ThemeDefinition {
  name: string;
  label: string;
  dark: SchemeColours;
  light: SchemeColours;
}

function rgbTriplet(hex: string): string {
  const value = hex.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `${r},${g},${b}`;
}

function rgba(hex: string, alpha: number): string {
  return `rgba(${rgbTriplet(hex)},${alpha})`;
}

// The original stylesheet used spaced rgba() in the side-panel block;
// preserved for byte compatibility with the previous catppuccin.css asset.
function rgbaSpaced(hex: string, alpha: number): string {
  return `rgba(${rgbTriplet(hex).split(',').join(', ')}, ${alpha})`;
}

function schemeBlock(c: SchemeColours): string {
  return `  :root {
    /* Background & Structure */
    --pageBG: ${c.base} !important;
    --pageBG-rgb: ${rgbTriplet(c.base)} !important;
    --opaqueShelfBG: ${c.mantle} !important;
    --fallbackMaterialBG: ${rgba(c.mantle, 0.97)} !important;
    --shelfBG: ${rgba(c.surface0, 0.15)} !important;
    --genericJoeColor: ${c.surface1} !important;

    /* Accent */
    --keyColor: ${c.accent} !important;
    --keyColor-rgb: ${rgbTriplet(c.accent)} !important;
    --keyColor-rollover: ${c.accentHover} !important;
    --keyColor-pressed: ${c.accentHover} !important;
    --keyColor-deepPressed: ${c.accentHover} !important;
    --keyColor-disabled: ${rgba(c.accent, 0.35)} !important;
    --musicKeyColor: ${c.accent} !important;
    --musicBrandBG: ${c.accent} !important;
    --selectionColor: ${c.accent} !important;

    /* Text */
    --systemPrimary: ${rgba(c.text, 0.85)} !important;
    --systemPrimary-vibrant: ${c.text} !important;
    --systemSecondary: ${rgba(c.subtext1, 0.55)} !important;
    --systemSecondary-vibrant: ${c.subtext0} !important;
    --systemTertiary: ${rgba(c.overlay, 0.25)} !important;
    --systemQuaternary: ${rgba(c.surface1, 0.15)} !important;
    --systemQuinary: ${rgba(c.surface0, 0.08)} !important;

    /* Borders & Dividers */
    --labelDivider: ${rgba(c.surface2, 0.2)} !important;
    --vibrantDivider: ${rgba(c.surface2, 0.25)} !important;

    /* Player */
    --playerBackground: ${rgba(c.mantle, 0.88)} !important;
    --playerBackgroundFallback: ${rgba(c.mantle, 0.97)} !important;
    --playerLCDBGFill: ${c.surface0} !important;
    --playerScrubberFill: ${c.accent} !important;
    --playerScrubberTrack: ${rgba(c.surface1, 0.2)} !important;
    --playerPlatterButtonBGFill: ${c.accent} !important;
    --playerPlatterButtonIconFill: ${c.base} !important;
    --playerDropShadow2: ${rgba(c.crust, 0.1)} !important;

    /* Navigation */
    --segmentedControlBG: ${rgba(c.surface0, 0.2)} !important;
    --segmentedControlSelectedBG: ${c.surface1} !important;

    /* Tracklist */
    --tracklistHoverColor: ${rgba(c.surface0, 0.08)} !important;
    --tracklistAltRowColor: ${rgba(c.surface0, 0.03)} !important;

    /* Materials */
    --systemStandardThickMaterialSover: ${rgba(c.mantle, 0.72)} !important;
    --systemHeaderMaterialSover: ${rgba(c.mantle, 0.8)} !important;
    --systemToolbarTitlebarMaterialSover: ${rgba(c.mantle, 0.8)} !important;
  }

  /* Scrollbars */
  * {
    scrollbar-color: ${c.surface1} ${c.mantle} !important;
  }

  *::-webkit-scrollbar {
    width: 12px !important;
    height: 12px !important;
    background-color: ${c.mantle} !important;
  }

  *::-webkit-scrollbar-thumb {
    background-color: ${c.surface1} !important;
    border: 3px solid ${c.mantle} !important;
    border-radius: 999px !important;
  }

  *::-webkit-scrollbar-track {
    background-color: ${c.mantle} !important;
  }

  /* Force variables into shadow-DOM-scoped elements */
  * {
    --keyColor: ${c.accent} !important;
    --keyColor-rgb: ${rgbTriplet(c.accent)} !important;
    --keyColor-rollover: ${c.accentHover} !important;
    --keyColor-pressed: ${c.accentHover} !important;
    --keyColor-deepPressed: ${c.accentHover} !important;
    --keyColor-disabled: ${rgba(c.accent, 0.35)} !important;
    --musicKeyColor: ${c.accent} !important;
    --musicBrandBG: ${c.accent} !important;
    --selectionColor: ${c.accent} !important;
  }

  /* Side panels (Lyrics + Up Next): not covered by :root variables */
  .side-panel {
    background-color: ${rgbaSpaced(c.mantle, 0.97)} !important;
    backdrop-filter: blur(50px) saturate(100%) !important;
  }
  .side-panel.side-panel-header-wrapper,
  .side-panel .side-panel-header-wrapper,
  .side-panel-header-wrapper {
    background-color: ${rgbaSpaced(c.mantle, 0.97)} !important;
  }

  /* Footer */
  :is(
    footer,
    .scrollable-page footer
  ) {
    background: ${c.crust} !important;
    background-color: ${c.crust} !important;
    border-color: ${rgba(c.surface2, 0.2)} !important;
    color: ${rgba(c.text, 0.85)} !important;
  }

  :is(
    footer,
    .scrollable-page footer
  ) :is(a, button, select, [role="button"], [class*="dropdown"]) {
    background-color: ${c.mantle} !important;
    border-color: ${rgba(c.surface2, 0.25)} !important;
    color: ${rgba(c.text, 0.85)} !important;
  }

  /* Country/region picker modal background */
  [class*="locale-switcher"] {
    background: ${c.mantle} !important;
    background-color: ${c.mantle} !important;
  }

  /* Country/region banner (bottom strip) */
  [data-testid="banner-container"] {
    background: ${c.mantle} !important;
    background-color: ${c.mantle} !important;
    color: ${rgba(c.text, 0.85)} !important;
    border-color: ${rgba(c.surface2, 0.25)} !important;
  }
  [data-testid="banner-container"] [data-testid="close-button"] {
    color: ${rgba(c.text, 0.85)} !important;
    fill: ${rgba(c.text, 0.85)} !important;
  }
  [data-testid="banner-container"] [data-testid="close-button"] svg path {
    fill: ${rgba(c.text, 0.85)} !important;
  }
  [data-testid="banner-container"] [data-testid="dropdown-button"] {
    background-color: ${c.surface0} !important;
    border-color: ${rgba(c.surface2, 0.4)} !important;
    color: ${rgba(c.text, 0.85)} !important;
  }`;
}

export function buildThemeCss(theme: ThemeDefinition): string {
  return `/*
 * ${theme.label} theme for Apple Music
 * Dark and light variants via prefers-color-scheme
 * Generated by src/themeTemplate.ts from src/palettes.ts
 */

@media (prefers-color-scheme: dark) {
${schemeBlock(theme.dark)}
}

@media (prefers-color-scheme: light) {
${schemeBlock(theme.light)}
}

/* Override hardcoded primary button background to use the theme accent */
.button.primary button.click-action {
  background-color: var(--keyColor) !important;
}
`;
}
