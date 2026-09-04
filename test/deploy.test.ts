import assert from "node:assert/strict";
import { describe, it } from "node:test";

import config from "./deployment.js";
import type { Deployment } from "../src/index.js";
import {
  bitwarden,
  deploy,
  fingerprintOf,
  migrate,
  plannedServices,
  postgres,
  topologyFor,
} from "../src/index.js";
import { fakeHost } from "./fakes.js";

const topology = topologyFor(config, "staging");
const front = topology.apps.find((app) => app.name === "frontend")!;
const back = topology.apps.find((app) => app.name === "backend")!;

const HEALTHY = {
  [front.container]: '{"status":"ok"}',
  [back.container]: '{"status":"up","redis":"up","database":"up"}',
};

const secrets = {
  bitwarden: {
    read: async (id: string) =>
      id === "4e69cf19-d708-4e65-b00b-b43a014ecd89"
        ? "{}"
        : "DATABASE_URL=postgres://user:pw@db.internal:5432/app\n",
  },
};

// What the deployment would create each service from, so a test can say the
// running one matches it or was made from something else
function fingerprints() {
  const entries = plannedServices(config, topology).map(
    (item) => [item.service.container, fingerprintOf(item, topology)] as const,
  );

  return Object.fromEntries(entries);
}

async function run(options: {
  existing?: string[];
  bodies?: Record<string, string>;
  specs?: Record<string, string>;
} = {}) {
  const host = fakeHost({ existing: options.existing, specs: options.specs });

  for (const [container, body] of Object.entries(options.bodies ?? HEALTHY)) {
    host.respond(container, body);
  }

  const result = await deploy({
    config,
    environment: "staging",
    host: host.host,
    secrets,
    health: { sleep: async () => {} },
  });

  return { result, host };
}

// A config mistake has to be found before the run starts, so what is asserted
// is the message and that the host is still untouched
async function refuses(broken: Deployment, message: RegExp) {
  const host = fakeHost();

  await assert.rejects(
    () =>
      deploy({
        config: broken,
        environment: "staging",
        host: host.host,
        secrets,
        health: { sleep: async () => {} },
      }),
    message,
  );

  return host;
}

