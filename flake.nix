{
  description = "An elegant Apple Music desktop client. No frippery, just quality. A better class of Cider 🍎";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
  };

  outputs =
    {
      nixpkgs,
      ...
    }:
    let
      supportedSystems = [
        "x86_64-linux"
        "aarch64-darwin"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;

      # Systems that have release artefacts available
      packageSystems = [
        "x86_64-linux"
        "aarch64-darwin"
      ];
      forPackageSystems = nixpkgs.lib.genAttrs packageSystems;

      version = (nixpkgs.lib.importJSON ./package.json).version;
    in
    {
      packages = forPackageSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          sidra =
            if pkgs.stdenv.hostPlatform.isDarwin then
              pkgs.callPackage ./nix/darwin.nix { inherit version; }
            else
              pkgs.callPackage ./nix/linux.nix { inherit version; };
        in
        {
          inherit sidra;
          default = sidra;
        }
      );

      devShells = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          # Sidra uses Chromium only, so the Playwright MCP server ships
          # Chromium only. The stock package wraps PLAYWRIGHT_BROWSERS_PATH
          # with Chromium, the headless shell, Firefox, and WebKit (2.5 GB).
          # Swapping the browser set in both the driver and playwright-test
          # cuts the closure to 0.9 GB. The headless shell is not needed: the
          # wrapper defaults PLAYWRIGHT_MCP_BROWSER to the chromium channel,
          # which launches the full Chrome for Testing even in headless mode.
          playwrightMcpChromium =
            let
              browsers = pkgs.playwright-driver.browsers-chromium;
              playwright-test = pkgs.playwright-test.overrideAttrs (old: {
                installPhase =
                  let
                    stockBrowsers = "${pkgs.playwright-driver.browsers}";
                    phaseContext =
                      builtins.removeAttrs (builtins.getContext old.installPhase) (
                        builtins.attrNames (builtins.getContext stockBrowsers)
                      )
                      // builtins.getContext "${browsers}";
                    phaseText = builtins.replaceStrings
                      [ (builtins.unsafeDiscardStringContext stockBrowsers) ]
                      [ (builtins.unsafeDiscardStringContext "${browsers}") ]
                      (builtins.unsafeDiscardStringContext old.installPhase);
                  in
                  builtins.appendContext phaseText phaseContext;
              });
            in
            pkgs.playwright-mcp.override {
              inherit playwright-test;
              playwright-driver = pkgs.playwright-driver // {
                inherit browsers;
              };
            };
        in
        {
          default = pkgs.mkShell {
            packages =
              with pkgs;
              [
                # Development tools
                actionlint
                gh
                just
                librsvg # rsvg-convert for tray menu icon generation
                optipng # PNG optimisation for tray menu icons
                nodejs # 24.x Active LTS, matches Electron 40's bundled Node
                playwrightMcpChromium
              ]
              ++ lib.optionals stdenv.isDarwin [
                uv # required for EVS VMP signing via uvx
              ]
              ++ lib.optionals stdenv.isLinux [
                gsettings-desktop-schemas
              ];

            # CastLabs Electron (installed via npm) is a prebuilt binary that
            # expects libraries in standard FHS paths. On NixOS we must set
            # LD_LIBRARY_PATH explicitly for the libraries it links against.
            LD_LIBRARY_PATH = pkgs.lib.optionalString pkgs.stdenv.isLinux (
              with pkgs; lib.makeLibraryPath [
                alsa-lib
                at-spi2-atk
                cairo
                cups
                dbus
                expat
                glib
                gtk3
                libdrm
                libgbm
                libnotify
                libGL
                mesa
                nspr
                nss
                pango
                libx11
                libxcb
                libxcrypt-legacy
                libxcomposite
                libxdamage
                libxext
                libxfixes
                libxkbcommon
                libxrandr
              ]
            );

            # GPU drivers: use NixOS system drivers from /run/opengl-driver/lib
            # This works across GPU vendors (Intel, AMD, NVIDIA) without listing
            # individual driver packages. Same pattern as jivefire.
            shellHook = (pkgs.lib.optionalString pkgs.stdenv.isLinux ''
              if [ -d "/run/opengl-driver/lib" ]; then
                if [ -z "$LD_LIBRARY_PATH" ]; then
                  export LD_LIBRARY_PATH="/run/opengl-driver/lib"
                else
                  export LD_LIBRARY_PATH="/run/opengl-driver/lib:$LD_LIBRARY_PATH"
                fi
              fi
              export XDG_DATA_DIRS="${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}:${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}''${XDG_DATA_DIRS:+:$XDG_DATA_DIRS}"
            '') + ''
              echo "Sidra development shell"
              echo "  node: $(node --version)"
              echo "  npm:  $(npm --version)"
              echo ""
              echo "Run 'just' to see available recipes"
            '';
          };
        }
      );
    };
}
