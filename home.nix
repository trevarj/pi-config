{
  dotfilesConfigs,
  extensionNames,
  piExtensions,
}:
{
  lib,
  pkgs,
  ...
}:

let
  agents = dotfilesConfigs + "/agents";
  piPackages = map (name: "${piExtensions}/lib/node_modules/${name}") extensionNames;
  settingsBase = builtins.fromJSON (builtins.readFile (agents + "/.pi/agent/settings.base.json"));
  webSearchBase = builtins.fromJSON (builtins.readFile (agents + "/.pi/web-search.json"));
  trevPi = ./extensions/trev-pi;

  settings = pkgs.writeText "pi-settings.json" (
    builtins.toJSON (
      settingsBase
      // {
        packages = piPackages;
        extensions = (settingsBase.extensions or [ ]) ++ [
          ./extensions/ollama-autostart.ts
          trevPi
        ];
        themes = (settingsBase.themes or [ ]) ++ [ "${trevPi}/trev-pi.json" ];
        theme = "trev-pi";
      }
    )
  );

  webSearch = pkgs.writeText "pi-web-search.json" (
    builtins.toJSON (
      webSearchBase
      // {
        searchRouting = {
          providers = [
            "brave"
            "exa"
          ];
          fallbackOn = [
            "transient"
            "quota"
            "network"
            "invalid-response"
          ];
        };
        summaryModel = "ollama/glm-5.2:cloud";
      }
    )
  );
in
{
  home = {
    file = {
      ".pi/agent/AGENTS.md".source = agents + "/.codex/AGENTS.md";
      ".pi/agent/APPEND_SYSTEM.md".source = agents + "/.pi/agent/APPEND_SYSTEM.md";
      ".pi/agent/models.json".source = ./config/models.json;
      ".pi/agent/prompts".source = agents + "/.pi/agent/prompts";
    };

    # Pi rewrites settings.json in place, so install a writable generated copy.
    activation.piSettings = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      run ${pkgs.coreutils}/bin/install -Dm600 \
        ${settings} "$HOME/.pi/agent/settings.json"
    '';
  };

  xdg.configFile."pi/web-search.json".source = webSearch;
}
