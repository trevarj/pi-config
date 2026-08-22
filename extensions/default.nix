{
  callPackage,
  esbuild,
  lib,
}:

# The pinned set of pi coding agent extensions. pi can install packages itself
# with `pi install`, but that resolves npm at runtime with whatever version is
# current that day; every extension runs with full user permissions, so the
# version that lands has to be a reviewable diff instead. package-lock.json is
# that diff: renovate bumps it, and npmDepsHash below makes the build fail if
# the fetched tree ever stops matching it.
#
# Kept apart from ../agent deliberately: a merged lockfile dedupes almost
# nothing (pi's shrinkwrap pins its own nested copies anyway) and would put a
# core release and an extension bump in the same diff.
callPackage ../npm-bundle.nix { } {
  pname = "pi-extensions";
  version = "1.0.0";
  root = ./.;

  npmDepsHash = "sha256-Q+eaNCMWCb0GSNcxYEzMj0Vy27H5jAvo9RR6S7e899w=";

  extraAttrs = {
    # Every extension declares the pi core as a peer dependency. The installed
    # agent supplies it at runtime, so resolving our own copy would both double
    # the closure and let the extensions run against a different pi than the one
    # loading them.
    npmFlags = [
      "--legacy-peer-deps"
      "--omit=dev"
    ];

    # pi-memory notifies on session_start when qmd (its optional search backend)
    # is absent. qmd isn't in nixpkgs and core memory works without it, so just
    # silence the notice instead of packaging qmd. Drops the single notify
    # call; the leftover empty `if (ctx.hasUI) {}` is valid TS and harmless.
    nativeBuildInputs = [ esbuild ];

    postInstall = ''
      sed -i '/ctx\.ui\.notify(qmdInstallInstructions()/d' \
        $out/lib/node_modules/pi-memory/index.ts

      # ponytail: keep this exact one-line divergence until pi-telegram gains
      # operator-confirmed pairing upstream. A changed release fails the build
      # instead of silently restoring first-contact ownership.
      substituteInPlace \
        $out/lib/node_modules/@llblab/pi-telegram/lib/config.ts \
        --replace-fail 'return { kind: "pair", userId };' \
        'return { kind: "deny" };'

      mkdir -p $out/lib/node_modules/@trevarj
      cp -r ${./pi-usage} $out/lib/node_modules/@trevarj/pi-usage
      chmod -R u+w $out/lib/node_modules/@trevarj/pi-usage
      cd $out/lib/node_modules/@trevarj/pi-usage
      rm -rf dist
      esbuild src/index.ts \
        --bundle \
        --format=esm \
        --platform=node \
        --target=es2022 \
        --packages=external \
        --outdir=dist \
        --out-extension:.js=.ts \
        --sourcemap
    '';

    meta = {
      description = "Pinned pi coding agent extensions resolved by nix instead of `pi install`";
      homepage = "https://pi.dev/packages";
      license = lib.licenses.mit;
      platforms = lib.platforms.all;
    };
  };
}
