import assert from "node:assert/strict";
import { describe, it } from "node:test";

import config from "./deployment.js";
import { build, deploy, Docker, topologyFor } from "../src/index.js";
import { fakeHost } from "./fakes.js";

const topology = topologyFor(config, "staging");
const front = topology.apps.find((app) => app.name === "frontend")!;
const back = topology.apps.find((app) => app.name === "backend")!;
const backend = config.apps.find((app) => app.name === "backend")!;

async function fullDeploy(existing = [front.container, back.container]) {
  const host = fakeHost({ existing });

  host.respond(front.container, '{"status":"ok"}');
  host.respond(back.container, '{"status":"up","redis":"up","database":"up"}');

  const result = await deploy({
    config,
    environment: "staging",
    host: host.host,
    secrets: { bitwarden: { read: async () => "DATABASE_URL=postgres://u:p@h:5432/d\n" } },
    health: { sleep: async () => {} },
  });

  return { result, host };
}

async function traceBuild() {
  const host = fakeHost();

  await build(backend, back, {
    host: host.host,
    docker: new Docker(host.host),
    env: "",
    files: {},
    branch: "staging",
    environment: "staging",
  });

  return host;
}

describe("pipeline cost", () => {
  it("asks the host what it looks like exactly once", async () => {
    const { host } = await fullDeploy();
    const snapshots = host.commands.filter((command) => command.startsWith("ps -a"));

    assert.equal(snapshots.length, 1);
  });

  it("never inspects a single object", async () => {
    const { host } = await fullDeploy();
    const inspects = host.commands.filter((command) => command.includes("docker inspect"));

    // Every guard used to be its own round trip to another machine
    assert.deepEqual(inspects, []);
  });

  it("stays under a round trip budget for a two app deployment", async () => {
    const { host } = await fullDeploy();

    // A ceiling, so a new step is allowed but per-object polling is not
    assert.ok(
      host.commands.length <= 40,
      `${host.commands.length} host commands, budget is 40`,
    );
  });

  it("never moves an image between machines", async () => {
    const { host } = await fullDeploy();

    // Created in the daemon that runs it, so the export and transfer go away
    assert.deepEqual(
      host.commands.filter((command) => /^(load|save|push|pull) /.test(command)),
      [],
    );
  });

  it("hands the build a checkout the host already holds", async () => {
    const host = await traceBuild();
    const context = host.commands.find((command) => command.startsWith("build "))!;

    // A mirror survives the deploy, so the next fetches only what is new
    assert.ok(host.commands.some((c) => c.includes(`git clone --mirror`)));
    assert.ok(host.commands.some((c) => c.includes(`remote update --prune`)));
    assert.match(context, new RegExp(`${host.host.cache}/source/${back.container}$`));
  });

  it("mounts every cache the topology derived, and no others", async () => {
    const host = await traceBuild();
    const file = host.files.get("backend.Dockerfile")!;

    const mounted = new Set(
      [...file.matchAll(/--mount=type=cache,id=([^,]+)/g)].map((match) => match[1]),
    );

    assert.deepEqual([...mounted].sort(), Object.values(back.caches).sort());
  });
});

describe("work not done twice", () => {
  it("skips the build entirely when the host already holds the commit", async () => {
    const first = await fullDeploy();
    const held = [...first.host.images].filter((image) => image.includes(":"));

    const host = fakeHost({ existing: [front.container, back.container] });
    for (const image of held) host.images.add(image);

    host.respond(front.container, '{"status":"ok"}');
    host.respond(back.container, '{"status":"up","redis":"up","database":"up"}');

    const result = await deploy({
      config,
      environment: "staging",
      host: host.host,
      secrets: { bitwarden: { read: async () => "DATABASE_URL=postgres://u:p@h:5432/d\n" } },
      health: { sleep: async () => {} },
    });

    assert.equal(result.ok, true);

    // Only the services are built here; neither app is
    const apps = host.commands.filter(
      (command) =>
        command.startsWith("build ") &&
        [front, back].some((app) => command.includes(`/source/${app.container}`)),
    );

    assert.deepEqual(apps, []);
  });

  it("tags every image it builds by commit, so the next deploy can skip it", async () => {
    const { host } = await fullDeploy();
    const builds = host.commands.filter((command) => command.startsWith("build "));

    assert.ok(builds.some((command) => command.includes(`-t ${back.container}:abc1234`)));
    assert.ok(builds.some((command) => command.includes(`-t ${front.container}:abc1234`)));
  });

  // Without this every deploy adds a runtime image and a builder to the disk
  it("reclaims the versions it replaced", async () => {
    const host = fakeHost({ existing: [front.container, back.container] });

    host.images.add(`${back.container}:stale-fingerprint`);
    host.images.add(`${back.container}-builder:stale-fingerprint`);
    // What the deploy before left behind, including the name it created from
    host.images.add(back.container);
    host.respond(front.container, '{"status":"ok"}');
    host.respond(back.container, '{"status":"up","redis":"up","database":"up"}');

    await deploy({
      config,
      environment: "staging",
      host: host.host,
      secrets: { bitwarden: { read: async () => "DATABASE_URL=postgres://u:p@h:5432/d\n" } },
      health: { sleep: async () => {} },
    });

    assert.ok(host.commands.includes(`image remove -f ${back.container}:stale-fingerprint`));
    assert.ok(
      host.commands.includes(`image remove -f ${back.container}-builder:stale-fingerprint`),
    );

    // Reclaiming the moving name leaves a host that cannot start the app
    const removed = host.commands.filter((c) => c.startsWith("image remove"));
    for (const name of [back.container, `${back.container}:latest`]) {
      assert.ok(!removed.includes(`image remove -f ${name}`), `${name} was reclaimed`);
    }
  });

  // Setup goes first, the price of a host a step can rely on
  it("has the network and every service up before a build starts", async () => {
    const order: string[] = [];
    const host = fakeHost();
    const sidecars = [topology.router, ...topology.services].map((s) => s.container);

    host.respond(front.container, '{"status":"ok"}');
    host.respond(back.container, '{"status":"up","redis":"up","database":"up"}');

    const traced = {
      ...host.host,
      sh: async (command: string) => {
        if (command.startsWith("docker network create")) order.push("network");
        const created = command.startsWith("docker container create") ? command.split(" ")[4] : undefined;
        if (created && sidecars.includes(created)) order.push(`create ${created}`);
        if (command.includes("git clone --mirror")) order.push("build");
        return await host.host.sh(command);
      },
    };

    await deploy({
      config,
      environment: "staging",
      host: traced,
      secrets: { bitwarden: { read: async () => "DATABASE_URL=postgres://u:p@h:5432/d\n" } },
      health: { sleep: async () => {} },
    });

    const created = order.filter((event) => event.startsWith("create "));

    assert.equal(created.length, sidecars.length);
    assert.ok(order.indexOf("network") < order.indexOf("build"));
    assert.ok(order.lastIndexOf(created.at(-1)!) < order.indexOf("build"));
  });
});
