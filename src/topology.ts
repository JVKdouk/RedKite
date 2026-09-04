import type { AppSpec, Deployment, ServiceSpec } from "./types.js";

import { environmentOf } from "./config.js";
import { mountFor } from "./layout.js";

// Every name and address the deployment uses, derived from the app list. This
// is the file that replaces the constants block: nothing is chosen by hand, so
// adding an app cannot collide with an address somebody already picked.

const NGINX_OCTET = 20;
const APP_BLOCK_START = 21;
// Services sit in their own block, so adding one never moves an app
const SERVICE_BLOCK_START = 200;

export type AppTopology = {
  name: string;
  container: string;
  retired: string;
  failed: string;
  currentAddress: string;
  retiredAddress: string;
  port: number;
  route: string;
  volumes: { volume: string; mountPath: string }[];
  caches: Record<string, string>;
};

export type ServiceTopology = {
  name: string;
  container: string;
  address: string;
  alias?: string;
  volumes: { volume: string; mountPath: string }[];
};

export type Topology = {
  environment: string;
  branch: string;
  network: string;
  subnet: string;
  cidr: string;
  // Absent for an environment written for verify alone, which publishes nothing
  publicPort?: number;
  // Derived, never listed. Apps with routes imply exactly one proxy, and it
  // keeps the address it was given before any of this was derived
  router: ServiceTopology;
  apps: AppTopology[];
  services: ServiceTopology[];
  // Every alias a container must resolve, name to address
  extraHosts: Record<string, string>;
};

export function topologyFor(config: Deployment, environment: string): Topology {
  const env = environmentOf(config, environment);

  if (!env) {
    const known = Object.keys(config.environments ?? {});

    // An environment is a file, so having none is a different mistake from
    // asking for one that is not there, and reads as one
    if (known.length === 0) {
      throw new Error(
        `No environments. Each one is a redkite.<name>.config.ts beside the ` +
          `deployment, so ${environment} wants a redkite.${environment}.config.ts`,
      );
    }

    throw new Error(
      `Unknown environment ${environment}, expected one of ${known.join(", ")}`,
    );
  }

  const prefix = `${config.project}-${environment}`;
  const address = (octet: number) => `${env.subnet}.${octet}`;

  const apps = config.apps.map((app, index) =>
    appTopology(app, prefix, environment, address, index),
  );

  const services = config.services.map((service, index) =>
    serviceTopology(service, prefix, address, index),
  );

  return {
    environment,
    branch: env.branch,
    network: `${prefix}-network`,
    subnet: env.subnet,
    cidr: `${env.subnet}.0/16`,
    publicPort: env.publicPort,
    router: {
      name: "nginx",
      container: `${prefix}-nginx`,
      address: address(NGINX_OCTET),
      volumes: [],
    },
    apps,
    services,
    extraHosts: extraHosts(apps, services, env.extraHosts),
  };
}

function appTopology(
  app: AppSpec,
  prefix: string,
  environment: string,
  address: (octet: number) => string,
  index: number,
): AppTopology {
  const container = `${prefix}-${app.name}`;
  const base = APP_BLOCK_START + index * 2;

  const volumes = Object.entries(app.volumes ?? {}).map(([name, mountPath]) => ({
    volume: `${container}-${name}`,
    mountPath,
  }));

  // Deduplicated by where each one mounts: an app that is the whole repository
  // resolves the root and its own node_modules to one path, and two ids for one
  // target would be a second cache nothing ever writes to
  const targets = new Set<string>();
  const caches: Record<string, string> = {};

  for (const cache of app.build.caches) {
    const target = mountFor(cache, app.dir);
    if (targets.has(target)) continue;

    targets.add(target);
    caches[cache] = `${app.name}-${environment}-${cache}-cache`;
  }

  return {
    name: app.name,
    container,
    retired: `retired-${container}`,
    failed: `failed-${container}`,
    // Retired takes the lower slot, so a rollback never renumbers the live one
    retiredAddress: address(base),
    currentAddress: address(base + 1),
    port: app.port,
    route: app.route,
    volumes,
    caches,
  };
}

function serviceTopology(
  service: ServiceSpec,
  prefix: string,
  address: (octet: number) => string,
  index: number,
): ServiceTopology {
  const container = `${prefix}-${service.name}`;

  return {
    name: service.name,
    container,
    // Pinned when a service already exists at a known address
    address: address(service.address ?? SERVICE_BLOCK_START + index),
    alias: service.alias,
    volumes: Object.entries(service.volumes ?? {}).map(([name, mountPath]) => ({
      volume: `${container}-${name}`,
      mountPath,
    })),
  };
}

// Nginx resolves upstreams by container name, apps reach services by alias
function extraHosts(
  apps: AppTopology[],
  services: ServiceTopology[],
  declared: Record<string, string> = {},
) {
  const hosts: Record<string, string> = {};

  for (const app of apps) {
    hosts[app.container] = app.currentAddress;
    hosts[app.retired] = app.retiredAddress;
  }

  for (const service of services) {
    if (service.alias) hosts[service.alias] = service.address;
  }

  // Declared last, but never over a derived one: a name that already resolves
  // to a container in this deployment would send its traffic somewhere else,
  // and the deploy would look like it worked
  for (const [name, address] of Object.entries(declared)) {
    if (name in hosts) {
      throw new Error(
        `extraHosts names ${name}, which this deployment already resolves to ${hosts[name]}`,
      );
    }

    hosts[name] = address;
  }

  return hosts;
}
