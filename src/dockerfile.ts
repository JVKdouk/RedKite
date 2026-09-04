import { appRoot, destinationFor, mountFor, rootedAt } from "./layout.js";
import type { BuildSpec, CarryPath } from "./types.js";

// The pipeline, as the only thing that runs it: a Dockerfile handed to the
// BuildKit already inside the deploy host's daemon. Layer order is the
// contract, everything that does not change between deploys comes first, so a
// new commit only invalidates from the source copy down.

export type DockerfileContext = {
  // Cache name to the id BuildKit keys the mount by, one per app and
  // environment so two builds never share a node_modules
  caches: Record<string, string>;
  port: number;
  release: string;
  environment: string;
  // Secrets arrive by id. Their contents never enter this file, which keeps
  // them out of docker history. The id carries the fingerprint, because a
  // secret mount is not part of a layer's cache key and a changed environment
  // would otherwise be answered with the image built from the old one
  envSecret: string;
  // Container path to secret id, for credentials that have to be files
  fileSecrets: Record<string, string>;
  // Where the app sits in the repository, when it is not the repository. The
  // build steps and the shipped command run there, and every /app path the
  // spec names is read against it
  dir?: string;
};

// Named here because the build stops at this stage to keep an image a
// step before the swap can run in, and two spellings of it would drift
export const BUILDER_STAGE = "builder";

// What BuildKit reads beside the Dockerfile. Without an include the checkout
// keeps its own rules and only .git is held back. With one, everything is held
// back and the named paths are let through again, so what the build sees is
// what the release was taken over
export function renderDockerignore(include?: string[]) {
  if (!include) return ".git\n**/.git\n";

  // .git after the exemptions, because the last rule to match is the one that
  // decides and an included directory would otherwise carry it back in
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

  // The repository root, not the app's own directory: a workspace resolves one
  // lockfile for every package in it, so the install below has to see them all
  const lines = [
    `FROM ${spec.builderImage} AS ${BUILDER_STAGE}`,
    "WORKDIR /app",
  ];

  if (spec.aptPackages.length > 0) {
    lines.push(`RUN apk add --no-cache ${spec.aptPackages.join(" ")}`);
  }

  lines.push(`ENV NODE_ENV=${context.environment}`);
  lines.push("ENV NEXT_TELEMETRY_DISABLED=1");

  if (spec.dependencies) lines.push(...dependencyLayer(spec, mounts));

  // Submodules are already in the context: the checkout on the host resolved
  // them, so nothing in the build needs an agent or a .git directory
  lines.push(copy(".", "/app"));

  // Only now, so the steps below read the app's own manifest and write beside it
  if (context.dir) lines.push(`WORKDIR ${workdir}`);

  lines.push(
    `RUN --mount=type=secret,id=${context.envSecret} cp /run/secrets/${context.envSecret} ${workdir}/.env`,
    `ENV SENTRY_RELEASE=${context.release}`,
  );

  // Unquoted: the shell form hands everything after RUN to sh -c, so a step is
  // written exactly as it would be typed. Quoting it made the whole command one
  // word, and the shell went looking for a program by that name
  for (const step of spec.steps) {
    lines.push(`RUN ${mounts}${step}`);
  }

  if (spec.sourcemaps) {
    // The built .env ships inside the image, and an upload token is build-time
    const token = spec.sourcemaps.stripFromImage;
    lines.push(`RUN sed -i '/^${token}=/d' ${rootedAt(spec.output, context.dir)}/.env`);
  }

  return lines;
}

function runtimeStage(spec: BuildSpec, context: DockerfileContext) {
  const output = rootedAt(spec.output, context.dir);

  // Where the app lands inside the tree that was just copied to /app. An output
  // keeping the repository's structure puts it back under dir, and everything
  // else flattens it to the top
  const nested = spec.keepsLayout ? context.dir : undefined;
  const lines = [`FROM ${spec.runtimeImage}`, `WORKDIR ${appRoot(nested)}`];

  if (spec.runtimePackages.length > 0) {
    lines.push(`RUN apk add --no-cache ${spec.runtimePackages.join(" ")}`);
  }

  // Before the output, which changes every commit: what these install is a
  // property of the image, not of the release being deployed
  for (const step of spec.runtimeSteps) {
    lines.push(`RUN ${step}`);
  }

  // The one copy nothing can be allowed to skip: an image without it starts,
  // answers, and serves a 404 for everything the app was supposed to be
  lines.push(copy(output, "/app", BUILDER_STAGE));

  // Directories the output does not contain but the runtime needs, such as a
  // generated client or the static assets a standalone build leaves behind.
  // The two sides are rooted separately: dir is where the app was built, and
  // nested is where the output put it
  for (const entry of spec.carry) {
    const { path, optional } = carried(entry);
    const from = rootedAt(path, context.dir);
    const to = rootedAt(destinationFor(path, spec.output), nested);

    lines.push(optional ? copyOrSkip(from, to, BUILDER_STAGE) : copy(from, to, BUILDER_STAGE));
  }

  for (const [path, secret] of Object.entries(context.fileSecrets)) {
    lines.push(
      `RUN --mount=type=secret,id=${secret} cp /run/secrets/${secret} ${path}`,
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

// A COPY whose source does not exist fails the build, which is what a source
// the build was supposed to produce should do
function copy(from: string, to: string, stage?: string) {
  return `COPY ${stage ? `--from=${stage} ` : ""}${from} ${to}`;
}

// Bracketing the last character makes the source a pattern, and a pattern
// matching nothing is skipped: the only way a Dockerfile has to say "if it
// exists". For a source whose absence is a fact about the repository
function copyOrSkip(from: string, to: string, stage?: string) {
  const path = from.replace(/\/+$/, "");
  const last = path.slice(-1);

  // An empty pattern matches nothing and would be skipped in silence, which is
  // the one outcome this whole distinction exists to prevent
  if (!last) return copy(from, to, stage);

  return copy(`${path.slice(0, -1)}[${last}]`, to, stage);
}

// One mount per cache, repeated on every step, because a Dockerfile scopes a
// cache to the RUN that asks for it rather than to the stage
function cacheMounts(spec: BuildSpec, context: DockerfileContext) {
  // Only the caches the topology derived an id for. It drops any whose target
  // another already covers, and two mounts on one target is a build that does
  // not start
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

  // A lockfile the repository does not have is not an error here. The install
  // below is what decides that, and it says so in the package manager's words
  const lines = files.map((file) => copyOrSkip(file, `/app/${file}`));

  // This layer is the manifest and the lockfile, nothing else. A root prepare
  // that installs git hooks or calls into scripts/ has neither
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

// Only for a command passed as one argument to another. Single quotes are what
// the shell strips, so a script containing double quotes survives
function quote(command: string) {
  return `'${command.replaceAll("'", `'\\''`)}'`;
}
