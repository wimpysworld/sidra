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

  # The nix-hash CI job updates this URL and hash as one pair from each release.
  # Do not edit either value by hand, because the pair must stay in sync.
  src = fetchurl {
    url = "https://github.com/wimpysworld/sidra/releases/download/${version}/Sidra-${version}-mac-arm64.dmg";
    hash = "sha256-Aqj1Dy5nJG7hW32LO8E98lL5g7N2RtyA9bxmcEyjAg8=";
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
