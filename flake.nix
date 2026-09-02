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
              mkdir -p test-root/node_modules/@earendil-works test-root/packages
              ln -s ${piAgent}/lib/node_modules/@earendil-works/pi-coding-agent \
                test-root/node_modules/@earendil-works/pi-coding-agent
              for package in pi-agent-core pi-ai pi-client pi-protocol pi-telemetry pi-tui; do
                ln -s ${piAgent}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/$package \
                  test-root/node_modules/@earendil-works/$package
              done
              ln -s ${piAgent}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@types \
                test-root/node_modules/@types
              ln -s ${piAgent}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/typebox \
                test-root/node_modules/typebox
              cp -r ${piExtensions}/lib/node_modules/@trevarj/pi-agents \
                test-root/packages/pi-agents
              cp -r ${piExtensions}/lib/node_modules/@trevarj/pi-zentui \
                test-root/packages/pi-zentui

              node --experimental-strip-types --test \
                ${./extensions}/agentwire.test.ts \
                ${./extensions}/herdr-fork.test.ts \
                ${./extensions}/magit-diff.test.ts \
                ${./extensions}/ollama-autostart.test.ts \
                ${./extensions/organizer}/core.test.ts \
                ${./extensions/organizer}/index.test.ts \
                ${./extensions}/work-mode.test.ts \
                ${./extensions/pi-usage}/test/claude.test.ts \
                test-root/packages/pi-agents/test/*.test.ts

              echo "typechecking local Pi agents"
              (
                cd test-root/packages/pi-agents
                tsc --noEmit \
                  --target ESNext \
                  --module ESNext \
                  --moduleResolution bundler \
                  --strict \
                  --skipLibCheck \
                  --esModuleInterop \
                  --resolveJsonModule \
                  --isolatedModules \
                  --allowImportingTsExtensions \
                  --types node \
                  *.ts test/*.ts
              )

              echo "validating Zentui against Pi ${piAgent.version}"
              test "${piAgent.version}" = "0.84.4"
              (
                cd test-root/packages/pi-zentui
                tsc --noEmit \
                  --target ESNext \
                  --module ESNext \
                  --moduleResolution bundler \
                  --strict \
                  --skipLibCheck \
                  --esModuleInterop \
                  --resolveJsonModule \
                  --isolatedModules \
                  --allowImportingTsExtensions \
                  --types node \
                  extensions/zentui/*.ts
              )
              echo "validating Zentui package metadata"
              node <<'EOF'
              const assert = require("node:assert/strict");
              const fs = require("node:fs");
              const manifest = JSON.parse(fs.readFileSync("test-root/packages/pi-zentui/package.json", "utf8"));
              assert.equal(manifest.name, "@trevarj/pi-zentui");
              assert.equal(manifest.version, "0.22.0");
              assert.equal(manifest.private, true);
              assert.equal(manifest.upstream.package, "pi-zentui");
              assert.equal(manifest.upstream.version, "0.22.0");
              assert.equal(manifest.upstream.repository, "https://github.com/lmilojevicc/pi-zentui");
              assert.equal(manifest.upstream.commit, "5ed286e8877b1b79e0a3d7fadbfe508b78684c32");
              assert.equal(manifest.upstream.sourceSha256, "25ea8a11217a69bacff229297a31aa9ae73c071547da838d52392705d45590f9");
              assert.equal(manifest.fork.sourceSha256, "4eeea4723dd58d24e9cd30caaab50f16c6a6cccc11accf74651006130cae3d39");
              assert.deepEqual(manifest.fork.changes, [
                "use the Powerline branch glyph U+E0A0 for broader font compatibility",
              ]);
              assert.deepEqual(manifest.pi.extensions, ["./extensions"]);
              assert.equal(manifest.dependencies, undefined);
              assert.equal(manifest.optionalDependencies, undefined);
              assert.equal(manifest.bundledDependencies, undefined);
              EOF
              echo "validated Zentui package metadata"
              source_hash="$(
                cd test-root/packages/pi-zentui
                LC_ALL=C find LICENSE README.md docs extensions -type f -print0 \
                  | LC_ALL=C sort -z \
                  | xargs -0 sha256sum \
                  | sha256sum \
                  | cut -d' ' -f1
              )"
              echo "Zentui source hash: $source_hash"
              test "$source_hash" = "4eeea4723dd58d24e9cd30caaab50f16c6a6cccc11accf74651006130cae3d39"
              touch "$out"
            '';

        runtime-smoke = pkgs.runCommand "pi-runtime-smoke" { } ''
          export HOME="$(mktemp -d)"
          runtime_extensions=(
            ${nixpkgs.lib.concatMapStringsSep "\n            " (
              name: "${piExtensions}/lib/node_modules/${name}"
            ) (builtins.filter (name: name != "@narumitw/pi-tui-kit") extensionNames)}
            ${piExtensions}/lib/node_modules/@trevarj/pi-agents
            ${piExtensions}/lib/node_modules/@trevarj/pi-usage
            ${piExtensions}/lib/node_modules/@trevarj/pi-zentui
            ${./extensions}/agentwire.ts
            ${./extensions}/herdr-fork.ts
            ${./extensions}/magit-diff.ts
            ${./extensions}/ollama-autostart.ts
            ${piExtensions}/lib/node_modules/@trevarj/organizer
            ${./extensions}/work-mode.ts
          )
          test -d ${piExtensions}/lib/node_modules/@trevarj/pi-agents
          test ! -e ${piExtensions}/lib/node_modules/@narumitw/pi-subagents
          extension_args=()
          for extension in "''${runtime_extensions[@]}"; do
            extension_args+=(--extension "$extension")
          done
          for mode in regular fullscreen; do
            ${piAgent}/bin/pi \
              "''${extension_args[@]}" \
              --tui-mode "$mode" \
              --list-models >/dev/null
          done

          echo "smoking child RPC extension without a provider call"
          PI_BIN=${piAgent}/bin/pi \
          PI_AGENTS_PATH=${piExtensions}/lib/node_modules/@trevarj/pi-agents \
          ${pkgs.nodejs}/bin/node <<'EOF'
          const { spawn } = require("node:child_process");
          const child = spawn(process.env.PI_BIN, [
            "--mode", "rpc", "--no-session", "--no-extensions",
            "--extension", process.env.PI_AGENTS_PATH,
          ], {
            env: {
              ...process.env,
              PI_AGENTS_ROLE: "child",
              PI_AGENTS_AGENT_ID: "smoke",
              PI_AGENTS_TASK_ID: "smoke",
              PI_AGENTS_IPC_FD: "3",
              PI_OFFLINE: "1",
            },
            stdio: ["pipe", "pipe", "pipe", "pipe"],
          });
          let buffer = "";
          let stderr = "";
          const timeout = setTimeout(() => {
            child.kill("SIGKILL");
            throw new Error(`child RPC smoke timed out: ''${stderr}`);
          }, 15_000);
          child.stderr.on("data", (chunk) => { stderr += chunk; });
          child.stdout.on("data", (chunk) => {
            buffer += chunk;
            for (;;) {
              const newline = buffer.indexOf("\n");
              if (newline < 0) break;
              const line = buffer.slice(0, newline);
              buffer = buffer.slice(newline + 1);
              if (!line) continue;
              const frame = JSON.parse(line);
              if (frame.type === "extension_error") throw new Error(frame.error || "pi-agents child extension failed");
              if (frame.id === "smoke-state") {
                if (!frame.success) throw new Error(frame.error || "child RPC state smoke failed");
                child.stdin.write(JSON.stringify({ id: "smoke-commands", type: "get_commands" }) + "\n");
                continue;
              }
              if (frame.id !== "smoke-commands") continue;
              if (!frame.success) throw new Error(frame.error || "child RPC command smoke failed");
              const commands = frame.data?.commands ?? [];
              if (!commands.some((command) => command.name === "pi-agents-child-status")) {
                throw new Error(`pi-agents child command missing: ''${JSON.stringify(commands)}`);
              }
              clearTimeout(timeout);
              child.kill("SIGTERM");
            }
          });
          child.on("spawn", () => {
            child.stdin.write(JSON.stringify({ id: "smoke-state", type: "get_state" }) + "\n");
          });
          child.on("close", (code, signal) => {
            clearTimeout(timeout);
            if (code !== 0 && code !== 143 && signal !== "SIGTERM") {
              throw new Error(`child RPC smoke exited ''${code ?? signal}: ''${stderr}`);
            }
          });
          EOF
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
