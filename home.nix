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
  # pi-tui-kit is a library; pi-subagents is loaded through subagents-ui below.
  # Both remain available from the pinned module root.
  piPackages = map (name: "${piExtensions}/lib/node_modules/${name}") (
    builtins.filter (
      name: name != "@narumitw/pi-tui-kit" && name != "@narumitw/pi-subagents"
    ) extensionNames
  );
  piUsage = "${piExtensions}/lib/node_modules/@trevarj/pi-usage";
  trevPi = ./extensions/trev-pi;
  workMode = ./extensions/work-mode.ts;
  organizer = "${piExtensions}/lib/node_modules/@trevarj/organizer";
  subagentsUi = "${piExtensions}/lib/node_modules/@trevarj/subagents-ui";
  organizerLauncher = pkgs.writeShellApplication {
    name = "pi-organizer";
    text = ''
      pi_path="$(command -v pi)" || {
        echo "pi not found on caller PATH" >&2
        exit 127
      }
      ${pkgs.coreutils}/bin/install -d -m700 "$HOME/Workspace/.pi-organizer"
      cd "$HOME/Workspace/.pi-organizer"
      exec "$pi_path" --continue --name organizer \
        --model openai-codex/gpt-5.6-luna --thinking high
    '';
  };
  feedbackPrompts = ./config/prompts;
  settingsBase = builtins.fromJSON (builtins.readFile (agents + "/.pi/agent/settings.base.json"));
  webSearchBase = builtins.fromJSON (builtins.readFile (agents + "/.pi/web-search.json"));
  planModeSettings = pkgs.writeText "pi-plan-mode.json" (
    builtins.toJSON {
      thinkingLevel = "xhigh";
      defaultPlanTools = [
        "read"
        "bash"
        "grep"
        "find"
        "ls"
        "web_search"
        "fetch_content"
      ];
    }
  );
  goalSettings = pkgs.writeText "pi-goal.json" (
    builtins.toJSON {
      rpc.enabled = false;
      continuationLimits = {
        automaticTurns = 25;
        noProgressTurns = 3;
      };
    }
  );
  # Remove only exact generated predecessors; customized files survive.
  legacySubagentsSettings = pkgs.writeText "pi-subagents.json" ''
    {
      "backgroundByDefault": true,
      "fallbackSubagent": "none",
      "maxConcurrent": 4,
      "maxConcurrentForeground": 1,
      "maxSubagentDepth": 1,
      "schedulingEnabled": false,
      "workflowsEnabled": false
    }
  '';
  legacyWorkflowSettings = pkgs.writeText "pi-workflow.json" (
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
          ./extensions/agentwire.ts
          ./extensions/herdr-fork.ts
          ./extensions/magit-diff.ts
          ./extensions/ollama-autostart.ts
          organizer
          subagentsUi
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

in
{
  home = {
    packages = [ organizerLauncher ];
    file = {
      ".pi/agent/AGENTS.md".source = agents + "/.codex/AGENTS.md";
      ".pi/agent/APPEND_SYSTEM.md".source = agents + "/.pi/agent/APPEND_SYSTEM.md";
      ".pi/agent/models.json".source = ./config/models.json;
      # Emacs-style bindings: prompt history on C-p/C-n (explicit history
      # bindings override model cycling in the editor) and C-h as backspace;
      # the rest of the Emacs set is already the default.
      ".pi/agent/keybindings.json".text = builtins.toJSON {
        "tui.editor.historyPrevious" = "ctrl+p";
        "tui.editor.historyNext" = "ctrl+n";
        "tui.editor.cursorLeft" = [
          "left"
          "ctrl+b"
        ];
        "tui.editor.cursorRight" = [
          "right"
          "ctrl+f"
        ];
        "tui.editor.cursorWordLeft" = [
          "alt+left"
          "alt+b"
        ];
        "tui.editor.cursorWordRight" = [
          "alt+right"
          "alt+f"
        ];
        "tui.editor.deleteCharForward" = [
          "delete"
          "ctrl+d"
        ];
        "tui.editor.deleteCharBackward" = [
          "backspace"
          "ctrl+h"
        ];
        "tui.input.newLine" = [
          "shift+enter"
          "ctrl+j"
        ];
      };
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
      if [[ -f "$workflow_path" && ! -L "$workflow_path" ]] && \
        ${pkgs.diffutils}/bin/cmp -s ${legacyWorkflowSettings} "$workflow_path"; then
        run ${pkgs.coreutils}/bin/rm "$workflow_path"
      fi

      subagents_path="$HOME/.pi/agent/subagents.json"
      if [[ -f "$subagents_path" && ! -L "$subagents_path" ]] && \
        ${pkgs.diffutils}/bin/cmp -s ${legacySubagentsSettings} "$subagents_path"; then
        run ${pkgs.coreutils}/bin/rm "$subagents_path"
      fi

      plan_path="$HOME/.pi/agent/pi-plan-mode.json"
      if [[ ! -e "$plan_path" && ! -L "$plan_path" ]]; then
        run ${pkgs.coreutils}/bin/install -Dm600 ${planModeSettings} "$plan_path"
      fi

      goal_path="$HOME/.pi/agent/pi-goal.json"
      if [[ ! -e "$goal_path" && ! -L "$goal_path" ]]; then
        run ${pkgs.coreutils}/bin/install -Dm600 ${goalSettings} "$goal_path"
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
