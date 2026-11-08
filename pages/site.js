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

  /* Download button: point Linux visitors at the versionless AppImage for
     their CPU and everyone else at the latest release. */
  function setupDownload() {
    const button = document.getElementById("download-button");
    if (!button) return;
    const latest = "https://github.com/wimpysworld/sidra/releases/latest";
    const appImage = (arch) => `${latest}/download/Sidra-linux-${arch}.AppImage`;
    const ua = navigator.userAgent || "";
    const data = navigator.userAgentData;
    const platform = (data && data.platform) || "";
    let os = "";
    if (/Android/i.test(platform) || /Android/i.test(ua)) os = "android";
    else if (/iPhone|iPad|iPod/i.test(platform + ua)) os = "ios";
    else if (/Linux/i.test(platform) || (/Linux|X11/i.test(ua) && !/Android/i.test(ua))) os = "linux";
    else if (/mac/i.test(platform) || /Macintosh|Mac OS X/i.test(ua)) os = "macos";
    else if (/win/i.test(platform) || /Windows/i.test(ua)) os = "windows";

    const icon = button.querySelector(".octicon");
    const setLabel = (text, detail) => {
      button.textContent = "";
      button.append(text + " ");
      if (detail) {
        const small = document.createElement("small");
        small.textContent = detail;
        button.append(small, " ");
      }
      if (icon) button.append(icon);
    };

    if (os === "linux") {
      const arm = /aarch64|arm64|armv8/i.test(ua);
      const arch = arm ? "arm64" : "x86_64";
      button.href = appImage(arch);
      setLabel("Download for Linux", `AppImage, ${arch}`);
    } else if (os === "macos") {
      button.href = latest;
      setLabel("Download for macOS", "DMG");
    } else if (os === "windows") {
      button.href = latest;
      setLabel("Download for Windows", "Installer");
    } else {
      button.href = latest;
      setLabel("Download the latest release");
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

    function applyPalette() {
      const name = slides[current].dataset.themeName;
      const palette = PALETTES[name];
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

    function scrollTo(index, focusSlide) {
      const next = Math.max(0, Math.min(slides.length - 1, index));
      carousel.scrollTo({
        left: next * carousel.clientWidth,
        behavior: reduceMotion.matches ? "auto" : "smooth",
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
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            const index = slides.indexOf(entry.target);
            if (index !== -1 && index !== current) markActive(index);
          });
        },
        { root: carousel, threshold: 0.6 },
      );
      slides.forEach((slide) => observer.observe(slide));
    }

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

  /* Copy buttons on install commands. */
  function setupCopyButtons() {
    if (!navigator.clipboard || !window.isSecureContext) return;
    const status = document.getElementById("copy-status");
    document.querySelectorAll("pre[data-copy]").forEach((pre) => {
      const code = pre.querySelector("code");
      if (!code) return;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "copy-button";
      button.setAttribute("aria-label", "Copy command");
      const icon = document.createElement("span");
      icon.className = "octicon copy-icon";
      icon.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.textContent = "Copy";
      button.append(icon, label);
      let timer = 0;
      button.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(code.textContent.replace(/\n$/, ""));
        } catch {
          label.textContent = "Press Ctrl+C";
          if (status) status.textContent = "Copy failed. Select the command and copy it yourself.";
          return;
        }
        button.dataset.copied = "true";
        icon.className = "octicon check-icon";
        label.textContent = "Copied";
        if (status) status.textContent = "Command copied to the clipboard.";
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          delete button.dataset.copied;
          icon.className = "octicon copy-icon";
          label.textContent = "Copy";
          if (status) status.textContent = "";
        }, 2000);
      });
      pre.append(button);
    });
  }

  setupDownload();
  setupThemes();
  setupCopyButtons();
})();
