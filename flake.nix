{
  description = "Trevor's pinned Pi agent, extensions, and UI configuration";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    dotfiles = {
      url = "github:trevarj/dotfiles";
      flake = false;
    };
  };

  outputs =
    {
      self,
      dotfiles,
      nixpkgs,
    }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
      piAgent = pkgs.callPackage ./agent { };
      piExtensions = pkgs.callPackage ./extensions { };
      extensionNames = builtins.attrNames (builtins.fromJSON (
        builtins.readFile ./extensions/package.json
      )).dependencies;
      dotfilesConfigs = builtins.path {
        name = "trev-dotfiles-configs";
        path = dotfiles;
        filter =
          path: _type:
          let
            rel = nixpkgs.lib.removePrefix "${dotfiles}/" path;
          in
          rel != "fonts" && !(nixpkgs.lib.hasPrefix "fonts/" rel);
      };
    in
    {
      overlays.default = final: _prev: {
        pi-coding-agent = final.callPackage ./agent { };
        pi-extensions = final.callPackage ./extensions { };
      };

      packages.${system} = {
        pi-coding-agent = piAgent;
        pi-extensions = piExtensions;
        default = piAgent;
      };

      checks.${system} = {
        inherit (self.packages.${system}) pi-coding-agent pi-extensions;

        extension-tests =
          pkgs.runCommand "pi-extension-tests"
            {
              nativeBuildInputs = [
                pkgs.esbuild
                pkgs.nodejs
              ];
            }
            ''
              node --experimental-strip-types --test \
                ${./extensions}/agentwire.test.ts \
                ${./extensions}/herdr-waiting.test.ts \
                ${./extensions}/magit-diff.test.ts \
                ${./extensions}/ollama-autostart.test.ts \
                ${./extensions}/work-mode.test.ts \
                ${./extensions/pi-usage}/test/claude.test.ts \
                ${./extensions/trev-pi}/layout.test.ts
              cat >telegram-fail-closed.test.ts <<'EOF'
              import assert from "node:assert/strict";
              import { getTelegramAuthorizationState } from "${piExtensions}/lib/node_modules/@llblab/pi-telegram/lib/config.ts";

              assert.deepEqual(getTelegramAuthorizationState(123), { kind: "deny" });
              assert.deepEqual(getTelegramAuthorizationState(123, 123), { kind: "allow" });
              assert.deepEqual(getTelegramAuthorizationState(456, 123), { kind: "deny" });
              EOF
              esbuild telegram-fail-closed.test.ts \
                --bundle \
                --format=esm \
                --platform=node \
                --outfile=telegram-fail-closed.test.mjs
              node telegram-fail-closed.test.mjs
              touch "$out"
            '';

        runtime-smoke = pkgs.runCommand "pi-runtime-smoke" { } ''
          export HOME="$(mktemp -d)"
          ${piAgent}/bin/pi \
            --extension ${./extensions}/herdr-waiting.ts \
            --extension ${./extensions}/magit-diff.ts \
            --extension ${./extensions}/ollama-autostart.ts \
            --extension ${./extensions/trev-pi} \
            --extension ${./extensions}/work-mode.ts \
            --theme ${./extensions/trev-pi}/trev-pi.json \
            --use-theme trev-pi \
            --list-models >/dev/null
          touch "$out"
        '';

        formatting =
          pkgs.runCommand "pi-config-formatting"
            {
              nativeBuildInputs = [ pkgs.nixfmt ];
            }
            ''
              find ${self} -name '*.nix' -print0 | xargs -0 --no-run-if-empty nixfmt --check
              touch "$out"
            '';

        lint =
          pkgs.runCommand "pi-config-lint"
            {
              nativeBuildInputs = [
                pkgs.deadnix
                pkgs.statix
              ];
            }
            ''
              statix check ${self}
              deadnix --fail ${self}
              touch "$out"
            '';
      };

      homeModules.default = import ./home.nix {
        inherit
          dotfilesConfigs
          extensionNames
          piExtensions
          ;
      };

      formatter.${system} = pkgs.nixfmt-tree;

      devShells.${system}.default = pkgs.mkShell {
        packages = with pkgs; [
          deadnix
          git
          nixfmt
          nodejs
          shellcheck
          statix
        ];
      };
    };
}
