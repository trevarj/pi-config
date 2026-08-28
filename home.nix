{
  dotfilesConfigs,
  extensionNames,
  piExtensions,
}:
{
  herdrPiExtension ? null,
  includeOptionalApps ? true,
  lib,
  pkgs,
  ...
}:

let
  agents = dotfilesConfigs + "/agents";
  # pi-lens is disabled by default: still built and pinned, but left out of
  # the session package list. Re-enable by removing the filter, or ad hoc with
  # `pi --extension <pi-extensions>/lib/node_modules/pi-lens`.
  piPackages = map (name: "${piExtensions}/lib/node_modules/${name}") (
    builtins.filter (name: name != "pi-lens") extensionNames
  );
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
          ./extensions/agentwire.ts
          ./extensions/herdr-fork.ts
          ./extensions/herdr-waiting.ts
          ./extensions/magit-diff.ts
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

in
{
  home = {
    file = {
      ".pi-lens/config.json".text = builtins.toJSON {
        ui.compactToolLine = true;
        widget.visible = false;
      };
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
    }
    // lib.optionalAttrs (herdrPiExtension != null) {
      # Release-matched Herdr lifecycle/session reporter. Keep this in the
      # auto-discovered path so `herdr integration status` sees it too.
      ".pi/agent/extensions/herdr-agent-state.ts".source = herdrPiExtension;
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
