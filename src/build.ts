import { createHash } from "node:crypto";
import { resolve } from "node:path";

import type { Docker } from "./docker.js";
import { BUILDER_STAGE, renderDockerfile, renderDockerignore } from "./dockerfile.js";
import type { Ref, Source } from "./source.js";
import type { Host } from "./host.js";
import { prepareSource } from "./source.js";
import type { AppTopology } from "./topology.js";
import type { AppSpec } from "./types.js";

// Built by the BuildKit inside the daemon that will run it, so the image never moves

export type BuildContext = {
  host: Host;
  docker: Docker;
  // Set when the image is built elsewhere, and streamed to this daemon after
  deliver?: { host: Host; docker: Docker };
  // Contents of the .env the image ships with
  env: string;
  // Container path to the contents that land there
  files: Record<string, string>;
  branch: string;
  environment: string;
  // Asking for a mount nothing is behind fails the build outright
  agent?: boolean;
  detail?: (message: string) => void;
  // Prints what the build itself wrote, line by line as it runs
  output?: (line: string) => void;
};

// Bumped when the pipeline changes shape, or a host serves the old output forever
const PIPELINE = "6";

export type BuildResult = {
  release: string;
  // Everything that shaped the image, not just the commit it was built from
  fingerprint: string;
  // Versioned name the image carries, which the next deploy recognises
  tag: string;
  // Kept as an image of its own: the only place a step gets the app's toolchain
  builderTag: string;
  // True when the host already held this exact image and nothing was rebuilt
  cached: boolean;
};

// An environment can only say a branch, since a tag pins one repository
export function refOf(app: AppSpec, branch: string): Ref {
  if (app.tag) return { kind: "tag", name: app.tag };
  if (app.commit) return { kind: "commit", name: app.commit };

  return { kind: "branch", name: app.branch ?? branch };
}

// Its own call, so a run can make the clone a step ahead of the build
export async function sourceOf(
  app: AppSpec,
  topology: AppTopology,
  context: Pick<BuildContext, "host" | "branch" | "detail" | "output">,
): Promise<Source> {
  return await prepareSource(context.host, {
    name: topology.container,
    repo: app.repo,
    // Already absolute: a path is read against the deployment file
    path: app.path && resolve(app.path),
    include: app.include,
    ref: refOf(app, context.branch),
    output: context.output,
    submodules: app.build.submodules,
    detail: context.detail,
  });
}

export async function build(
  app: AppSpec,
  topology: AppTopology,
  context: BuildContext,
  // Already checked out by a step of its own; absent, the build fetches it
  checkedOut?: Source,
): Promise<BuildResult> {
  const { host, docker } = context;
  const spec = app.build;
  const detail = context.detail ?? (() => {});

  const source = checkedOut ?? (await sourceOf(app, topology, { ...context, detail }));

  const release = source.release;
  const fingerprint = fingerprintOf(app, context, release);
  const tag = `${topology.container}:${release}-${fingerprint}`;
  // Always: a flag that must be set before a step can run is one that goes missing
  const builderTag = `${topology.container}-builder:${release}-${fingerprint}`;

  // Asked of the daemon that will run it: an image only this machine holds must be sent
  const runner = context.deliver?.docker ?? docker;

  // The whole build is skipped: nothing about this commit or these secrets differs
  if (await held(runner, tag, builderTag)) {
    detail(`already built at ${release.slice(0, 7)}`);
    await runner.image.retag(tag, topology.container);

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
      dir: app.dir,
      agent: context.agent,
    }),
  );

  // Read beside the Dockerfile, so the repository keeps its own .dockerignore
  await host.write(
    `${app.name}.Dockerfile.dockerignore`,
    renderDockerignore(app.include),
  );

  const invocation = {
    ssh: context.agent,
    context: source.tree,
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

  // Every layer was just built, so this costs the export alone
  detail("keeping the builder");
  await docker.image.build(
    { ...invocation, tags: [builderTag], target: BUILDER_STAGE },
    watch(detail, context.output),
  );

  await ship(context, [tag, topology.container, builderTag], detail);

  return { release, fingerprint, tag, builderTag, cached: false };
}

// One stream, with the tags travelling inside the archive
async function ship(
  context: BuildContext,
  tags: (string | undefined)[],
  detail: (message: string) => void,
) {
  const deliver = context.deliver;
  if (!deliver) return;

  const named = tags.filter((tag) => tag !== undefined);
  detail(`shipping ${named.length} images`);

  const result = await deliver.host.pipe(
    `docker save ${named.join(" ")}`,
    "docker load",
    context.output,
  );

  if (result.code !== 0) {
    throw new Error(`Could not ship the image: ${result.stderr || result.stdout}`);
  }

  await deliver.docker.track((state) => {
    for (const tag of named) state.images.add(tag);
  });
}

async function held(docker: Docker, tag: string, builderTag: string) {
  if (!(await docker.image.exists(tag))) return false;

  // Without its builder, a migration would run from whatever was tagged last
  return await docker.image.exists(builderTag);
}

// Named by the id BuildKit mounts it under, holding where it sits on the host
type Secret = { id: string; src: string };

// And, for a credential, where it has to land in the image
type FileSecret = Secret & { path: string };

// The fingerprint is in every id, since a secret mount is not a layer cache key
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
      // Named by index, so a container path with slashes stays one file
      src: await context.host.write(`${app.name}.file.${index}`, contents),
    })),
  );

  return { env, files };
}

// BuildKit names its own step, a better line than this file could invent
const STEP = /^#\d+ \[[^\]]*\] (.+)$/;

function watch(detail: (message: string) => void, output?: (line: string) => void) {
  return (line: string) => {
    output?.(line);

    const step = STEP.exec(line)?.[1];
    if (step) detail(step);
  };
}

// The pipeline, the environment file and baked-in files all change the image too
function fingerprintOf(app: AppSpec, context: BuildContext, release: string) {
  return createHash("sha256")
    .update(PIPELINE)
    .update(release)
    .update(app.dir ?? "")
    // It changes the Dockerfile, so the image differs from one built without it
    .update(String(context.agent ?? false))
    .update(JSON.stringify(app.build))
    .update(context.env)
    .update(JSON.stringify(Object.entries(context.files).sort()))
    .digest("hex")
    .slice(0, 12);
}
