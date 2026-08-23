{
  dotfilesConfigs,
  extensionNames,
  piExtensions,
}:
{
  includeOptionalApps ? true,
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
        compaction = {
          enabled = true;
          reserveTokens = 100000;
          keepRecentTokens = 20000;
        };
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
        firecrawlApiKey = "!${pkgs.coreutils}/bin/cat \"$HOME/.pi/agent/secrets/firecrawl-api-key\"";
        firecrawlBaseUrl = "https://api.firecrawl.dev";
        searchRouting = {
          providers = [
            "firecrawl"
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

  piSandboxCheck = pkgs.writeShellApplication {
    name = "pi-sandbox-check";
    runtimeInputs = with pkgs; [
      coreutils
      gh
      git
      gnupg
      openssh
    ];
    text = builtins.readFile ./scripts/pi-sandbox-check.sh;
  };

  piSandbox = pkgs.writeShellApplication {
    name = "pi";
    runtimeInputs = with pkgs; [
      coreutils
      gawk
      gh
      git
      gnupg
      jq
      openssh
      systemd
    ];
    text =
      builtins.replaceStrings
        [ "@pi@" "@check@" "@env@" "@bash@" ]
        [
          (lib.getExe pkgs.pi-coding-agent)
          (lib.getExe piSandboxCheck)
          (lib.getExe' pkgs.coreutils "env")
          (lib.getExe pkgs.bash)
        ]
        (builtins.readFile ./scripts/pi-sandbox.sh);
  };
in
{
  home = {
    packages = lib.optionals includeOptionalApps [ piSandbox ];

    file = {
      ".pi-lens/config.json".text = builtins.toJSON {
        ui.compactToolLine = true;
        widget.visible = false;
      };
      ".pi/agent/AGENTS.md".source = agents + "/.codex/AGENTS.md";
      ".pi/agent/APPEND_SYSTEM.md".source = agents + "/.pi/agent/APPEND_SYSTEM.md";
      ".pi/agent/models.json".source = ./config/models.json;
      ".pi/agent/prompts".source = agents + "/.pi/agent/prompts";
    };

    # Pi rewrites settings.json in place, so install a writable generated copy.
    activation.piSettings = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      ${lib.optionalString includeOptionalApps ''
        run ${pkgs.coreutils}/bin/install -d -m700 "$HOME/.ollama"
      ''}
      run ${pkgs.coreutils}/bin/install -Dm600 \
        ${settings} "$HOME/.pi/agent/settings.json"

      workflow_path="$HOME/.pi/agent/pi-workflow.json"
      if [[ ! -e "$workflow_path" && ! -L "$workflow_path" ]]; then
        run ${pkgs.coreutils}/bin/install -Dm600 ${workflowSettings} "$workflow_path"
      fi
    '';
  };

  services.ollama = lib.mkIf includeOptionalApps {
    enable = true;
    host = "127.0.0.1";
  };

  systemd.user.services.ollama.Service = lib.mkIf includeOptionalApps {
    LockPersonality = true;
    NoNewPrivileges = true;
    BindPaths = [ "%h/.ollama" ];
    PrivateTmp = true;
    ProtectControlGroups = true;
    ProtectHome = "tmpfs";
    ProtectKernelModules = true;
    ProtectKernelTunables = true;
    ProtectSystem = "strict";
    ReadWritePaths = [ "%h/.ollama" ];
    Restart = "on-failure";
    RestartSec = 3;
    RestrictAddressFamilies = [
      "AF_UNIX"
      "AF_INET"
      "AF_INET6"
    ];
    RestrictNamespaces = true;
    RestrictSUIDSGID = true;
  };

  xdg.configFile."pi/web-search.json".source = webSearch;
}
