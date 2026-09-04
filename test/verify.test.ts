import assert from "node:assert/strict";
import { describe, it } from "node:test";

import base from "./deployment.js";
import type { Deployment } from "../src/index.js";
import { topologyFor, verify } from "../src/index.js";
import { fakeHost } from "./fakes.js";

// A verify run is the same host, the same services and the same images as a
// deploy, stopping where one would start moving addresses. What is asserted is
// that it builds, that it runs what the apps declare, and that it touches
// nothing that is serving.

const secrets = { bitwarden: { read: async () => "{}" } };

const CHECKED: Deployment = {
  ...base,
  apps: base.apps.map((app) =>
    app.name === "backend"
      ? { ...app, verify: { steps: ["yarn db:migrate", "yarn test:integration"] } }
      : app,
  ),
};

async function run(config: Deployment = CHECKED, options: { refuse?: string } = {}) {
  const host = fakeHost();
  if (options.refuse) host.refuse(options.refuse);

  const result = await verify({ config, environment: "staging", host: host.host, secrets });
  return { result, host };
}

// The example declares checks, so a run with none is this file's to build
const NONE: Deployment = {
  ...base,
  apps: base.apps.map((app) => ({ ...app, verify: undefined })),
};

// A step's failure is wrapped by the pipeline, and the reason is the cause
function reasons(error: unknown): string[] {
  if (!(error instanceof Error)) return [];
  return [error.message, ...reasons(error.cause)];
}

const topology = topologyFor(CHECKED, "staging");
// Anything that would create, move, rename or stop one of the app containers.
// Services are created in a verify run, apps are not
const APPS = topology.apps.flatMap((app) => [app.container, app.retired, app.failed]);

function touchesAnApp(command: string) {
  const words = command.split(" ");
  // Building tags an image after the container, and a service is created the
  // same way an app would be. Only the verb plus the name means a swap
  if (words[0] !== "container" && words[0] !== "network") return false;

  return APPS.some((name) => words.includes(name));
}

describe("verify", () => {
  it("reports the apps whose checks ran", async () => {
    const { result } = await run();

    assert.deepEqual(result.checked, ["backend"]);
    assert.equal(result.ok, true);
  });

  it("releases nothing and reverts nothing", async () => {
    const { result, host } = await run();

    assert.deepEqual(result.released, []);
    assert.deepEqual(result.reverted, []);
    assert.deepEqual(host.commands.filter(touchesAnApp), []);
  });

  it("never probes a health endpoint, because nothing was started", async () => {
    const { host } = await run();

    assert.deepEqual(host.commands.filter((command) => command.startsWith("exec ")), []);
  });

  it("builds every app, not only the ones it checks", async () => {
    const { result } = await run();

    assert.deepEqual(result.apps.map((app) => app.name).sort(), ["backend", "frontend"]);
  });

  // The proxy resolves upstreams that a verify run never creates, and
  // publishing a port for them would take one on the machine running the checks
  it("brings up the services without the proxy", async () => {
    const { result } = await run();

    assert.deepEqual(result.services, ["acme-staging-redis"]);
    assert.ok(!result.services.includes(topology.router.container));
  });

  it("runs each declared command in order, in that app's builder image", async () => {
    const { host } = await run();
    const checks = host.commands.filter((command) => command.includes("sh -c"));

    assert.equal(checks.length, 2);
    assert.ok(checks[0]?.endsWith("sh -c 'yarn db:migrate'"));
    assert.ok(checks[1]?.endsWith("sh -c 'yarn test:integration'"));

    for (const check of checks) {
      assert.ok(check.includes("acme-staging-backend-builder:"), check);
      assert.ok(check.startsWith("run --rm "), check);
    }
  });

  // A check reaching redis at "redis" is the whole reason to be on the network
  it("attaches the checks to the deployment network with its aliases", async () => {
    const { host } = await run();
    const check = host.commands.find((command) => command.includes("sh -c")) ?? "";

    assert.ok(check.includes(`--network ${topology.network}`));
    assert.ok(check.includes("--add-host redis:172.255.0.26"));
  });

  it("hands the checks the app's environment and its own", async () => {
    const withEnvironment = {
      ...CHECKED,
      apps: CHECKED.apps.map((app) =>
        app.name === "backend"
          ? { ...app, verify: { steps: ["yarn test"], environment: { CI: "1" } } }
          : app,
      ),
    };

    const { host } = await run(withEnvironment);
    const check = host.commands.find((command) => command.includes("sh -c")) ?? "";

    assert.ok(check.includes("-e PM2_HOME='/app/logs/pm2'"), check);
    assert.ok(check.includes("-e CI='1'"), check);
  });

  it("stops at the command that failed and says which it was", async () => {
    const thrown = await run(CHECKED, { refuse: "yarn db:migrate" }).catch(
      (error: unknown) => error,
    );

    assert.deepEqual(reasons(thrown).slice(0, 2), [
      "Step verify failed",
      "backend failed yarn db:migrate: refused yarn db:migrate",
    ]);
  });

  it("does not run what came after a failed command", async () => {
    const host = fakeHost();
    host.refuse("yarn db:migrate");

    await assert.rejects(() =>
      verify({ config: CHECKED, environment: "staging", host: host.host, secrets }),
    );

    assert.ok(!host.commands.some((command) => command.includes("test:integration")));
  });

  // Refused before the run starts, so nothing is built for a run that would
  // then have nothing to do
  it("refuses a run where no app declares checks", async () => {
    const host = fakeHost();

    await assert.rejects(
      () => verify({ config: NONE, environment: "staging", host: host.host, secrets }),
      /No app declares verify/,
    );

    assert.deepEqual(host.commands, [], "and the host is untouched");
  });
});
