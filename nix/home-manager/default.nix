{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.sidra;

  color = lib.types.strMatching "#[0-9a-fA-F]{6}";
  palette = lib.types.submodule {
    options = {
      base = lib.mkOption {
        type = color;
        description = "Page background.";
      };
      mantle = lib.mkOption {
        type = color;
        description = "Player background.";
      };
      crust = lib.mkOption {
        type = color;
        description = "Footer background.";
      };
      surface0 = lib.mkOption {
        type = color;
        description = "Control background.";
      };
      surface1 = lib.mkOption {
        type = color;
        description = "Border color.";
      };
      surface2 = lib.mkOption {
        type = color;
        description = "Strong border color.";
      };
      overlay = lib.mkOption {
        type = color;
        description = "Tertiary text color.";
      };
      text = lib.mkOption {
        type = color;
        description = "Primary text color.";
      };
      subtext1 = lib.mkOption {
        type = color;
        description = "Secondary text color.";
      };
      subtext0 = lib.mkOption {
        type = color;
        description = "Emphasised secondary text color.";
      };
      accent = lib.mkOption {
        type = color;
        description = "Highlight color.";
      };
      accentHover = lib.mkOption {
        type = color;
        description = "Highlight hover color.";
      };
    };
  };

  managedSettings =
    lib.optionalAttrs (cfg.settings.theme != null) {
      theme = cfg.settings.theme;
    }
    // lib.optionalAttrs (cfg.settings.player.service != null) {
      musicService = cfg.settings.player.service;
    }
    // lib.optionalAttrs (cfg.settings.player.musicStartPage != null) {
      startPage = cfg.settings.player.musicStartPage;
    }
    // lib.optionalAttrs (cfg.settings.player.classicalStartPage != null) {
      classical.startPage = cfg.settings.player.classicalStartPage;
    }
    // lib.optionalAttrs (cfg.settings.player.zoomFactor != null) {
      zoomFactor = cfg.settings.player.zoomFactor;
    }
    // lib.optionalAttrs (cfg.settings.notifications.enable != null) {
      notifications.enabled = cfg.settings.notifications.enable;
    }
    // lib.optionalAttrs (cfg.settings.discord.richPresence.enable != null) {
      discord.enabled = cfg.settings.discord.richPresence.enable;
    }
    // lib.optionalAttrs (cfg.settings.closeToTray.enable != null) {
      closeToTray.enabled = cfg.settings.closeToTray.enable;
    }
    // lib.optionalAttrs (cfg.settings.autoUpdate.enable != null) {
      autoUpdate.enabled = cfg.settings.autoUpdate.enable;
    };

  nullableOption = type: description: lib.mkOption {
    type = lib.types.nullOr type;
    default = null;
    inherit description;
  };

  themeSource = pkgs.writeText "sidra-custom-theme.json" (
    builtins.toJSON (lib.filterAttrs (_: value: value != null) cfg.customTheme)
  );
  settingsSource = pkgs.writeText "sidra-managed-settings.json" (builtins.toJSON managedSettings);
in
{
  options.programs.sidra = {
    enable = lib.mkEnableOption "Sidra";

    package = lib.mkOption {
      type = lib.types.nullOr lib.types.package;
      default = null;
      defaultText = lib.literalExpression "null";
      description = "The Sidra package to install.";
    };

    customTheme = lib.mkOption {
      type = lib.types.nullOr (
        lib.types.submodule {
          options = {
            dark = lib.mkOption {
              type = palette;
              description = "Dark color palette.";
            };
            light = lib.mkOption {
              type = lib.types.nullOr palette;
              default = null;
              description = "Optional light color palette.";
            };
          };
        }
      );
      default = null;
      description = "Custom Sidra color palette written to custom-theme.json.";
    };

    settings = lib.mkOption {
      default = { };
      description = ''
        Declarative Sidra preferences. Set only the values you want to manage;
        managed values take precedence over Sidra's saved preferences.
      '';
      type = lib.types.submodule {
        options = {
          theme = nullableOption (lib.types.enum [
            "apple-music"
            "catppuccin"
            "dracula"
            "everforest"
            "gruvbox"
            "nord"
            "rose-pine"
            "solarized"
            "tokyo-night"
            "custom"
          ]) "The selected Sidra theme.";

          player = lib.mkOption {
            default = { };
            description = "Player and start page preferences.";
            type = lib.types.submodule {
              options = {
                service = nullableOption (lib.types.enum [
                  "music"
                  "classical"
                ]) "The service Sidra opens at launch.";
                musicStartPage = nullableOption (lib.types.enum [
                  "home"
                  "new"
                  "radio"
                  "all-playlists"
                  "last"
                ]) "The Apple Music start page.";
                classicalStartPage = nullableOption (lib.types.enum [
                  "home"
                  "browse"
                  "playlists"
                  "search"
                  "last"
                ]) "The Apple Music Classical start page.";
                zoomFactor = nullableOption (lib.types.enum [
                  1.0
                  1.25
                  1.5
                  1.75
                  2.0
                ]) "The player zoom level.";
              };
            };
          };

          notifications = lib.mkOption {
            default = { };
            description = "Desktop notification preferences.";
            type = lib.types.submodule {
              options.enable = nullableOption lib.types.bool "Whether Sidra shows track notifications.";
            };
          };

          discord = lib.mkOption {
            default = { };
            description = "Discord integration preferences.";
            type = lib.types.submodule {
              options.richPresence = lib.mkOption {
                default = { };
                description = "Discord Rich Presence preferences.";
                type = lib.types.submodule {
                  options.enable = nullableOption lib.types.bool "Whether Sidra publishes the current track to Discord.";
                };
              };
            };
          };

          closeToTray = lib.mkOption {
            default = { };
            description = "Window close behavior.";
            type = lib.types.submodule {
              options.enable = nullableOption lib.types.bool "Whether closing Sidra hides it in the system tray.";
            };
          };

          autoUpdate = lib.mkOption {
            default = { };
            description = "Application update preferences.";
            type = lib.types.submodule {
              options.enable = nullableOption lib.types.bool "Whether Sidra checks for updates.";
            };
          };
        };
      };
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = lib.optional (cfg.package != null) cfg.package;

    home.file = lib.mkIf pkgs.stdenv.hostPlatform.isDarwin (
      lib.optionalAttrs (cfg.customTheme != null) {
        "Library/Application Support/Sidra/custom-theme.json" = {
          source = themeSource;
          force = false;
        };
      }
      // {
        "Library/Application Support/Sidra/managed-settings.json" = {
          source = settingsSource;
          force = true;
        };
      }
    );

    xdg.configFile = lib.mkIf (!pkgs.stdenv.hostPlatform.isDarwin) (
      lib.optionalAttrs (cfg.customTheme != null) {
        "Sidra/custom-theme.json" = {
          source = themeSource;
          force = false;
        };
      }
      // {
        "Sidra/managed-settings.json" = {
          source = settingsSource;
          force = true;
        };
      }
    );
  };
}
