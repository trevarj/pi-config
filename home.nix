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
  piUsage = "${piExtensions}/lib/node_modules/@trevarj/pi-usage";
  trevPi = ./extensions/trev-pi;
  workMode = ./extensions/work-mode.ts;
  feedbackPrompts = ./config/prompts;
  settingsBase = builtins.fromJSON (builtins.readFile (agents + "/.pi/agent/settings.base.json"));
  webSearchBase = builtins.fromJSON (builtins.readFile (agents + "/.pi/web-search.json"));
  workflowSettings = pkgs.writeText "pi-workflow.json" (
    builtins.toJSON {
      workflow.planHandoff = "review";
      plan = {
        thinkingLevel = "xhigh";
        defaultPlanTools = [
          "read"
          "bash"
          "grep"
          "find"
          "ls"
          "web_search"
          "fetch_content"
          "lens_diagnostics"
          "lsp_diagnostics"
          "symbol_search"
          "module_report"
          "read_symbol"
          "read_enclosing"
        ];
      };
      goal = {
        toolVisibility = "after-first-goal";
        experimental.goals = false;
        rpc.enabled = false;
        continuationLimits = {
          automaticTurns = 25;
          noProgressTurns = 3;
        };
      };
    }
  );

  settings = pkgs.writeText "pi-settings.json" (
    builtins.toJSON (
      settingsBase
      // {
        packages = piPackages ++ [ piUsage ];
        extensions = (settingsBase.extensions or [ ]) ++ [
          ./extensions/ollama-autostart.ts
          trevPi
          workMode
        ];
        prompts = (settingsBase.prompts or [ ]) ++ [ feedbackPrompts ];
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
      ".pi-lens/config.json".text = builtins.toJSON { widget.visible = false; };
      ".pi/agent/AGENTS.md".source = agents + "/.codex/AGENTS.md";
      ".pi/agent/APPEND_SYSTEM.md".source = agents + "/.pi/agent/APPEND_SYSTEM.md";
      ".pi/agent/models.json".source = ./config/models.json;
      ".pi/agent/prompts".source = agents + "/.pi/agent/prompts";
    };

    # Pi rewrites settings.json in place, so install a writable generated copy.
    activation.piSettings = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      run ${pkgs.coreutils}/bin/install -Dm600 \
        ${settings} "$HOME/.pi/agent/settings.json"

      workflow_path="$HOME/.pi/agent/pi-workflow.json"
      if [[ ! -e "$workflow_path" && ! -L "$workflow_path" ]]; then
        run ${pkgs.coreutils}/bin/install -Dm600 ${workflowSettings} "$workflow_path"
      fi
    '';
  };

  xdg.configFile."pi/web-search.json".source = webSearch;
}
