{
  callPackage,
  fd,
  lib,
  makeBinaryWrapper,
  nodejs,
  ripgrep,
}:

# nixpkgs carries pi-coding-agent, but it lags the fast-moving extension
# ecosystem (0.75.4 against 0.84.3 here) and its build-from-git approach no
# longer works: since 0.8x the provider model catalog is generated into
# src/providers/data by a script that fetches every provider's model list, so a
# checkout of the tag cannot be compiled offline.
#
# The published npm tarball ships that catalog inside a prebuilt dist, along
# with an npm-shrinkwrap.json pinning its whole dependency tree, so installing
# the release is both reproducible and current. package-lock.json here is the
# reviewable record of what that resolves to.
#
# Regenerating that lockfile takes two steps, because pi's shrinkwrap omits the
# integrity field for its own sibling packages and fetchNpmDeps refuses a
# lockfile without one:
#
#   npm install --package-lock-only --omit=dev
#   for p in pi-agent-core pi-ai pi-client pi-protocol pi-telemetry pi-tui; do
#     ... set .packages[<nested path>].integrity from the registry's
#         dist.integrity for that version ...
#   done
#
# The build fails loudly rather than silently skipping a dependency if that
# second step is forgotten.

let
  version = "0.84.3";
in
callPackage ../npm-bundle.nix { } {
  pname = "pi-coding-agent";
  inherit version;
  root = ./.;

  npmDepsHash = "sha256-smUf/DUYANv7iR6r2uhhO1JQ1fKjG2Z+J4q6MI4AMfw=";

  extraAttrs = {
    npmDepsFetcherVersion = 2;
    npmFlags = [ "--omit=dev" ];

    nativeBuildInputs = [ makeBinaryWrapper ];

    postInstall = ''
      # Let an extension named "fork" replace Pi's exact /fork command. Commands
      # with arguments already bypass this built-in branch upstream.
      substituteInPlace \
        "$out/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js" \
        --replace-fail 'if (text === "/fork") {' \
        'if (text === "/fork" && !this.isExtensionCommand(text)) {'

      makeWrapper ${lib.getExe nodejs} "$out/bin/pi" \
        --add-flags "$out/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js" \
        --prefix PATH : ${
          lib.makeBinPath [
            fd
            ripgrep
          ]
        }
    '';

    # pi writes to $HOME on startup, so the check needs a writable one.
    doInstallCheck = true;
    installCheckPhase = ''
      runHook preInstallCheck

      export HOME="$(mktemp -d)"
      actual="$("$out/bin/pi" --version)"
      if [ "$actual" != "${version}" ]; then
        echo "pi --version reported '$actual', expected '${version}'" >&2
        exit 1
      fi
      grep -Fq 'if (text === "/fork" && !this.isExtensionCommand(text)) {' \
        "$out/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js"

      runHook postInstallCheck
    '';

    meta = {
      description = "Coding agent CLI with read, bash, edit, write tools and session management";
      homepage = "https://pi.dev/";
      downloadPage = "https://www.npmjs.com/package/@earendil-works/pi-coding-agent";
      changelog = "https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md";
      license = lib.licenses.mit;
      mainProgram = "pi";
      platforms = lib.platforms.unix;
    };
  };
}
