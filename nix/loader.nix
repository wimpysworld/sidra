# Managed by Tailor: nix/loader.nix
{ pkgs, ... }:
builtins.seq pkgs (
  builtins.concatLists [
    (if builtins.pathExists ./go.nix then import ./go.nix { inherit pkgs; } else [ ])
    (if builtins.pathExists ./pages.nix then import ./pages.nix { inherit pkgs; } else [ ])
    (if builtins.pathExists ./playwright.nix then import ./playwright.nix { inherit pkgs; } else [ ])
  ]
)
