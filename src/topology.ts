import type { AppSpec, Deployment, Environment, ServiceSpec } from "./types.js";

import { environmentOf } from "./config.js";
import { mountFor } from "./layout.js";
import { logMount } from "./services/proxy.js";

// Every name and address, derived from the app list rather than chosen by hand

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
  route?: string;
  // The port published on the deploy host, when there is no proxy
  published?: number;
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
  // Absent for a verify-only environment, which publishes nothing
  publicPort?: number;
  // Derived, never listed, and keeps the address it was given
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

    // Having none is a different mistake from asking for one that is not there
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

  assertPorts(config, environment, env);

  const prefix = `${config.project}-${environment}`;
  const address = (octet: number) => `${env.subnet}.${octet}`;

  const apps = config.apps.map((app, index) =>
    appTopology(app, prefix, environment, address, index, env.ports?.[app.name]),
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
      // Only a directory the deployment named, so a silent proxy is unchanged
      volumes: routerVolumes(config),
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
  published: number | undefined,
): AppTopology {
  const container = `${prefix}-${app.name}`;
  const base = APP_BLOCK_START + index * 2;

  const volumes = Object.entries(app.volumes ?? {}).map(([name, mountPath]) => ({
    volume: `${container}-${name}`,
    mountPath,
  }));

  // Deduplicated by mount point, since two ids on one target is a dead cache
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
    published,
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

// Per environment, and the way in only when there is no proxy, never both
function assertPorts(config: Deployment, environment: string, env: Environment) {
  const named = Object.entries(env.ports ?? {});

  if (config.proxy !== false && named.length > 0) {
    throw new Error(
      `${environment} publishes ports for ${named.map(([name]) => name).join(", ")}, and ` +
        "the deployment runs a proxy, which is the way in. proxy: false publishes each " +
        "app's port instead",
    );
  }

  if (config.proxy === false && env.publicPort !== undefined) {
    throw new Error(
      `${environment} names a publicPort, and the deployment runs no proxy to publish on ` +
        "it. Each app's port is published by ports instead",
    );
  }

  const apps = new Set(config.apps.map((app) => app.name));
  const unknown = named.map(([name]) => name).filter((name) => !apps.has(name));

  if (unknown.length > 0) {
    throw new Error(
      `${environment} publishes ports for ${unknown.join(", ")}, which this deployment has ` +
        `no app by that name for. Its apps are ${[...apps].join(", ")}`,
    );
  }

  const invalid = named.find(([, port]) => !Number.isInteger(port) || port < 1 || port > 65535);
  if (invalid) throw new Error(`${environment} publishes ${invalid[0]} on ${invalid[1]}, which is not a port`);

  const held = new Map<number, string>();

  for (const [name, port] of named) {
    const other = held.get(port);

    if (other) {
      throw new Error(
        `${environment} publishes both ${other} and ${name} on ${port}, and a host port is ` +
          "held by one container at a time",
      );
    }

    held.set(port, name);
  }
}

function routerVolumes(config: Deployment) {
  const logs = logMount(config.proxy);
  return logs ? [logs] : [];
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

  // Never over a derived one, which would send a container's traffic elsewhere
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
