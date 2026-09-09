import type { BuildSpec, CarryPath } from "../types.js";

type NodeAppOptions = {
  builder?: string;
  runtime?: string;
  steps: string[];
  // Defaults to yarn with a frozen lockfile. Set false where the build has no
  // separable dependency phase
  dependencies?: { files: string[]; step: string } | false;
  output: string;
  entrypoint: string[];
  carry?: CarryPath[];
  submodules?: boolean;
  caches?: string[];
};

export function nodeApp(options: NodeAppOptions): BuildSpec {
  return {
    preset: "nodeApp",
    builderImage: `node:${options.builder ?? "22-alpine"}`,
    runtimeImage: `node:${options.runtime ?? "24-alpine"}`,
    dependencies:
      options.dependencies === false
        ? undefined
        : (options.dependencies ?? {
            files: ["package.json", "yarn.lock"],
            step: "yarn install --frozen-lockfile",
            stripScripts: ["preinstall", "prepare", "postinstall"],
          }),
    steps: options.steps,
    output: options.output,
    carry: options.carry ?? [],
    entrypoint: options.entrypoint,
    // The package manager's own cache, and nothing else. node_modules used to
    // be a mount too, and BuildKit drops a cache mount whenever it likes while
    // keeping the layer that filled it: the install then does not re-run and
    // the modules are simply gone. What that looks like is a build saying it
    // cannot find a dependency the manifest plainly lists.
    //
    // Installed into the layer instead, they are there for every step below,
    // for a migration run in this image afterwards, and for a check. The
    // manager's cache still makes the install itself fast
    caches: options.caches ?? ["yarn", "npm"],
    submodules: options.submodules ?? false,
    // The checkout arrives complete, so this is what a build step itself needs.
    // openssh-client is for the dependencies it resolves rather than the
    // repository: a git+ssh entry in a manifest is fetched during the install,
    // and git cannot do that without an ssh to run
    aptPackages: ["git", "openssh-client"],
    runtimePackages: ["curl"],
    runtimeSteps: [],
  };
}
