import assert from "node:assert/strict";
import { describe, it } from "node:test";

import config from "../examples/acme/redkite.config.js";
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
  caches: [
    "backend-staging-yarn-cache",
    "backend-staging-modules-cache",
    "frontend-staging-yarn-cache",
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

  it("rejects two apps on one route", () => {
    const clashing = {
      ...config,
      apps: config.apps.map((app) => ({ ...app, route: "/" })),
    };

    assert.throws(() => defineDeployment(clashing), /share the route/);
  });

  it("rejects a name used twice", () => {
    const clashing = {
      ...config,
      services: [...config.services, { name: "redis", image: "redis:7" }],
    };

    assert.throws(() => defineDeployment(clashing), /Duplicate name/);
  });
});
