import { dirname } from "node:path";

import { appRoot, destinationFor, mountFor, rootedAt } from "./layout.js";
import type { BuildSpec, CarryPath } from "./types.js";

// Layer order is the contract: a new commit invalidates from the source copy down

export type DockerfileContext = {
  // Keyed per app and environment, so two builds never share a node_modules
  caches: Record<string, string>;
  port: number;
  release: string;
  environment: string;
  // Contents stay out of docker history; the id carries the fingerprint, as mounts are not cache keys
  envSecret: string;
  fileSecrets: Record<string, string>;
  // Asking for a mount nothing is behind fails the build outright
  agent?: boolean;
  // Where the app sits in the repository; every /app path is read against it
  dir?: string;
};

// The build stops at this stage so a step before the swap has an image to run in
export const BUILDER_STAGE = "builder";

// With an include everything is held back and the named paths let through again
export function renderDockerignore(include?: string[]) {
  if (!include) return ".git\n**/.git\n";

  // After the exemptions, since the last matching rule decides
  return ["*", ...include.map((path) => `!${path}`), ".git", "**/.git", ""].join("\n");
}

export function renderDockerfile(
  spec: BuildSpec,
  context: DockerfileContext,
): string {
  return [
    "# syntax=docker/dockerfile:1.7",
    ...builderStage(spec, context),
    "",
    ...runtimeStage(spec, context),
    "",
  ].join("\n");
}

function builderStage(spec: BuildSpec, context: DockerfileContext) {
  const mounts = cacheMounts(spec, context);
  const workdir = appRoot(context.dir);

  // The repository root: a workspace resolves one lockfile for every package
  const lines = [
    `FROM ${spec.builderImage} AS ${BUILDER_STAGE}`,
    "WORKDIR /app",
  ];

  if (spec.aptPackages.length > 0) {
    lines.push(`RUN apk add --no-cache ${spec.aptPackages.join(" ")}`);
  }

  lines.push(`ENV NODE_ENV=${context.environment}`);
  lines.push("ENV NEXT_TELEMETRY_DISABLED=1");

  // accept-new, since a build has no known_hosts to compare a first sight against
  if (context.agent) {
    lines.push(`ENV GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new"`);
  }

  const agent = context.agent ? "--mount=type=ssh " : "";

  if (spec.dependencies) lines.push(...dependencyLayer(spec, `${agent}${mounts}`));

  // Submodules are already in the context, so no agent or .git is needed here
  lines.push(copy(".", "/app"));

  if (context.dir) lines.push(`WORKDIR ${workdir}`);

  lines.push(`ENV SENTRY_RELEASE=${context.release}`);

  // Mounted per step, since a copied file stays readable in its layer for good
  const env = `--mount=type=secret,id=${context.envSecret},target=${workdir}/.env `;

  // Unquoted, so RUN takes the shell form and a step reads as it would be typed
  for (const step of spec.steps) {
    lines.push(`RUN ${env}${agent}${mounts}${step}`);
  }

  return lines;
}

function runtimeStage(spec: BuildSpec, context: DockerfileContext) {
  const output = rootedAt(spec.output, context.dir);

  // An output keeping the repository structure stays under dir; everything else flattens
  const nested = spec.keepsLayout ? context.dir : undefined;
  const lines = [`FROM ${spec.runtimeImage}`, `WORKDIR ${appRoot(nested)}`];

  if (spec.runtimePackages.length > 0) {
    lines.push(`RUN apk add --no-cache ${spec.runtimePackages.join(" ")}`);
  }

  for (const step of spec.runtimeSteps) {
    lines.push(`RUN ${step}`);
  }

  // Without this the image starts, answers, and 404s everything
  lines.push(copy(output, "/app", BUILDER_STAGE));

  // Rooted separately: dir is where the app was built, nested where the output put it
  for (const entry of spec.carry) {
    const { path, optional } = carried(entry);
    const from = rootedAt(path, context.dir);
    const to = rootedAt(destinationFor(path, spec.output), nested);

    lines.push(optional ? copyOrSkip(from, to, BUILDER_STAGE) : copy(from, to, BUILDER_STAGE));
  }

  for (const [path, secret] of Object.entries(context.fileSecrets)) {
    lines.push(
      `RUN --mount=type=secret,id=${secret} mkdir -p ${dirname(path)} && ` +
        `cp /run/secrets/${secret} ${path}`,
    );
  }

  lines.push(
    `EXPOSE ${context.port}`,
    `CMD ${JSON.stringify(spec.entrypoint)}`,
  );

  return lines;
}

function carried(entry: CarryPath) {
  if (typeof entry === "string") return { path: entry, optional: false };
  return { path: entry.path, optional: entry.optional };
}

// A COPY with a missing source fails, which is what a required output should do
function copy(from: string, to: string, stage?: string) {
  return `COPY ${stage ? `--from=${stage} ` : ""}${from} ${to}`;
}

// Bracketing the last character makes it a pattern, and a pattern matching nothing is skipped
function copyOrSkip(from: string, to: string, stage?: string) {
  const path = from.replace(/\/+$/, "");
  const last = path.slice(-1);

  // An empty pattern would be skipped in silence, the one outcome to prevent
  if (!last) return copy(from, to, stage);

  return copy(`${path.slice(0, -1)}[${last}]`, to, stage);
}

// Repeated per step, because a Dockerfile scopes a cache to the RUN asking for it
function cacheMounts(spec: BuildSpec, context: DockerfileContext) {
  // Drops any cache whose target another covers: two mounts on one target will not start
  return spec.caches
    .filter((name) => name in context.caches)
    .map((name) => {
      const id = context.caches[name] ?? name;
      return `--mount=type=cache,id=${id},target=${mountFor(name, context.dir)} `;
    })
    .join("");
}

function dependencyLayer(spec: BuildSpec, mounts: string) {
  const { files, step, stripScripts = [] } = spec.dependencies ?? {
    files: [],
    step: "",
  };

  const lines = files.map((file) => copyOrSkip(file, `/app/${file}`));

  // This layer holds the manifest and lockfile alone, so a root prepare cannot run
  if (stripScripts.length > 0) {
    lines.push(`RUN node --input-type=commonjs -e ${quote(strip(stripScripts))}`);
  }

  lines.push(`RUN ${mounts}${step}`);
  return lines;
}

function strip(names: string[]) {
  return [
    'const fs = require("fs"), path = "/app/package.json";',
    'const manifest = JSON.parse(fs.readFileSync(path, "utf8"));',
    `for (const name of ${JSON.stringify(names)}) delete manifest.scripts?.[name];`,
    "fs.writeFileSync(path, JSON.stringify(manifest, null, 2));",
  ].join("");
}

function quote(command: string) {
  return `'${command.replaceAll("'", `'\\''`)}'`;
}
