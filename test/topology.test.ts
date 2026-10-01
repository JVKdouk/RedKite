import assert from "node:assert/strict";
import { describe, it } from "node:test";

import config, { authored } from "./deployment.js";
import { defineDeployment, topologyFor, type Deployment, type Environment } from "../src/index.js";

// Written out rather than derived, so a changed derivation fails here
const TODAY = {
  network: "acme-staging-network",
  cidr: "172.255.0.0/16",
  publicPort: 4000,
  nginxAddress: "172.255.0.20",
  redisAddress: "172.255.0.26",
  frontContainer: "acme-staging-frontend",
  backContainer: "acme-staging-backend",
  frontRetiredAddress: "172.255.0.21",
  frontCurrentAddress: "172.255.0.22",
  backRetiredAddress: "172.255.0.23",
  backCurrentAddress: "172.255.0.24",
  backLogsVolume: "acme-staging-backend-logs",
  // No node_modules cache: a dropped mount that held the modules fails the build
  caches: [
    "backend-staging-yarn-cache",
    "backend-staging-npm-cache",
    "frontend-staging-yarn-cache",
    "frontend-staging-npm-cache",
    "frontend-staging-next-app-cache",
  ],
};

describe("topology", () => {
  const topology = topologyFor(config, "staging");
  const frontend = topology.apps.find((app) => app.name === "frontend");
  const backend = topology.apps.find((app) => app.name === "backend");
  const redis = topology.services.find((service) => service.name === "redis");

  it("derives the network the deployment uses today", () => {
    assert.equal(topology.network, TODAY.network);
    assert.equal(topology.cidr, TODAY.cidr);
    assert.equal(topology.publicPort, TODAY.publicPort);
    assert.equal(topology.router.address, TODAY.nginxAddress);
  });

  it("derives every container name that is hardcoded today", () => {
    assert.equal(frontend?.container, TODAY.frontContainer);
    assert.equal(backend?.container, TODAY.backContainer);
    assert.equal(frontend?.retired, `retired-${TODAY.frontContainer}`);
    assert.equal(backend?.failed, `failed-${TODAY.backContainer}`);
    assert.equal(redis?.container, "acme-staging-redis");
  });

  it("allocates the addresses that were assigned by hand", () => {
    assert.equal(frontend?.retiredAddress, TODAY.frontRetiredAddress);
    assert.equal(frontend?.currentAddress, TODAY.frontCurrentAddress);
    assert.equal(backend?.retiredAddress, TODAY.backRetiredAddress);
    assert.equal(backend?.currentAddress, TODAY.backCurrentAddress);
    assert.equal(redis?.address, TODAY.redisAddress);
  });

  it("derives the volume and every cache key", () => {
    assert.deepEqual(backend?.volumes, [
      { volume: TODAY.backLogsVolume, mountPath: "/app/logs" },
    ]);

    const derived = [
      ...Object.values(backend?.caches ?? {}),
      ...Object.values(frontend?.caches ?? {}),
    ];

    assert.deepEqual([...derived].sort(), [...TODAY.caches].sort());
  });

  it("gives nginx every host it has to resolve", () => {
    assert.deepEqual(topology.extraHosts, {
      [TODAY.frontContainer]: TODAY.frontCurrentAddress,
      [`retired-${TODAY.frontContainer}`]: TODAY.frontRetiredAddress,
      [TODAY.backContainer]: TODAY.backCurrentAddress,
      [`retired-${TODAY.backContainer}`]: TODAY.backRetiredAddress,
      redis: TODAY.redisAddress,
    });
  });

  it("produces a production topology without editing a source file", () => {
    const production = topologyFor(config, "production");

    assert.equal(production.network, "acme-production-network");
    assert.equal(production.branch, "master");
    assert.equal(production.publicPort, 80);
    assert.equal(production.router.address, "172.254.0.20");
    assert.equal(
      production.apps.find((app) => app.name === "backend")?.container,
      "acme-production-backend",
    );
  });

  it("refuses an environment nobody defined", () => {
    assert.throws(() => topologyFor(config, "sandbox"), /Unknown environment sandbox/);
  });

  it("never assigns one address twice", () => {
    const used = [
      topology.router.address,
      ...topology.apps.flatMap((app) => [app.currentAddress, app.retiredAddress]),
      ...topology.services.map((service) => service.address),
    ];

    assert.equal(new Set(used).size, used.length);
  });

  it("does not move an existing app when another is appended", () => {
    const extended = {
      ...config,
      apps: [
        ...config.apps,
        {
          ...config.apps[1]!,
          name: "workers",
          route: "/workers/",
          port: 3002,
          volumes: undefined,
        },
      ],
    };

    const after = topologyFor(extended, "staging");

    for (const before of topology.apps) {
      const moved = after.apps.find((app) => app.name === before.name);
      assert.equal(moved?.currentAddress, before.currentAddress);
      assert.equal(moved?.retiredAddress, before.retiredAddress);
    }

    // Services keep their block, so appending an app renumbers nothing
    assert.equal(
      after.services.find((service) => service.name === "redis")?.address,
      TODAY.redisAddress,
    );
  });

  // Joined onto /app, so anything but a relative dir reads somewhere else
  it("rejects a dir that is not a path inside the repository", () => {
    const withDir = (dir: string) => ({
      ...authored,
      apps: authored.apps.map((app, index) => (index === 0 ? { ...app, dir } : app)),
    });

    assert.throws(() => defineDeployment(withDir("/apps/web")), /inside the repository/);
    assert.throws(() => defineDeployment(withDir("apps/web/")), /inside the repository/);
    assert.throws(() => defineDeployment(withDir("")), /inside the repository/);
    assert.throws(() => defineDeployment(withDir("../web")), /climb out/);
    assert.doesNotThrow(() => defineDeployment(withDir("apps/web")));
  });

  // Cloned or already here, and guessing between them is worse than being told
  it("rejects an app naming both a repo and a path", () => {
    const both = {
      ...authored,
      apps: authored.apps.map((app, index) =>
        index === 0 ? { ...app, path: "./web" } : app,
      ),
    };

    assert.throws(() => defineDeployment(both), /names both a repo and a path/);
  });

  it("rejects an app naming no source at all", () => {
    const neither = {
      ...authored,
      apps: authored.apps.map((app, index) =>
        index === 0 ? { ...app, repo: undefined } : app,
      ),
    };

    assert.throws(() => defineDeployment(neither), /names no source/);
  });

  it("takes a path in place of a repo", () => {
    const local = {
      ...authored,
      apps: authored.apps.map((app, index) =>
        index === 0 ? { ...app, repo: undefined, path: "./web" } : app,
      ),
    };

    assert.doesNotThrow(() => defineDeployment(local));
  });

  // A clone is whatever the repository holds, so an include does nothing
  it("rejects an include on an app that is cloned", () => {
    const narrowed = {
      ...authored,
      apps: authored.apps.map((app, index) =>
        index === 0 ? { ...app, include: ["src"] } : app,
      ),
    };

    assert.throws(() => defineDeployment(narrowed), /is cloned rather than built from a path/);
  });

  it("rejects an include that names nothing", () => {
    const empty = {
      ...authored,
      apps: authored.apps.map((app, index) =>
        index === 0 ? { ...app, repo: undefined, path: "./web", include: [] } : app,
      ),
    };

    assert.throws(() => defineDeployment(empty), /includes nothing/);
  });

  // Two at once is two commits, and picking one is not this file's to do
  it("rejects an app naming more than one thing to build from", () => {
    const both = (over: Record<string, string>) => ({
      ...authored,
      apps: authored.apps.map((app, index) => (index === 0 ? { ...app, ...over } : app)),
    });

    assert.throws(() => defineDeployment(both({ branch: "main", tag: "v1" })), /different commits/);
    assert.throws(() => defineDeployment(both({ tag: "v1", commit: "abc" })), /different commits/);
    assert.doesNotThrow(() => defineDeployment(both({ tag: "v1" })));
    assert.doesNotThrow(() => defineDeployment(both({ branch: "main" })));
  });

  // The proxy already has this name, and two containers on one is indistinguishable
  it("rejects a service called what the derived proxy is called", () => {
    const clashing = {
      ...authored,
      services: [...authored.services, { name: "nginx", image: "nginx:stable" }],
    };

    assert.throws(() => defineDeployment(clashing), /a service cannot be called that/);
  });

  it("rejects two apps on one route", () => {
    const clashing = {
      ...authored,
      apps: authored.apps.map((app) => ({ ...app, route: "/" })),
    };

    assert.throws(() => defineDeployment(clashing), /share the route/);
  });

  it("rejects a name used twice", () => {
    const clashing = {
      ...authored,
      services: [...authored.services, { name: "redis", image: "redis:7" }],
    };

    assert.throws(() => defineDeployment(clashing), /Duplicate name/);
  });
});

