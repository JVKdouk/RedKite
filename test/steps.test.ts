import assert from "node:assert/strict";
import { describe, it } from "node:test";

import config from "../examples/acme/redkite.config.js";
import { attachment, topologyFor } from "../src/index.js";

// What a step's container is attached to. The deployment network is the only
// one where a service answers to the alias the apps know it by, and that is
// what a migration against a database this deployment runs needs

const topology = topologyFor(config, "staging");

describe("the network a step runs on", () => {
  it("puts a step on the deploy host's own stack", () => {
    assert.deepEqual(attachment("host", topology), ["--network host"]);
  });

  it("gives it nothing at all", () => {
    assert.deepEqual(attachment("none", topology), ["--network none"]);
  });

  it("attaches a network somebody else made", () => {
    assert.deepEqual(attachment({ named: "legacy" }, topology), ["--network legacy"]);
  });

  it("carries the aliases onto the deployment network", () => {
    const flags = attachment("deployment", topology);

    assert.equal(flags[0], `--network ${topology.network}`);
    assert.ok(
      flags.includes(`--add-host redis:${topology.services[0]!.address}`),
      "a service is reachable by the alias, not by its container name",
    );
  });

  it("resolves every alias the apps resolve", () => {
    const flags = attachment("deployment", topology);

    assert.deepEqual(
      flags.slice(1).sort(),
      Object.entries(topology.extraHosts)
        .map(([name, ip]) => `--add-host ${name}:${ip}`)
        .sort(),
    );
  });
});
