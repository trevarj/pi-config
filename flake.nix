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
                pkgs.typescript
              ];
            }
            ''
              mkdir -p test-root/node_modules/@earendil-works
              ln -s ${piAgent}/lib/node_modules/@earendil-works/pi-coding-agent \
                test-root/node_modules/@earendil-works/pi-coding-agent
              for package in pi-agent-core pi-ai pi-client pi-protocol pi-telemetry pi-tui; do
                ln -s ${piAgent}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/$package \
                  test-root/node_modules/@earendil-works/$package
              done
              ln -s ${piAgent}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@types \
                test-root/node_modules/@types
              cp -r ${piExtensions}/lib/node_modules/@narumitw \
                test-root/node_modules/@narumitw
              ln -s ${piExtensions}/lib/node_modules/@trevarj \
                test-root/node_modules/@trevarj
              mkdir -p test-root/packages
              cp -r ${piExtensions}/lib/node_modules/@trevarj/trev-pi \
                test-root/packages/trev-pi
              cp -r ${piExtensions}/lib/node_modules/@trevarj/subagents-ui \
                test-root/packages/subagents-ui

              node --experimental-strip-types --test \
                ${./extensions}/agentwire.test.ts \
                ${./extensions}/herdr-fork.test.ts \
                ${./extensions}/magit-diff.test.ts \
                ${./extensions}/ollama-autostart.test.ts \
                ${./extensions/organizer}/core.test.ts \
                ${./extensions/organizer}/index.test.ts \
                ${./extensions/pi-usage}/test/claude.test.ts
              for test_file in \
                test-root/packages/subagents-ui/render.test.ts \
                test-root/packages/trev-pi/layout.test.ts \
                test-root/packages/trev-pi/menu.test.ts \
                test-root/packages/trev-pi/mode.test.ts; do
                output="test-root/$(basename "$test_file" .ts).mjs"
                esbuild "$test_file" \
                  --bundle \
                  --format=esm \
                  --packages=external \
                  --platform=node \
                  --outfile="$output"
                node --test "$output"
              done
              tsc -p test-root/packages/trev-pi/tsconfig.json
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
          for mode in regular fullscreen; do
            ${piAgent}/bin/pi \
              --extension ${piExtensions}/lib/node_modules/@narumitw/pi-plan-mode \
              --extension ${piExtensions}/lib/node_modules/@narumitw/pi-goal \
              --extension ${piExtensions}/lib/node_modules/@narumitw/pi-herdr \
              --extension ${piExtensions}/lib/node_modules/@narumitw/pi-stamp \
              --extension ${piExtensions}/lib/node_modules/@trevarj/subagents-ui \
              --extension ${./extensions}/herdr-fork.ts \
              --extension ${./extensions}/magit-diff.ts \
              --extension ${./extensions}/ollama-autostart.ts \
              --extension ${piExtensions}/lib/node_modules/@trevarj/organizer \
              --extension ${piExtensions}/lib/node_modules/@trevarj/trev-pi \
              --theme ${piExtensions}/lib/node_modules/@trevarj/trev-pi/trev-pi.json \
              --use-theme trev-pi \
              --tui-mode "$mode" \
              --list-models >/dev/null
          done
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
          typescript
        ];
      };
    };
}
