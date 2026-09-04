import { createHash } from "node:crypto";

import type { Docker } from "../docker.js";
import { LISTEN_PORT, renderNginx } from "../nginx.js";
import type { Run } from "../pipeline.js";
import type { ServiceTopology, Topology } from "../topology.js";
import type { Deployment, ServiceSpec } from "../types.js";

// What a deployment says should be running, and how that compares to what is.
// Services outlive a deploy, so the config that created one is not the config
// the file now holds: a changed public port or a rendered nginx block lands in
// an image the running container was never created from.

export type PlannedService = {
  spec: ServiceSpec;
  service: ServiceTopology;
  // Rendered by the deployment, and part of the image the container runs
  files: Record<string, string>;
  publish?: number;
};

export function plannedServices(
  config: Deployment,
  topology: Topology,
  run: Run = "deploy",
): PlannedService[] {
  const rest = config.services.map((spec) => {
    const service = topology.services.find((item) => item.name === spec.name);
    if (!service) throw new Error(`No topology for service ${spec.name}`);

    return { spec, service, files: spec.files ?? {} };
  });

  // Nothing serves in a verify run, so a proxy there would resolve upstreams
  // that were never created and publish a port for them
  if (run === "verify") return rest;

  const proxy: PlannedService = {
    spec: router(config),
    service: topology.router,
    files: {
      "/etc/nginx/conf.d/default.conf": renderNginx(topology, config.maxBodySize),
    },
    publish: topology.publicPort,
  };

  return [proxy, ...rest];
}

// Not something a deployment lists. Apps carry routes, routes need a proxy to
// resolve them, and the one that renders them is this
export function router(config: Deployment): ServiceSpec {
  return {
    name: "nginx",
    image: config.proxyImage ?? "nginx:stable",
    restart: "always",
  };
}

// Everything a recreate would change, and nothing a deploy resolves. Secrets
// are named by their refs rather than their values: whether the config is the
// one running is a question a plan should answer without unlocking a vault
export function fingerprintOf(planned: PlannedService, topology: Topology) {
  const { spec, service, files, publish } = planned;

  const shape = {
    image: spec.image,
    restart: spec.restart,
    address: service.address,
    network: topology.network,
    volumes: service.volumes,
    environment: spec.environment,
    secrets: spec.secrets,
    files,
    // The proxy alone, and the two things being published costs it
    publish: publish && { host: publish, container: LISTEN_PORT },
    extraHosts: publish ? topology.extraHosts : undefined,
  };

  return createHash("sha256").update(JSON.stringify(shape)).digest("hex").slice(0, 16);
}

// Why a service is not what the deployment says it should be. Absent from the
// list means it is
export type Drift = {
  container: string;
  name: string;
  reason: "missing" | "stopped" | "changed" | "unrecognised";
};

export async function driftOf(
  planned: PlannedService[],
  topology: Topology,
  docker: Docker,
): Promise<Drift[]> {
  const drifted: Drift[] = [];

  for (const item of planned) {
    const reason = await reasonFor(item, topology, docker);
    if (reason) drifted.push({ container: item.service.container, name: item.spec.name, reason });
  }

  return drifted;
}

async function reasonFor(planned: PlannedService, topology: Topology, docker: Docker) {
  const name = planned.service.container;
  if (!(await docker.container.exists(name))) return "missing" as const;

  const held = await docker.container.specOf(name);
  // Created by hand, or by a redkite that did not record what it created from.
  // Either way nothing here can say it matches, so it is rebuilt once
  if (!held) return "unrecognised" as const;

  if (held !== fingerprintOf(planned, topology)) return "changed" as const;
  if (!(await docker.container.isRunning(name))) return "stopped" as const;

  return undefined;
}
