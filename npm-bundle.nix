{
  lib,
  buildNpmPackage,
}:

# The shape both pi trees share: an npm manifest plus a committed lockfile,
# resolved offline and installed as a plain node_modules tree. Nothing is
# compiled - pi ships a prebuilt dist and the extensions are TypeScript that pi
# loads itself - and no install scripts run, matching upstream's own
# --ignore-scripts advice.
#
# Callers add what is specific to them through `extraAttrs`; the install phase
# runs the standard hooks, so a `postInstall` there lands in the right place.
{
  pname,
  version,
  root,
  npmDepsHash,
  extraAttrs ? { },
}:

buildNpmPackage (
  {
    inherit pname version npmDepsHash;

    # Manifest and lockfile only; the code comes from the registry.
    src = lib.fileset.toSource {
      inherit root;
      fileset = lib.fileset.unions [
        (root + "/package.json")
        (root + "/package-lock.json")
      ];
    };

    dontNpmBuild = true;
    npmRebuildFlags = [ "--ignore-scripts" ];

    # pi resolves both trees by absolute path, so the whole output is the
    # hoisted node_modules: node walks up from any entry point to
    # $out/lib/node_modules and finds the dependencies there.
    installPhase = ''
      runHook preInstall

      mkdir -p "$out/lib"
      cp -r node_modules "$out/lib/node_modules"

      runHook postInstall
    '';
  }
  // extraAttrs
)
