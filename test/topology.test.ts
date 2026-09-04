import assert from "node:assert/strict";
import { describe, it } from "node:test";

import config, { authored } from "./deployment.js";
import { defineDeployment, topologyFor } from "../src/index.js";

// Every name and address a deployment runs on, written out rather than
// derived, so the test fails if the derivation ever starts answering
// differently. Two of these colliding is a deploy that takes an app down
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
  // No app-modules here: neither example app has a dir, so its target is the
  // root's and the topology drops it.
  caches: [
    "backend-staging-yarn-cache",
    "backend-staging-npm-cache",
    "backend-staging-modules-cache",
    "frontend-staging-yarn-cache",
    "frontend-staging-npm-cache",
    "frontend-staging-modules-cache",
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

    // Services keep their block, so appending an app cannot renumber redis
    assert.equal(
      after.services.find((service) => service.name === "redis")?.address,
      TODAY.redisAddress,
    );
  });

  // dir is joined onto /app in the image, so anything but a relative path
  // renders a Dockerfile that reads somewhere the checkout is not
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

  // Cloned or already here. The two are built differently enough that guessing
  // between them is worse than being told
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

  // A clone is whatever the repository holds, so an include there would be a
  // line in the config that quietly does nothing
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

// A database or a legacy service the apps must resolve, whose address is what
// differs between environments
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

  // A name that already resolves to a container in this deployment would send
  // its traffic somewhere else, and the deploy would look like it worked
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


// A deployment with one environment and no reason to keep it in a file. Two of
// them is two files, which is what the plural key is for
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

  // An override, not a default: a file it disagrees with does not win
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
