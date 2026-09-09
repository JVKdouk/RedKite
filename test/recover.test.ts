import assert from "node:assert/strict";
import { describe, it } from "node:test";

import config from "./deployment.js";
import { down, rollback, topologyFor } from "../src/index.js";
import { fakeHost } from "./fakes.js";

// A cancelled job is killed rather than asked, so nothing it was holding
// survives to tidy up. Both of these read what the host is in rather than what
// a deploy remembered, which is the only thing left to read.

const topology = topologyFor(config, "staging");
const front = topology.apps.find((app) => app.name === "frontend")!;
const back = topology.apps.find((app) => app.name === "backend")!;

const optionsFor = (existing: string[]) => {
  const host = fakeHost({ existing });
  return { host, options: { config, environment: "staging", host: host.host } };
};

async function run(existing: string[] = []) {
  const { host, options } = optionsFor(existing);
  return { result: await rollback(options), host };
}

async function stop(existing: string[] = []) {
  const { host, options } = optionsFor(existing);
  return { result: await down(options), host };
}

describe("putting back what a run did not finish", () => {
  // One exists between the swap and the cleanup that removes it, so finding one
  // means an address was moved and nothing said whether that worked
  it("puts back every app that has a retired container", async () => {
    const { result } = await run([
      front.container,
      front.retired,
      back.container,
    ]);

    assert.deepEqual(result.restored, [front.container]);
    assert.deepEqual(result.untouched, [back.container]);
  });

  it("moves the retired container onto the live address and its name", async () => {
    const { host } = await run([front.container, front.retired]);

    const ordered = host.commands.filter((command) =>
      command.startsWith("container rename") || command.startsWith("network connect"),
    );

    assert.deepEqual(ordered, [
      `container rename ${front.container} ${front.failed}`,
      `network connect --ip ${front.currentAddress} ${topology.network} ${front.retired}`,
      `container rename ${front.retired} ${front.container}`,
    ]);
  });

  // An interrupted run leaves one behind, and rename refuses rather than
  // clobbers. Without clearing it the new container stays live and the old one
  // never gets its name back
  it("clears a failed container an earlier run left in the way", async () => {
    const { result, host } = await run([
      front.container,
      front.retired,
      front.failed,
    ]);

    assert.deepEqual(result.restored, [front.container]);
    assert.ok(host.commands.includes(`container rm ${front.failed}`));
    assert.ok(
      host.commands.indexOf(`container rm ${front.failed}`) <
        host.commands.indexOf(`container rename ${front.container} ${front.failed}`),
    );
  });

  it("changes nothing when no run was interrupted", async () => {
    const { result, host } = await run([front.container, back.container]);

    assert.deepEqual(result.restored, []);
    assert.deepEqual(host.commands.filter((c) => c.startsWith("container rename")), []);
  });

  // A first deploy has nothing behind it, so the one that failed is left where
  // it was renamed to rather than started again from nowhere
  it("does not start what was never there", async () => {
    const { host } = await run([front.container]);

    assert.deepEqual(host.commands.filter((c) => c.startsWith("container start")), []);
  });
});

describe("taking an environment down", () => {
  it("stops the apps, the services and the derived proxy", async () => {
    const { result } = await stop([
      front.container,
      back.container,
      topology.router.container,
      "acme-staging-redis",
    ]);

    assert.deepEqual(result.stopped.sort(), [
      "acme-staging-redis",
      back.container,
      front.container,
      topology.router.container,
    ].sort());
  });

  // Stopped rather than removed, so the next run adopts them where it left off
  it("never removes what it stopped", async () => {
    const { host } = await stop([front.container]);

    assert.deepEqual(host.commands.filter((c) => c.startsWith("container rm")), []);
  });

  it("leaves alone what is not running", async () => {
    const { result } = await stop([]);

    assert.deepEqual(result.stopped, []);
  });
});