// A service the apps resolve whose address differs between environments
describe("extra hosts a deployment declares", () => {
  const withHosts = (extraHosts: Record<string, string>) =>
    topologyFor(
      {
        ...config,
        environments: {
          staging: { ...config.environments!.staging!, extraHosts },
        },
      },
      "staging",
    );

  it("resolves beside the ones the topology derives", () => {
    const topology = withHosts({ "db.internal": "10.9.9.9" });

    assert.equal(topology.extraHosts["db.internal"], "10.9.9.9");
    assert.equal(
      topology.extraHosts["acme-staging-frontend"],
      TODAY.frontCurrentAddress,
    );
  });

  // It would send a container's traffic elsewhere and still look like it worked
  it("refuses a name the deployment already resolves", () => {
    assert.throws(
      () => withHosts({ "acme-staging-backend": "10.9.9.9" }),
      /already resolves to/,
    );

    assert.throws(() => withHosts({ redis: "10.9.9.9" }), /already resolves to/);
  });

  it("changes nothing when none are declared", () => {
    assert.deepEqual(
      topologyFor(config, "staging").extraHosts,
      withHosts({}).extraHosts,
    );
  });
});


// One environment needs no file; two is what the plural key is for
describe("an environment the deployment carries", () => {
  const inline = {
    ...authored,
    environment: { branch: "trunk", subnet: "10.44.0", publicPort: 8080 },
  };

  it("is used whatever name the command line asked for", () => {
    for (const name of ["staging", "production", "anything"]) {
      const derived = topologyFor(inline, name);

      assert.equal(derived.branch, "trunk");
      assert.equal(derived.cidr, "10.44.0.0/16");
      assert.equal(derived.publicPort, 8080);
    }
  });

  it("still threads the name it was asked for through every derived name", () => {
    const derived = topologyFor(inline, "production");

    assert.equal(derived.network, "acme-production-network");
    assert.ok(derived.apps.every((app) => app.container.includes("-production-")));
  });

  // An override, not a default
  it("overrides the files beside the deployment", () => {
    const both = { ...config, environment: inline.environment };

    assert.equal(topologyFor(config, "staging").branch, "staging");
    assert.equal(topologyFor(both, "staging").branch, "trunk");
  });

  it("is what a deployment without one falls back from", () => {
    assert.equal(topologyFor(config, "staging").branch, "staging");
    assert.throws(() => topologyFor(config, "nowhere"), /Unknown environment/);
  });
});

