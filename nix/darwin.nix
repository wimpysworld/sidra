{
  lib,
  stdenvNoCC,
  fetchurl,
  makeWrapper,
  undmg,
  version,
}:

stdenvNoCC.mkDerivation {
  pname = "sidra";
  inherit version;

  # The url and hash below are rewritten together by the nix-hash CI job, which
  # reads the filename off the published release. Do not edit them by hand.
  src = fetchurl {
    url = "https://github.com/wimpysworld/sidra/releases/download/${version}/Sidra-${version}-mac-arm64.dmg";
    hash = "sha256-n57dyDrQmV7jqKeadx/2DnGYE8VxXUhKHh2Fosf3+3o=";
  };

  dontPatch = true;
  dontConfigure = true;
  dontBuild = true;
  dontFixup = true;

  nativeBuildInputs = [
    makeWrapper
    undmg
  ];

  sourceRoot = ".";

  installPhase = ''
    runHook preInstall

    mkdir -p $out/Applications
    cp -r *.app $out/Applications

    mkdir -p $out/bin
    makeWrapper "$out/Applications/Sidra.app/Contents/MacOS/Sidra" "$out/bin/sidra"

    runHook postInstall
  '';

  meta = {
    description = "An elegant Apple Music desktop client";
    homepage = "https://github.com/wimpysworld/sidra";
    license = lib.licenses.blueOak100;
    maintainers = with lib.maintainers; [ flexiondotorg ];
    platforms = [ "aarch64-darwin" ];
    sourceProvenance = with lib.sourceTypes; [ binaryNativeCode ];
    mainProgram = "sidra";
  };
}
