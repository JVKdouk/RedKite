import { createHash } from "node:crypto";

import type { Docker } from "./docker.js";
import { BUILDER_STAGE, renderDockerfile } from "./dockerfile.js";
import type { Host } from "./host.js";
import { prepareSource } from "./source.js";
import type { AppTopology } from "./topology.js";
import type { AppSpec, BuildSpec } from "./types.js";

// One build. The host clones the repository, renders the pipeline as a
// Dockerfile, and hands it to the BuildKit inside the daemon that will run the
// container, so the image is finished where it is needed and never moves.

export type BuildContext = {
  host: Host;
  docker: Docker;
  // Contents of the .env the image ships with
  env: string;
  // Container path to the contents that land there
  files: Record<string, string>;
  branch: string;
  environment: string;
  detail?: (message: string) => void;
  // Prints what the build itself wrote, line by line as it runs
  output?: (line: string) => void;
};

// Bumped when the pipeline changes shape without the config changing. The tag
// below is what tells a host it already holds an image, and a host that trusts
// the commit alone serves the last pipeline's output forever
const PIPELINE = "3";

export type BuildResult = {
  release: string;
  // Everything that shaped the image, not just the commit it was built from
  fingerprint: string;
  // Versioned name the image carries, which is what the next deploy recognises
  tag: string;
  // The builder stage, kept only where a step has to run with the app's own
  // toolchain
  builderTag?: string;
  // True when the host already held this exact image and nothing was rebuilt
  cached: boolean;
};

export async function build(
  app: AppSpec,
  topology: AppTopology,
  context: BuildContext,
): Promise<BuildResult> {
  const { host, docker } = context;
  const spec = app.build;
  const detail = context.detail ?? (() => {});

  const source = await prepareSource(host, {
    name: topology.container,
    repo: app.repo,
    branch: context.branch,
    submodules: spec.submodules,
    detail,
  });

  const release = source.release;
  const fingerprint = fingerprintOf(spec, context, release);
  const tag = `${topology.container}:${release}-${fingerprint}`;
  const builderTag = app.keepBuilder
    ? `${topology.container}-builder:${release}-${fingerprint}`
    : undefined;

  // The whole build is skipped, not just a transfer. Nothing about this commit,
  // this pipeline or these secrets differs from the image already sitting there
  if (await held(docker, tag, builderTag)) {
    detail(`already built at ${release.slice(0, 7)}`);
    await docker.image.retag(tag, topology.container);

    return { release, fingerprint, tag, builderTag, cached: true };
  }

  const secrets = await writeSecrets(app, context, fingerprint);

  const dockerfile = await host.write(
    `${app.name}.Dockerfile`,
    renderDockerfile(spec, {
      caches: topology.caches,
      port: topology.port,
      release,
      environment: context.environment,
      envSecret: secrets.env.id,
      fileSecrets: Object.fromEntries(
        secrets.files.map((file) => [file.path, file.id]),
      ),
    }),
  );

  // BuildKit reads this beside the Dockerfile rather than inside the context,
  // which is what lets the checkout stay a checkout: the repository keeps its
  // own .dockerignore, and .git never enters the build
  await host.write(`${app.name}.Dockerfile.dockerignore`, ".git\n**/.git\n");

  const invocation = {
    context: source.path,
    dockerfile,
    secrets: Object.fromEntries(
      [secrets.env, ...secrets.files].map((secret) => [secret.id, secret.src]),
    ),
  };

  detail(`building ${release.slice(0, 7)}`);
  await docker.image.build(
    { ...invocation, tags: [tag, topology.container] },
    watch(detail, context.output),
  );

  if (builderTag) {
    // Every layer of this was just built, so it costs the export alone
    detail("keeping the builder");
    await docker.image.build(
      { ...invocation, tags: [builderTag], target: BUILDER_STAGE },
      watch(detail, context.output),
    );
  }

  return { release, fingerprint, tag, builderTag, cached: false };
}

async function held(docker: Docker, tag: string, builderTag?: string) {
  if (!(await docker.image.exists(tag))) return false;
  if (!builderTag) return true;

  // A runtime image without the builder that produced it would run the
  // migration from whatever release happened to be tagged last
  return await docker.image.exists(builderTag);
}

// Named by the id BuildKit mounts it under, holding where it sits on the host
type Secret = { id: string; src: string };

// And, for a credential, where it has to land in the image
type FileSecret = Secret & { path: string };

// The fingerprint is part of every id, because a secret mount is not part of a
// layer's cache key. Without it a changed environment file is answered with the
// image that was built from the old one
async function writeSecrets(
  app: AppSpec,
  context: BuildContext,
  fingerprint: string,
): Promise<{ env: Secret; files: FileSecret[] }> {
  const env = {
    id: `${app.name}-env-${fingerprint}`,
    src: await context.host.write(`${app.name}.env`, context.env),
  };

  const files = await Promise.all(
    Object.entries(context.files).map(async ([path, contents], index) => ({
      path,
      id: `${app.name}-file-${index}-${fingerprint}`,
      // Named by index, so a container path with slashes in it stays one file
      src: await context.host.write(`${app.name}.file.${index}`, contents),
    })),
  );

  return { env, files };
}

// BuildKit names the step it is on in its own progress output, which is a
// better line to show than anything this file could invent
const STEP = /^#\d+ \[[^\]]*\] (.+)$/;

function watch(detail: (message: string) => void, output?: (line: string) => void) {
  return (line: string) => {
    output?.(line);

    const step = STEP.exec(line)?.[1];
    if (step) detail(step);
  };
}

// The commit is one input of several. The pipeline, the environment file and
// any credential baked in as a file all change the image without touching it
function fingerprintOf(spec: BuildSpec, context: BuildContext, release: string) {
  return createHash("sha256")
    .update(PIPELINE)
    .update(release)
    .update(JSON.stringify(spec))
    .update(context.env)
    .update(JSON.stringify(Object.entries(context.files).sort()))
    .digest("hex")
    .slice(0, 12);
}
