import type { Docker } from "../docker.js";
import type { Host } from "../host.js";
import type { Log } from "../log.js";
import { LISTEN_PORT } from "../nginx.js";
import { readEnv, type SecretStores } from "../secrets/refs.js";
import type { ServiceTopology, Topology } from "../topology.js";
import type { ServiceSpec } from "../types.js";

// redis.ts and nginx.ts were the same object described twice: ensure a sidecar
// from an image is running, at an address, with a configuration file.

export type EnsureContext = {
  host: Host;
  docker: Docker;
  topology: Topology;
  // Rendered by the caller, so this file does not have to know what nginx is
  files: Record<string, string>;
  // One store per provider a service names. A service without secrets never
  // opens one
  secrets: SecretStores;
  log: Log;
  // Set for the proxy alone. Nothing else is reachable from outside the host,
  // and nothing else has to resolve the apps by name
  publish?: number;
};

export async function ensureService(
  spec: ServiceSpec,
  service: ServiceTopology,
  context: EnsureContext,
) {
  const { docker } = context;
  const name = service.container;

  // A service outlives a deploy, so only its absence is a reason to build one.
  // Recreating it would drop the apps' connections for no gain
  if (await docker.container.exists(name)) {
    if (await docker.container.isRunning(name)) return false;

    context.log.warn(`${name} was not running, starting it`);
    await docker.container.start(name);
    return true;
  }

  context.log(`Creating ${name} at ${service.address}`);
  await createService(spec, service, context);
  await docker.container.start(name);

  return true;
}

async function createService(
  spec: ServiceSpec,
  service: ServiceTopology,
  context: EnsureContext,
) {
  const { docker, topology } = context;
  const name = service.container;

  await buildImage(spec, name, context);

  const builder = docker.container
    .builder()
    .name(name)
    .image(name)
    .network(topology.network)
    .ip(service.address);

  if (spec.restart) builder.restart(spec.restart);

  for (const [name, value] of Object.entries(spec.environment ?? {})) {
    builder.env(name, value);
  }

  // Written to the host and handed over as a file, so the value never appears
  // in an argument list. Docker reads it when the container is created and
  // keeps the values, so the file goes with the rest of the deploy's scratch
  if (spec.secrets) {
    const contents = await readEnv(spec.secrets, context.secrets);
    builder.envFile(await context.host.write(`services/${name}/env`, contents));
  }

  for (const volume of service.volumes) {
    builder.volume(volume.volume, volume.mountPath);
  }

  if (context.publish) {
    for (const [host, ip] of Object.entries(topology.extraHosts)) {
      builder.extraHost(host, ip);
    }

    builder.port(context.publish, LISTEN_PORT);
  }

  await builder.create();
}

// Three lines of Dockerfile on the host, in place of a container assembled in
// an engine, exported as a tarball and loaded back in
async function buildImage(
  spec: ServiceSpec,
  name: string,
  context: EnsureContext,
) {
  const { host, docker } = context;
  const directory = `services/${name}`;

  const copies = await Promise.all(
    Object.entries(context.files).map(async ([path, contents], index) => {
      await host.write(`${directory}/file.${index}`, contents);
      return `COPY file.${index} ${path}`;
    }),
  );

  const dockerfile = await host.write(
    `${directory}/Dockerfile`,
    [
      `FROM ${spec.image}`,
      ...copies,
      ...(context.publish ? [`EXPOSE ${LISTEN_PORT}`] : []),
      "",
    ].join("\n"),
  );

  await docker.image.build({
    context: `${host.directory}/${directory}`,
    dockerfile,
    tags: [name],
  });
}
