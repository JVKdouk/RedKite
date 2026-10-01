import { createHash } from "node:crypto";

import type { Docker } from "../docker.js";
import { LISTEN_PORT, proxyService, renderProxy } from "./proxy.js";
import type { Run } from "../pipeline.js";
import type { ServiceTopology, Topology } from "../topology.js";
import type { Deployment, ServiceSpec } from "../types.js";

// Services outlive a deploy, so the config that created one may not be current

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

  // Nothing serves in a verify run, so it gets no proxy and no published port
  if (run === "verify" || config.proxy === false) return rest;

  const proxy: PlannedService = {
    spec: proxyService(config),
    service: topology.router,
    files: {
      "/etc/nginx/conf.d/default.conf": renderProxy(topology, config.proxy),
    },
    publish: topology.publicPort,
  };

  return [proxy, ...rest];
}

// Secrets are named by ref, so a plan can answer without unlocking a vault
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
    // The proxy alone, and what publishing it costs
    publish: publish && { host: publish, container: LISTEN_PORT },
    extraHosts: publish ? topology.extraHosts : undefined,
  };

  return createHash("sha256").update(JSON.stringify(shape)).digest("hex").slice(0, 16);
}

// Why a service differs from the deployment; absent means it does not
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
  // Created by hand or by an older redkite, so it is rebuilt once
  if (!held) return "unrecognised" as const;

  if (held !== fingerprintOf(planned, topology)) return "changed" as const;
  if (!(await docker.container.isRunning(name))) return "stopped" as const;

  return undefined;
}