// Per environment, since two on one host cannot hold the same port
describe("a deployment with no proxy", () => {
  const staging: Environment = { branch: "staging", subnet: "172.255.0", ports: { backend: 3001 } };

  const proxyless = (environment: Environment = staging) =>
    ({
      ...config,
      proxy: false,
      apps: config.apps.map((app) => ({ ...app, route: undefined })),
      environments: { staging: environment },
    }) satisfies Deployment;

  const appNamed = (deployment: Deployment, name: string) => {
    const app = topologyFor(deployment, "staging").apps.find((item) => item.name === name);
    assert.ok(app, `no ${name}`);
    return app;
  };

  it("publishes the port the environment gives an app", () => {
    assert.equal(appNamed(proxyless(), "backend").published, 3001);
  });

  it("publishes nothing for an app the environment gives no port", () => {
    assert.equal(appNamed(proxyless(), "frontend").published, undefined);
  });

  it("refuses ports while the deployment runs a proxy, which is the way in", () => {
    const routed = { ...config, environments: { staging: { ...staging, publicPort: 4000 } } } satisfies Deployment;
    assert.throws(() => topologyFor(routed, "staging"), /runs a proxy.*proxy: false/);
  });

  it("refuses a publicPort, since there is no proxy to publish on it", () => {
    assert.throws(() => topologyFor(proxyless({ ...staging, publicPort: 4000 }), "staging"), /names a publicPort/);
  });

  it("refuses a port for an app the deployment does not have", () => {
    assert.throws(
      () => topologyFor(proxyless({ ...staging, ports: { worker: 4001 } }), "staging"),
      /ports for worker.*frontend, backend/,
    );
  });

  it("refuses something that is not a port", () => {
    assert.throws(() => topologyFor(proxyless({ ...staging, ports: { backend: 70000 } }), "staging"), /not a port/);
    assert.throws(() => topologyFor(proxyless({ ...staging, ports: { backend: 30.5 } }), "staging"), /not a port/);
  });

  it("refuses two apps on one host port", () => {
    assert.throws(
      () => topologyFor(proxyless({ ...staging, ports: { frontend: 3001, backend: 3001 } }), "staging"),
      /both frontend and backend on 3001/,
    );
  });

  // Nothing would read a route, and one written anyway reads as a way in
  it("refuses a route when there is no proxy to resolve it", () => {
    assert.throws(() => defineDeployment({ ...authored, proxy: false }), /has a route.*no proxy/);
  });

  it("refuses an app with no route while there is a proxy", () => {
    const unrouted = { ...authored, apps: authored.apps.map((app) => ({ ...app, route: undefined })) };
    assert.throws(() => defineDeployment(unrouted), /has no route/);
  });
});