describe("deploy", () => {
  it("reports success when every app answers healthily", async () => {
    const { result } = await run();

    assert.equal(result.ok, true);
    assert.deepEqual(result.released.sort(), [back.container, front.container].sort());
    assert.deepEqual(result.reverted, []);
  });

  it("creates the network from the derived cidr", async () => {
    const { host } = await run();

    assert.ok(
      host.commands.includes(`network create ${topology.network} --subnet=${topology.cidr}`),
    );
  });

  it("swaps in the only order that keeps a container answering", async () => {
    const { host } = await run({ existing: [back.container] });
    // Only commands where the backend is the subject, not ones that merely
    // name it in an --add-host
    const steps = host.commands.filter(
      (command) =>
        command === `network connect --ip ${back.retiredAddress} ${topology.network} ${back.container}` ||
        command === `container rename ${back.container} ${back.retired}` ||
        command === `container start ${back.container}` ||
        command.startsWith(`container create --name ${back.container} `),
    );

    assert.deepEqual(steps, [
      // The old container moves aside without stopping, still serving
      `network connect --ip ${back.retiredAddress} ${topology.network} ${back.container}`,
      `container rename ${back.container} ${back.retired}`,
      // Only then does the name and the live address belong to the new one
      `container create --name ${back.container} --hostname ${back.container} -v ${back.volumes[0]!.volume}:/app/logs --network ${topology.network} --add-host ${front.container}:${front.currentAddress} --add-host ${front.retired}:${front.retiredAddress} --add-host redis:${topology.services[0]!.address} -e PM2_HOME=/app/logs/pm2 --ip ${back.currentAddress} --restart unless-stopped ${back.container}`,
      `container start ${back.container}`,
    ]);
  });

  it("migrates before anything is retired", async () => {
    const { host } = await run({ existing: [back.container] });

    const migrated = host.commands.findIndex((c) => c.includes("yarn db:migrate"));
    const firstRetire = host.commands.findIndex((c) => c.startsWith("container rename"));

    assert.ok(migrated >= 0, "the step before the swap ran");
    assert.ok(migrated < firstRetire, "and it ran while the old containers still served");
  });

  // The deploy host is the bastion the tunnelled pipeline forwarded through, so
  // the step reaches the database the same way the host itself does
  it("runs the migration in the builder image, on the host's own network", async () => {
    const { host } = await run({ existing: [back.container] });
    const migration = host.commands.find((c) => c.includes("yarn db:migrate"))!;

    assert.match(migration, /^run --rm --network host --workdir \/app /);
    assert.match(migration, new RegExp(`${back.container}-builder:`));
  });

  // A database this deployment runs is on the deployment network under an
  // alias, and a migration on the host's own stack cannot resolve it
  it("puts a migration on the deployment network when it is asked to", async () => {
    const onNetwork: Deployment = {
      ...config,
      steps: [
        migrate({ app: "backend", command: "yarn db:migrate", network: "deployment" }),
      ],
    };

    const host = fakeHost();
    host.respond(front.container, HEALTHY[front.container]!);
    host.respond(back.container, HEALTHY[back.container]!);

    await deploy({
      config: onNetwork,
      environment: "staging",
      host: host.host,
      secrets,
      health: { sleep: async () => {} },
    });

    const migration = host.commands.find((command) => command.includes("yarn db:migrate"))!;

    assert.match(migration, new RegExp(`^run --rm --network ${topology.network} `));
    assert.ok(migration.includes(`--add-host redis:${topology.services[0]!.address}`));
    assert.ok(!migration.includes("--network host"));
  });

  // A verify environment names no port, and asking one to deploy would create
  // a proxy nobody outside can reach. Refused before anything is built
  it("refuses to deploy an environment that publishes nothing", async () => {
    const unpublished: Deployment = {
      ...config,
      environment: {
        branch: "pull-request",
        subnet: "172.254.0",
        host: { bastion: "deploy@staging.acme.example" },
      },
    };

    const host = await refuses(unpublished, /names no publicPort/);
    assert.deepEqual(host.commands, [], "and the host is untouched");
  });

  it("refuses a migration tunnelled through anything but the deploy host", async () => {
    const elsewhere: Deployment = {
      ...config,
      steps: [
        migrate({
          app: "backend",
          command: "yarn db:migrate",
          tunnel: { bastion: "ubuntu@nowhere", from: "DATABASE_URL" },
        }),
      ],
    };

    const host = await refuses(elsewhere, /ubuntu@nowhere/);
    assert.deepEqual(host.commands, [], "and nothing on the host was touched");
  });

  // Nothing in a config says an app needs a builder. Every app keeps one, so a
  // step can be hung anywhere without a second place having to agree
  it("keeps a builder for every app", async () => {
    const { host } = await run();
    const built = host.commands.filter((command: string) =>
      command.includes("--target builder"),
    );

    assert.deepEqual(
      built.map((command) => command.match(/-t (\S+-builder):/)?.[1]).sort(),
      [`${back.container}-builder`, `${front.container}-builder`].sort(),
    );
  });

  it("refuses a migration for an app nothing declares", async () => {
    const missing: Deployment = {
      ...config,
      steps: [migrate({ app: "ghost", command: "yarn db:migrate" })],
    };

    await refuses(missing, /ghost names no app/);
  });

  it("reverts every app when one of them is unhealthy", async () => {
    const { result, host } = await run({
      existing: [front.container, back.container],
      bodies: { ...HEALTHY, [back.container]: '{"status":"up","redis":"down","database":"up"}' },
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.released, []);
    assert.deepEqual(result.reverted.sort(), [back.container, front.container].sort());

    // The healthy app is put back too, a half-swapped deployment is the one
    // state nothing downstream can reason about
    for (const app of [front, back]) {
      assert.ok(host.commands.includes(`container rename ${app.container} ${app.failed}`));
      assert.ok(host.commands.includes(`container rename ${app.retired} ${app.container}`));
      assert.ok(
        host.commands.includes(
          `network connect --ip ${app.currentAddress} ${topology.network} ${app.retired}`,
        ),
      );
      assert.ok(host.commands.includes(`container start ${app.container}`));
    }
  });

  it("removes the retired container after success", async () => {
    const { host } = await run({ existing: [back.container] });

    assert.ok(host.commands.includes(`container rm ${back.retired}`));
  });

  it("does not try to remove a failed container that never existed", async () => {
    const { host } = await run({ existing: [back.container] });

    // Cleanup checks before it removes, so a first deploy is not full of
    // errors about objects that were never created
    assert.ok(!host.commands.includes(`container rm ${back.failed}`));
  });

  it("leaves nothing to clean up when it reverted", async () => {
    const { host } = await run({
      existing: [front.container, back.container],
      bodies: { ...HEALTHY, [front.container]: '{"status":"starting"}' },
    });

    const removedLive = host.commands.filter(
      (command) => command === `container rm ${front.retired}`,
    );

    // The retired container is now the live one, removing it would end the deploy
    assert.equal(removedLive.length, 0);
  });

  it("brings up services once and reuses them on the next deploy", async () => {
    const redis = topology.services.find((service) => service.name === "redis")!;
    const first = await run();

    assert.ok(first.host.commands.some((c) => c.includes(`--name ${redis.container}`)));

    const second = await run({ existing: [redis.container], specs: fingerprints() });
    const created = second.host.commands.filter((c) =>
      c.includes(`--name ${redis.container}`),
    );

    assert.deepEqual(created, []);
  });

  // A service is adopted because it is the one the deployment describes, not
  // because something with the right name is there. A rendered config or a
  // published port only reaches a container that is created
  it("recreates a service that was created from something else", async () => {
    const proxy = topology.router;
    const stale = { ...fingerprints(), [proxy.container]: "0000000000000000" };

    const { host } = await run({ existing: [proxy.container], specs: stale });

    assert.ok(host.commands.includes(`container stop ${proxy.container}`));
    assert.ok(host.commands.includes(`container rm ${proxy.container}`));
    assert.ok(host.commands.some((c) => c.includes(`--name ${proxy.container}`)));
  });

  // One created by hand, or before redkite recorded what it created from. It
  // cannot be said to match, so it is rebuilt once rather than trusted forever
  it("recreates a service it does not recognise", async () => {
    const redis = topology.services.find((service) => service.name === "redis")!;
    const { host } = await run({ existing: [redis.container] });

    assert.ok(host.commands.some((c) => c.includes(`--name ${redis.container}`)));
  });

  // The whole point: changing what nginx publishes has to reach the container
  it("recreates the proxy when the published port changes", async () => {
    const moved = {
      ...config,
      environments: {
        ...config.environments,
        staging: { ...config.environments.staging, publicPort: 4100 },
      },
    };

    const before = fingerprints()[topology.router.container]!;
    const after = fingerprintOf(
      plannedServices(moved, topologyFor(moved, "staging"))[0]!,
      topologyFor(moved, "staging"),
    );

    assert.notEqual(before, after);
  });

  // The proxy is derived from the app list rather than listed beside redis,
  // so a deployment cannot be written that routes to apps without one
  it("publishes only the derived proxy, with every host it must resolve", async () => {
    const { host } = await run();
    const creates = host.commands.filter((c) => c.startsWith("container create"));
    const published = creates.filter((c) => c.includes("-p "));

    assert.equal(published.length, 1);
    assert.ok(published[0]!.includes(`--name ${topology.router.container}`));
    assert.match(published[0]!, new RegExp(`-p ${topology.publicPort}:3000`));

    for (const [name, ip] of Object.entries(topology.extraHosts)) {
      assert.match(published[0]!, new RegExp(`--add-host ${name}:${ip}`));
    }
  });

  it("gives a service the volume its image would otherwise leave anonymous", async () => {
    const redis = topology.services.find((service) => service.name === "redis")!;
    const { host } = await run();
    const create = host.commands.find((c) => c.includes(`--name ${redis.container}`))!;

    assert.equal(redis.volumes.length, 1);
    assert.match(create, new RegExp(`-v ${redis.container}-data:/data`));
  });

  it("never lets an app resolve its own name to the live address", async () => {
    const { host } = await run();
    const create = host.commands.find((c) => c.includes(`--name ${back.container} `))!;

    assert.doesNotMatch(create, new RegExp(`--add-host ${back.container}:`));
    assert.doesNotMatch(create, new RegExp(`--add-host ${back.retired}:`));
    // But it must still reach the other app and the services
    assert.match(create, new RegExp(`--add-host ${front.container}:`));
    assert.match(create, new RegExp("--add-host redis:"));
  });
});

// A service the image will not start without credentials for, so the config
// carries a pointer and the deploy resolves it
describe("a service with secrets", () => {
  const withPostgres: Deployment = {
    ...config,
    services: [...config.services, postgres({ secrets: bitwarden("pg"), environment: { POSTGRES_DB: "acme" } })],
  };

  async function run() {
    const host = fakeHost();

    for (const [container, body] of Object.entries(HEALTHY)) host.respond(container, body);

    await deploy({
      config: withPostgres,
      environment: "staging",
      host: host.host,
      secrets: { bitwarden: { read: async () => "POSTGRES_PASSWORD=hunter2\n" } },
      health: { sleep: async () => {} },
    });

    return host;
  }

  it("hands the credentials over as a file rather than an argument", async () => {
    const host = await run();
    const create = host.commands.find((c) => c.includes("--name acme-staging-postgres"))!;

    assert.match(create, /--env-file \/tmp\/redkite\/services\/acme-staging-postgres\/env/);
    assert.doesNotMatch(create, /hunter2/);
    assert.equal(
      host.files.get("services/acme-staging-postgres/env"),
      "POSTGRES_PASSWORD=hunter2\n",
    );
  });

  it("passes the settings that are not credentials as plain variables", async () => {
    const host = await run();
    const create = host.commands.find((c) => c.includes("--name acme-staging-postgres"))!;

    assert.match(create, /-e POSTGRES_DB=acme/);
  });

  it("names the volume the image would otherwise leave anonymous", async () => {
    const host = await run();
    const create = host.commands.find((c) => c.includes("--name acme-staging-postgres"))!;

    assert.match(create, /-v acme-staging-postgres-data:\/var\/lib\/postgresql\/data/);
  });
});
