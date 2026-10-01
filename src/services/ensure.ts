import { SPEC_LABEL, type Docker } from "../docker.js";
import type { Host } from "../host.js";
import type { Log } from "../log.js";
import { LISTEN_PORT } from "./proxy.js";
import { readEnv, type SecretStores } from "../secrets/refs.js";
import type { ServiceTopology, Topology } from "../topology.js";
import type { ServiceSpec } from "../types.js";

import { fingerprintOf, type PlannedService } from "./planned.js";

// Ensures a sidecar from an image is running, at an address, with a config file

export type EnsureContext = {
  host: Host;
  docker: Docker;
  topology: Topology;
  // Rendered by the caller, so this file need not know what nginx is
  files: Record<string, string>;
  // One store per provider a service names; without secrets none is opened
  secrets: SecretStores;
  log: Log;
  // The proxy alone: nothing else is reachable or resolves the apps by name
  publish?: number;
};

// What became of one service, so a deploy can say what it did
export type Ensured = "adopted" | "started" | "created" | "recreated";

export async function ensureService(
  spec: ServiceSpec,
  service: ServiceTopology,
  context: EnsureContext,
): Promise<Ensured> {
  const { docker } = context;
  const name = service.container;
  const fingerprint = fingerprintOf(plannedFrom(spec, service, context), context.topology);

  if (await docker.container.exists(name)) {
    // Being there is usually enough, but a changed config only reaches a new container
    if (await docker.container.specOf(name) === fingerprint) {
      if (await docker.container.isRunning(name)) return "adopted";

      context.log.warn(`${name} was not running, starting it`);
      await docker.container.start(name);
      return "started";
    }

    context.log(`${name} is not what the deployment says, recreating it`);
    await docker.container.stop(name);
    await docker.container.remove(name);
    await createService(spec, service, context, fingerprint);
    await docker.container.start(name);
    return "recreated";
  }

  context.log(`Creating ${name} at ${service.address}`);
  await createService(spec, service, context, fingerprint);
  await docker.container.start(name);

  return "created";
}

// The same shape the plan compares against, so the two cannot drift apart
function plannedFrom(
  spec: ServiceSpec,
  service: ServiceTopology,
  context: EnsureContext,
): PlannedService {
  return { spec, service, files: context.files, publish: context.publish };
}

async function createService(
  spec: ServiceSpec,
  service: ServiceTopology,
  context: EnsureContext,
  fingerprint: string,
) {
  const { docker, topology } = context;
  const name = service.container;

  await buildImage(spec, name, context);

  const builder = docker.container
    .builder()
    .name(name)
    .image(name)
    .network(topology.network)
    .label(SPEC_LABEL, fingerprint)
    .ip(service.address);

  if (spec.restart) builder.restart(spec.restart);

  for (const [name, value] of Object.entries(spec.environment ?? {})) {
    builder.env(name, value);
  }

  // Handed over as a file, so no value appears in an argument list
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

// Three lines of Dockerfile on the host, in place of an exported tarball
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
