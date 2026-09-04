import assert from "node:assert/strict";
import { describe, it } from "node:test";

import config from "./deployment.js";
import type { Deployment } from "../src/index.js";
import { Docker, driftOf, fingerprintOf, plannedServices, redis, topologyFor } from "../src/index.js";
import { fakeHost } from "./fakes.js";

// A service outlives a deploy, so the config that created one is not the config
// the file now holds. What is asserted here is that every change which needs a
// container to be made again is one this can see.

const topology = topologyFor(config, "staging");
const planned = plannedServices(config, topology);
const proxy = planned[0]!;

// Every edit below spreads rather than mutates, so the shared config stands
const changes = (edit: (config: Deployment) => Deployment) => {
  const after = edit(config as Deployment);
  const moved = topologyFor(after, "staging");

  return fingerprintOf(plannedServices(after, moved)[0]!, moved);
};

describe("the services a run brings up", () => {
  it("puts the proxy first, so routes resolve before anything answers", () => {
    assert.deepEqual(
      planned.map((item) => item.spec.name),
      ["nginx", "redis"],
    );
  });

  // Nothing serves in a verify run, so the proxy would resolve upstreams that
  // were never created and take a published port for them
  it("leaves the proxy out of a verify run", () => {
    const checking = plannedServices(config, topology, "verify");

    assert.deepEqual(checking.map((item) => item.spec.name), ["redis"]);
    assert.ok(checking.every((item) => item.publish === undefined));
  });
});

describe("what a service was created from", () => {
  const before = fingerprintOf(proxy, topology);

  it("is the proxy, which no deployment lists", () => {
    assert.equal(proxy.spec.name, "nginx");
    assert.equal(proxy.publish, topology.publicPort);
  });

  it("changes when the published port does", () => {
    assert.notEqual(
      before,
      changes((c) => ({
        ...c,
        environments: { ...c.environments, staging: { ...c.environments!.staging!, publicPort: 4100 } },
      })),
    );
  });

  it("changes when the rendered configuration does", () => {
    assert.notEqual(before, changes((c) => ({ ...c, maxBodySize: "8M" })));
  });

  it("changes when an app is added, because the proxy resolves it", () => {
    assert.notEqual(
      before,
      changes((c) => ({ ...c, apps: [...c.apps, { ...c.apps[0]!, name: "extra", route: "/extra/" }] })),
    );
  });

  it("changes when the image is pinned somewhere else", () => {
    assert.notEqual(before, changes((c) => ({ ...c, proxyImage: "nginx:1.27" })));
  });

  // The value is never read: whether the running config is the current one is a
  // question a plan answers without unlocking a vault
  it("changes when a secret is named differently, without reading it", () => {
    const service = planned.find((item) => item.spec.name === "redis")!;
    const named = { ...service, spec: redis({ address: 26 }) };

    assert.notEqual(
      fingerprintOf(service, topology),
      fingerprintOf({ ...named, spec: { ...named.spec, secrets: { provider: "bitwarden", id: "x" } } }, topology),
    );
  });

  it("is otherwise stable, so an unchanged service is adopted", () => {
    assert.equal(before, fingerprintOf(plannedServices(config, topology)[0]!, topology));
  });
});

describe("drift against the host", () => {
  const fingerprints = Object.fromEntries(
    planned.map((item) => [item.service.container, fingerprintOf(item, topology)]),
  );

  const report = async (options: Parameters<typeof fakeHost>[0]) =>
    await driftOf(planned, topology, new Docker(fakeHost(options).host));

  it("reports a service that is not there", async () => {
    const drifted = await report({});

    assert.deepEqual(
      drifted.map((item) => item.reason),
      planned.map(() => "missing"),
    );
  });

  it("reports nothing when every service matches", async () => {
    const containers = planned.map((item) => item.service.container);
    assert.deepEqual(await report({ existing: containers, specs: fingerprints }), []);
  });

  it("reports one created from an earlier version of the file", async () => {
    const containers = planned.map((item) => item.service.container);
    const stale = { ...fingerprints, [proxy.service.container]: "0000000000000000" };

    const drifted = await report({ existing: containers, specs: stale });

    assert.deepEqual(drifted, [
      { container: proxy.service.container, name: "nginx", reason: "changed" },
    ]);
  });

  // Created by hand, or before redkite recorded what it created from
  it("reports one it cannot recognise", async () => {
    const containers = planned.map((item) => item.service.container);
    const drifted = await report({ existing: containers });

    assert.deepEqual(
      drifted.map((item) => item.reason),
      planned.map(() => "unrecognised"),
    );
  });
});
