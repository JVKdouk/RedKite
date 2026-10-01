import type { BuildSpec, CarryPath } from "../types.js";

type NodeAppOptions = {
  builder?: string;
  runtime?: string;
  steps: string[];
  // Defaults to yarn with a frozen lockfile; false for no dependency phase
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
    // Manager cache only: BuildKit may drop a mount but keep the layer that filled it
    caches: options.caches ?? ["yarn", "npm"],
    submodules: options.submodules ?? false,
    // openssh-client is for git+ssh dependencies resolved during the install
    aptPackages: ["git", "openssh-client"],
    runtimePackages: ["curl"],
    runtimeSteps: [],
  };
}
