import type { BuildSpec, SourcemapSpec } from "../types.js";

type NodeAppOptions = {
  builder?: string;
  runtime?: string;
  steps: string[];
  // Defaults to yarn with a frozen lockfile. Set false where the build has no
  // separable dependency phase
  dependencies?: { files: string[]; step: string } | false;
  output: string;
  entrypoint: string[];
  carry?: string[];
  submodules?: boolean;
  caches?: string[];
  sourcemaps?: SourcemapSpec;
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
    caches: options.caches ?? ["yarn", "modules"],
    submodules: options.submodules ?? false,
    // The checkout arrives complete, so this is what a build step itself needs
    aptPackages: ["git"],
    runtimePackages: ["curl"],
    sourcemaps: options.sourcemaps,
  };
}
