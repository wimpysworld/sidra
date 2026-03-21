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
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
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
                nodejs # 24.x Active LTS, matches Electron 40's bundled Node
              ]
              ++ lib.optionals stdenv.isDarwin [
                uv # required for EVS VMP signing via uvx
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
                libGL
                mesa
                nspr
                nss
                pango
                libx11
                libxcb
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
