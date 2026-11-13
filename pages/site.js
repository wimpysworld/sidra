(() => {
  "use strict";

  const root = document.documentElement;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

  function pageScheme() {
    const forced = root.getAttribute("data-theme");
    if (forced === "dark" || forced === "light") return forced;
    return systemDark.matches ? "dark" : "light";
  }

  /* The visitor's OS, for the hero actions. */
  const ua = navigator.userAgent || "";
  function detectOS() {
    const data = navigator.userAgentData;
    const platform = (data && data.platform) || "";
    if (/Android/i.test(platform) || /Android/i.test(ua)) return "android";
    if (/iPhone|iPad|iPod/i.test(platform + ua)) return "ios";
    if (/Linux/i.test(platform) || (/Linux|X11/i.test(ua) && !/Android/i.test(ua))) return "linux";
    if (/mac/i.test(platform) || /Macintosh|Mac OS X/i.test(ua)) return "macos";
    if (/win/i.test(platform) || /Windows/i.test(ua)) return "windows";
    return "";
  }
  const os = detectOS();

  /* Hero actions: the button leads to the visitor's package repository, or to
     the install section, which lists them all. Linux visitors also get a
     direct AppImage download for their CPU as the second action. */
  function setupDownload() {
    const button = document.getElementById("download-button");
    const alternative = document.getElementById("download-alternative");
    if (!button) return;

    const icon = button.querySelector(".octicon");
    const logo = button.querySelector(".download-platform");
    const setButton = (text, logoClass, href) => {
      button.textContent = "";
      if (logo) {
        logo.classList.add(logoClass);
        logo.hidden = false;
        button.append(logo);
      }
      button.append(text + " ");
      if (href) {
        button.href = href;
        if (icon) icon.classList.replace("arrow-down", "arrow-up-right");
      }
      if (icon) button.append(icon);
    };
    const setAlternative = (text, href) => {
      if (!alternative) return;
      alternative.textContent = text;
      alternative.href = href;
    };

    if (os === "linux") {
      const arch = /aarch64|arm64|armv8/i.test(ua) ? "arm64" : "x86_64";
      setButton("Install on Linux", "linux-icon");
      setAlternative(
        `Download the AppImage (${arch})`,
        `https://github.com/wimpysworld/sidra/releases/latest/download/Sidra-linux-${arch}.AppImage`,
      );
    } else if (os === "macos") {
      setButton("Install with Homebrew", "apple-icon", "https://brew.wimpys.world/#sidra");
      setAlternative("Other platforms and formats", "#install");
    } else if (os === "windows") {
      setButton("Install with Scoop", "windows-icon", "https://scoop.wimpys.world/#sidra");
      setAlternative("Other platforms and formats", "#install");
    }
  }

  /* Theme carousel. The palettes mirror src/palettes.ts in the Sidra
     repository: base, mantle, text, subtext1, surface2, accent, accentHover. */
  const PALETTES = {
    everforest: {
      dark: { base: "#2d353b", mantle: "#232a2e", text: "#d3c6aa", subtext: "#d3c6aa", border: "#475258", accent: "#a7c080", accentHover: "#83c092" },
      light: { base: "#fdf6e3", mantle: "#f4f0d9", text: "#414b52", subtext: "#5c6a72", border: "#bdc3af", accent: "#5d6b01", accentHover: "#206e4e" },
    },
    catppuccin: {
      dark: { base: "#1e1e2e", mantle: "#181825", text: "#cdd6f4", subtext: "#bac2de", border: "#585b70", accent: "#f38ba8", accentHover: "#eba0ac" },
      light: { base: "#eff1f5", mantle: "#e6e9ef", text: "#4c4f69", subtext: "#5c5f77", border: "#acb0be", accent: "#d20f39", accentHover: "#e64553" },
    },
    gruvbox: {
      dark: { base: "#282828", mantle: "#1d2021", text: "#ebdbb2", subtext: "#d5c4a1", border: "#665c54", accent: "#fe8019", accentHover: "#d65d0e" },
      light: { base: "#fbf1c7", mantle: "#f2e5bc", text: "#3c3836", subtext: "#504945", border: "#a89984", accent: "#af3a03", accentHover: "#d65d0e" },
    },
    dracula: {
      dark: { base: "#282a36", mantle: "#21222c", text: "#f8f8f2", subtext: "#d8d8d2", border: "#565966", accent: "#bd93f9", accentHover: "#ff79c6" },
      light: { base: "#282a36", mantle: "#21222c", text: "#f8f8f2", subtext: "#d8d8d2", border: "#565966", accent: "#bd93f9", accentHover: "#ff79c6" },
    },
  };
  const THEME_VARS = {
    base: "--theme-base",
    mantle: "--theme-mantle",
    text: "--theme-text",
    subtext: "--theme-subtext",
    border: "--theme-border",
    accent: "--theme-accent",
    accentHover: "--theme-accent-hover",
  };

  function setupThemes() {
    const section = document.getElementById("themes");
    const carousel = section && section.querySelector(".theme-carousel");
    if (!section || !carousel) return;
    const slides = Array.from(carousel.querySelectorAll(".carousel-slide"));
    const tabs = Array.from(section.querySelectorAll(".theme-tabs a"));
    const reset = document.getElementById("theme-reset");
    const arrows = Array.from(section.querySelectorAll("[data-carousel-step]"));
    let current = 0;
    let paletteOn = true;
    let sectionInView = false;

    /* The browser chrome follows the demo while the section is on screen.
       The page backgrounds mirror theme.js, which owns the meta otherwise. */
    const themeMetas = Array.from(document.querySelectorAll('meta[name="theme-color"]'));
    const pageBackgrounds = { light: "#fff", dark: "rgb(19, 22.5, 30.5)" };
    function syncThemeColour() {
      const palette = PALETTES[slides[current].dataset.themeName];
      const demo = sectionInView && paletteOn && palette ? palette[pageScheme()].base : null;
      const forced = root.getAttribute("data-theme");
      themeMetas.forEach((meta) => {
        if (demo) {
          meta.content = demo;
          return;
        }
        const mediaTheme = meta.media.includes("dark") ? "dark" : "light";
        meta.content = pageBackgrounds[forced === "dark" || forced === "light" ? forced : mediaTheme];
      });
    }

    function applyPalette() {
      const name = slides[current].dataset.themeName;
      const palette = PALETTES[name];
      syncThemeColour();
      if (!paletteOn || !palette) {
        Object.values(THEME_VARS).forEach((v) => section.style.removeProperty(v));
        section.style.removeProperty("--theme-heading");
        return;
      }
      const colours = palette[pageScheme()];
      Object.entries(THEME_VARS).forEach(([key, v]) => section.style.setProperty(v, colours[key]));
      section.style.setProperty("--theme-heading", colours.text);
    }

    function markActive(index) {
      current = index;
      tabs.forEach((tab, i) => {
        if (i === index) tab.setAttribute("aria-current", "true");
        else tab.removeAttribute("aria-current");
      });
      if (reset) reset.setAttribute("aria-pressed", String(!paletteOn));
      applyPalette();
    }

    /* A programmatic scroll that crosses a slide must not let the observer
       mark the passing slide active, or the palette flashes through it. The
       lock lifts on scrollend, or after 700ms where scrollend is missing. */
    let scrolling = false;
    let scrollTimer = 0;
    function endScroll() {
      scrolling = false;
      window.clearTimeout(scrollTimer);
    }
    carousel.addEventListener("scrollend", endScroll);

    function scrollTo(index, focusSlide) {
      const next = Math.max(0, Math.min(slides.length - 1, index));
      const animated = !reduceMotion.matches;
      scrolling = animated;
      window.clearTimeout(scrollTimer);
      if (animated) scrollTimer = window.setTimeout(endScroll, 700);
      carousel.scrollTo({
        left: next * carousel.clientWidth,
        behavior: animated ? "smooth" : "auto",
      });
      markActive(next);
      if (focusSlide) carousel.focus({ preventScroll: true });
    }

    tabs.forEach((tab, i) => {
      tab.addEventListener("click", (event) => {
        event.preventDefault();
        paletteOn = true;
        scrollTo(i, false);
      });
    });
    arrows.forEach((arrow) => {
      arrow.hidden = false;
      arrow.addEventListener("click", () => {
        paletteOn = true;
        scrollTo(current + Number(arrow.dataset.carouselStep), false);
      });
    });
    if (reset) {
      reset.hidden = false;
      reset.addEventListener("click", () => {
        paletteOn = !paletteOn;
        markActive(current);
      });
    }
    carousel.addEventListener("keydown", (event) => {
      if (event.key === "ArrowRight") {
        event.preventDefault();
        paletteOn = true;
        scrollTo(current + 1, true);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        paletteOn = true;
        scrollTo(current - 1, true);
      } else if (event.key === "Home") {
        event.preventDefault();
        scrollTo(0, true);
      } else if (event.key === "End") {
        event.preventDefault();
        scrollTo(slides.length - 1, true);
      }
    });

    // Swipes and trackpad scrolls settle on a snap point; follow them.
    if ("IntersectionObserver" in window) {
      const observer = new IntersectionObserver(
        (entries) => {
          if (scrolling) return;
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            const index = slides.indexOf(entry.target);
            if (index !== -1 && index !== current) markActive(index);
          });
        },
        { root: carousel, threshold: 0.6 },
      );
      slides.forEach((slide) => observer.observe(slide));

      // Track whether the section is on screen for the theme-color meta.
      new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            sectionInView = entry.isIntersecting;
          });
          syncThemeColour();
        },
        { threshold: 0.3 },
      ).observe(section);
    }

    // The snap container keeps its pixel offset while the slide width
    // changes, so a resize re-aligns it to the active slide.
    let resizeTimer = 0;
    window.addEventListener("resize", () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        carousel.scrollTo({ left: current * carousel.clientWidth, behavior: "auto" });
      }, 150);
    });

    // Follow the page theme picker and the system scheme.
    systemDark.addEventListener("change", applyPalette);
    new MutationObserver(applyPalette).observe(root, { attributes: true, attributeFilter: ["data-theme"] });

    // Honour a slide anchor in the URL on load, otherwise start at the first.
    const fromHash = slides.findIndex((slide) => `#${slide.id}` === location.hash);
    if (fromHash > 0) {
      carousel.scrollLeft = fromHash * carousel.clientWidth;
      markActive(fromHash);
    } else {
      markActive(0);
    }
  }

  setupDownload();
  setupThemes();
})();
