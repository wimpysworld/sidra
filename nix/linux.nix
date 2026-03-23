{
  lib,
  stdenvNoCC,
  fetchurl,
  buildFHSEnv,
  bintools,
  xz,

  # Runtime dependencies provided inside the FHS environment
  alsa-lib,
  at-spi2-atk,
  at-spi2-core,
  atk,
  cairo,
  cups,
  dbus,
  expat,
  fontconfig,
  freetype,
  gcc-unwrapped,
  gdk-pixbuf,
  glib,
  gtk3,
  libdrm,
  libglvnd,
  libnotify,
  libX11,
  libxcb,
  libXcomposite,
  libXdamage,
  libXext,
  libXfixes,
  libxkbcommon,
  libXrandr,
  libxshmfence,
  libgbm,
  nspr,
  nss,
  pango,
  pipewire,
  vulkan-loader,
  wayland,
  systemd,
  libpulseaudio,
  version,
}:

let
  pname = "sidra";

  src = fetchurl {
    url = "https://github.com/wimpysworld/sidra/releases/download/${version}/Sidra-${version}-linux-amd64.deb";
    hash = "sha256-iu+gJIvK1MoFKhEd0XjkrbiyXJomOQ3CNFTOUYk0z3o=";
  };

  # Unpack the deb into a plain derivation. No patching - the CastLabs
  # Electron binary is VMP-signed for Widevine DRM and must not be modified.
  unpacked = stdenvNoCC.mkDerivation {
    pname = "${pname}-unpacked";
    inherit version src;

    nativeBuildInputs = [
      bintools # ar
      xz
    ];

    dontConfigure = true;
    dontBuild = true;

    unpackPhase = ''
      runHook preUnpack
      ${lib.getExe' bintools "ar"} x $src
      tar xf data.tar.xz
      runHook postUnpack
    '';

    installPhase = ''
      runHook preInstall

      mkdir -p $out
      cp -a opt/Sidra $out/opt
      cp -a usr/share $out/share

      # Fix the desktop file to point at the wrapper (will be set by FHS env)
      substituteInPlace $out/share/applications/sidra.desktop \
        --replace-fail /opt/Sidra/sidra sidra

      runHook postInstall
    '';
  };

  # Libraries that the Electron binary links against at runtime
  libs = [
    alsa-lib
    at-spi2-atk
    at-spi2-core
    atk
    cairo
    cups
    dbus
    expat
    fontconfig
    freetype
    gcc-unwrapped.lib
    gdk-pixbuf
    glib
    gtk3
    libdrm
    libglvnd
    libnotify
    libX11
    libxcb
    libXcomposite
    libXdamage
    libXext
    libXfixes
    libxkbcommon
    libXrandr
    libxshmfence
    libgbm
    nspr
    nss
    pango
    pipewire
    vulkan-loader
    wayland
    systemd
    libpulseaudio
  ];

  fhs = buildFHSEnv {
    name = pname;
    targetPkgs = _: libs;

    runScript = "${unpacked}/opt/sidra";

    extraInstallCommands = ''
      # Desktop file and icons from the deb
      mkdir -p $out/share
      cp -a ${unpacked}/share/applications $out/share/
      cp -a ${unpacked}/share/icons $out/share/

      # Point desktop file Exec at the FHS wrapper
      substituteInPlace $out/share/applications/sidra.desktop \
        --replace-fail "Exec=sidra" "Exec=$out/bin/sidra"
    '';

    meta = {
      description = "An elegant Apple Music desktop client";
      homepage = "https://github.com/wimpysworld/sidra";
      license = lib.licenses.blueOak100;
      maintainers = with lib.maintainers; [ flexiondotorg ];
      platforms = [ "x86_64-linux" ];
      sourceProvenance = with lib.sourceTypes; [ binaryNativeCode ];
      mainProgram = "sidra";
    };
  };
in
fhs
