import { appRoot, destinationFor, mountFor, rootedAt } from "./layout.js";
import type { BuildSpec } from "./types.js";

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
  lines.push("COPY . /app");

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

  // The output becomes /app, so the command already starts at the app's root.
  // A build that ships the whole repository is the exception: the tree arrives
  // as it was, and the command has to start where dir says
  const workdir = spec.output === "/app" ? appRoot(context.dir) : "/app";
  const lines = [`FROM ${spec.runtimeImage}`, `WORKDIR ${workdir}`];

  if (spec.runtimePackages.length > 0) {
    lines.push(`RUN apk add --no-cache ${spec.runtimePackages.join(" ")}`);
  }

  lines.push(`COPY --from=${BUILDER_STAGE} ${output} /app`);

  // Directories the output does not contain but the runtime needs, such as a
  // generated client or the static assets a standalone build leaves behind
  // Only the source is rooted. Where it lands is read against the spec's own
  // output, because dir moves the app inside the builder and not inside /app
  for (const path of spec.carry) {
    const from = rootedAt(path, context.dir);
    lines.push(`COPY --from=${BUILDER_STAGE} ${from} ${destinationFor(path, spec.output)}`);
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

// One mount per cache, repeated on every step, because a Dockerfile scopes a
// cache to the RUN that asks for it rather than to the stage
function cacheMounts(spec: BuildSpec, context: DockerfileContext) {
  return spec.caches
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

  const lines = files.map((file) => `COPY ${file} /app/${file}`);

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
