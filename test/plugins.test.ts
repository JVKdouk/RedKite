import assert from "node:assert/strict";
import { describe, it } from "node:test";

import config from "./deployment.js";
import type { Built, Context, Step } from "../src/index.js";
import type { SnapshotPoint } from "../src/index.js";
import type { Plugin } from "../src/index.js";
import {
  digitalOceanSnapshot,
  rdsSnapshot,
  silent,
  snapshotName,
  topologyFor,
} from "../src/index.js";
import { fakeHost } from "./fakes.js";
import { Docker } from "../src/index.js";

// A snapshot is a control-plane call rather than anything the deploy host does,
// so what is asserted is the request each one builds. The provider itself is
// injected, which is the only part of these that cannot be run here.

const said: string[] = [];

function contextFor(): Context {
  const host = fakeHost();

  return {
    config,
    environment: "staging",
    run: "deploy",
    topology: topologyFor(config, "staging"),
    host: host.host,
    docker: new Docker(host.host),
    secrets: {},
    log: silent,
    task: { detail: (m) => said.push(m), line: () => {}, done: () => {}, fail: () => {} },
  };
}

const built: Built = {
  environment: "staging",
  network: "acme-staging-network",
  services: [],
  apps: [],
};

const plan = { config, environment: "staging" };

// A plugin carries the step rather than being one, so every assertion below is
// about the single step it registered. Stored erased, because a list assembled
// from a config cannot carry each step's own input type: both of these sit at
// swap:before, which is what makes Built the value they are handed
function only(plugin: Plugin) {
  const [step] = plugin.steps ?? [];
  assert.ok(step, `${plugin.name} registered no step`);

  return step as Step<SnapshotPoint>;
}

describe("snapshotting RDS before a swap", () => {
  const calls: string[][] = [];
  const aws = async (args: string[]) => {
    calls.push(args);
    return { stdout: "" };
  };

  it("hangs itself before the swap, where the migration has not run yet", () => {
    const plugin = rdsSnapshot({ instance: "acme-production", aws });

    assert.equal(plugin.name, "rds-snapshot-acme-production");
    assert.equal(only(plugin).point, "swap:before:snapshot-acme-production");
  });

  it("asks for an instance snapshot named after the environment", async () => {
    calls.length = 0;
    const step = only(rdsSnapshot({ instance: "acme-production", region: "eu-west-1", aws }));

    await step.run(built, contextFor());
    const [args = []] = calls;

    assert.deepEqual(args.slice(0, 4), [
      "rds",
      "create-db-snapshot",
      "--db-instance-identifier",
      "acme-production",
    ]);

    assert.ok(args.includes("--region"));
    assert.ok(args[5]?.startsWith("acme-production-staging-"), args[5]);
  });

  // Aurora is a cluster, and a cluster is a different call against a different
  // thing rather than the same call with another word
  it("asks for a cluster snapshot when that is what it was given", async () => {
    calls.length = 0;
    const step = only(rdsSnapshot({ cluster: "acme-aurora", aws }));

    await step.run(built, contextFor());

    assert.equal(calls[0]?.[1], "create-db-cluster-snapshot");
    assert.ok(calls[0]?.includes("--db-cluster-identifier"));
  });

  it("waits only when it was asked to", async () => {
    calls.length = 0;
    await only(rdsSnapshot({ instance: "one", aws })).run(built, contextFor());
    assert.equal(calls.length, 1);

    calls.length = 0;
    await only(rdsSnapshot({ instance: "one", wait: true, aws })).run(built, contextFor());

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1]?.slice(0, 3), ["rds", "wait", "db-snapshot-available"]);
  });

  // Where the plugin is written rather than where it runs, so the config fails
  // to load rather than the deploy failing at its first check
  it("refuses a config naming both an instance and a cluster", () => {
    assert.throws(() => rdsSnapshot({ instance: "one", cluster: "two", aws }), /different databases/);
  });

  it("refuses a config naming neither", () => {
    assert.throws(() => rdsSnapshot({ aws }), /names no instance or cluster/);
  });
});

describe("snapshotting a DigitalOcean disk before a swap", () => {
  const sent: { url: string; body: string; auth?: string }[] = [];

  const request = async (url: string, init: { headers: Record<string, string>; body: string }) => {
    sent.push({ url, body: init.body, auth: init.headers["authorization"] });
    return { ok: true, status: 201, text: async () => "" };
  };

  const withToken = <T>(fn: () => T) => {
    process.env["DIGITALOCEAN_TOKEN"] = "do-token";
    try {
      return fn();
    } finally {
      delete process.env["DIGITALOCEAN_TOKEN"];
    }
  };

  it("snapshots a volume through the volume endpoint", async () => {
    sent.length = 0;
    const step = only(digitalOceanSnapshot({ volume: "vol-123", request }));

    await withToken(async () => await step.run(built, contextFor()));

    assert.equal(sent[0]?.url, "https://api.digitalocean.com/v2/volumes/vol-123/snapshots");
    assert.equal(sent[0]?.auth, "Bearer do-token");
    assert.ok(JSON.parse(sent[0]?.body ?? "{}").name.startsWith("vol-123-staging-"));
  });

  // A volume takes a snapshot; a droplet is asked to perform one. Two shapes,
  // which is why the target is two fields rather than one
  it("snapshots a droplet through the action endpoint", async () => {
    sent.length = 0;
    const step = only(digitalOceanSnapshot({ droplet: 42, request }));

    await withToken(async () => await step.run(built, contextFor()));

    assert.equal(sent[0]?.url, "https://api.digitalocean.com/v2/droplets/42/actions");
    assert.equal(JSON.parse(sent[0]?.body ?? "{}").type, "snapshot");
  });

  it("stops the deploy when the snapshot was refused", async () => {
    const refusing = only(
      digitalOceanSnapshot({
        volume: "vol-123",
        request: async () => ({ ok: false, status: 422, text: async () => "no such volume" }),
      }),
    );

    await assert.rejects(
      async () => await withToken(async () => await refusing.run(built, contextFor())),
      /refused the snapshot of vol-123 \(422\): no such volume/,
    );
  });

  // Before the run starts, so a token nobody set is a config that fails while
  // the host is untouched rather than a deploy that stops with the swap ahead
  it("refuses a missing token before anything has happened", () => {
    delete process.env["DIGITALOCEAN_TOKEN"];
    const step = only(digitalOceanSnapshot({ volume: "vol-123", request }));

    assert.throws(() => step.check?.(plan), /DIGITALOCEAN_TOKEN is not set/);
  });

  it("refuses a config naming both a volume and a droplet", () => {
    assert.throws(() => digitalOceanSnapshot({ volume: "v", droplet: 1, request }), /different disks/);
  });
});

describe("what a snapshot is called", () => {
  it("carries the environment and the minute it was taken", () => {
    const name = snapshotName("acme-db", "production", new Date("2026-09-08T10:41:25Z"));

    assert.equal(name, "acme-db-production-20260908104125");
  });

  // RDS takes letters, digits and single hyphens, and nothing else
  it("reduces anything else to a single hyphen", () => {
    assert.equal(snapshotName("Acme_DB v2", "pre prod", new Date(0)), "acme-db-v2-pre-prod-19700101000000");
  });
});
