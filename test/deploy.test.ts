import assert from "node:assert/strict";
import { describe, it } from "node:test";

import config from "./deployment.js";
import type { Deployment, Log } from "../src/index.js";
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
      `container create --name ${back.container} --hostname ${back.container} -v ${back.volumes[0]!.volume}:/app/logs --network ${topology.network} --add-host ${front.container}:${front.currentAddress} --add-host ${front.retired}:${front.retiredAddress} --add-host redis:${topology.services[0]!.address} --env-file /tmp/redkite/apps/backend/env -e PM2_HOME=/app/logs/pm2 --ip ${back.currentAddress} --restart unless-stopped ${back.container}`,
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

  // The step runs on the deploy host, so it reaches the database the same way
  // that machine does
  it("runs the migration in the builder image, on the host's own network", async () => {
    const { host } = await run({ existing: [back.container] });
    const migration = host.commands.find((c) => c.includes("yarn db:migrate"))!;

    assert.match(migration, /^run --rm --network host --env-file \S+ --workdir \/app /);
    assert.match(migration, new RegExp(`${back.container}-builder:`));
  });

  // Nothing from the vault is in the image any more, so a migration that was
  // not handed one would run with no database url at all
  it("hands the migration the environment the image no longer carries", async () => {
    const { host } = await run({ existing: [back.container] });
    const migration = host.commands.find((c) => c.includes("yarn db:migrate"))!;

    assert.match(migration, /--env-file \/tmp\/redkite\/apps\/backend\/env/);

    const written = host.files.get("apps/backend/env");
    assert.equal(written, "DATABASE_URL=postgres://user:pw@db.internal:5432/app\n");
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

  // A step in an environment file is at an ordinary point, so it replaces the
  // deployment's there. Only the command the host was given can show which ran
  it("runs the environment's migration in place of the deployment's", async () => {
    const environments = config.environments ?? {};
    const host = fakeHost({ existing: [back.container] });
    for (const [container, body] of Object.entries(HEALTHY)) host.respond(container, body);

    const own = migrate({ app: "backend", command: "yarn db:migrate:staging" });

    await deploy({
      config: {
        ...config,
        environments: { ...environments, staging: { ...environments["staging"]!, steps: [own] } },
      },
      environment: "staging",
      host: host.host,
      secrets,
      health: { sleep: async () => {} },
    });

    const migrations = host.commands.filter((c) => c.includes("yarn db:migrate"));

    assert.equal(migrations.length, 1, "one migration, not the shared one as well");
    assert.match(migrations[0]!, /yarn db:migrate:staging$/);
  });

  // The file the container is created from is what the running process sees,
  // so this is where another environment's item would do its damage
  it("hands the container the environment's own item, and never another's", async () => {
    const environments = config.environments ?? {};
    const host = fakeHost({ existing: [back.container] });
    for (const [container, body] of Object.entries(HEALTHY)) host.respond(container, body);

    const read = async (id: string) => {
      if (id === "staging-only") return "FROM=staging\n";
      if (id === "production-only") return "FROM=production\n";
      return "DATABASE_URL=postgres://user:pw@db.internal:5432/app\n";
    };

    await deploy({
      config: {
        ...config,
        environments: {
          ...environments,
          staging: { ...environments["staging"]!, secrets: { backend: bitwarden.item("staging-only") } },
          production: { ...environments["production"]!, secrets: { backend: bitwarden.item("production-only") } },
        },
      },
      environment: "staging",
      host: host.host,
      secrets: { bitwarden: { read } },
      health: { sleep: async () => {} },
    });

    const written = host.files.get("apps/backend/env") ?? "";

    assert.match(written, /^FROM=staging$/m);
    assert.doesNotMatch(written, /production/);
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

  // A first deploy has nothing behind it. Reverting used to reach for a
  // container that never existed and fail with "it does not exist", which
  // turned an unhealthy first release into a crash with no verdict
  it("reverts a first deploy that never came up, without a container to put back", async () => {
    const { result, host } = await run({
      bodies: { ...HEALTHY, [back.container]: '{"status":"down"}' },
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.reverted.sort(), [back.container, front.container].sort());

    // Parked under its own name. The swap starts it once to probe it, and the
    // revert must not reach for it again once the name has moved
    assert.ok(host.commands.includes(`container rename ${back.container} ${back.failed}`));

    const started = host.commands.filter((c) => c === `container start ${back.container}`);
    assert.equal(started.length, 1);
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
    services: [...config.services, postgres({ secrets: bitwarden.item("pg"), environment: { POSTGRES_DB: "acme" } })],
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

// Every step and everything said under it, in order, so a test can say what a
// person watching would have seen
function recorded() {
  const events: string[] = [];
  const say = (event: string) => {
    events.push(event);
  };

  const log = Object.assign((message: string) => say(`info ${message}`), {
    warn: (message: string) => say(`warn ${message}`),
    fail: (message: string) => say(`fail ${message}`),
    done: (message: string) => say(`done ${message}`),
    step: (label: string) => {
      say(`step ${label}`);

      return {
        detail: (message: string) => say(`${label} · ${message}`),
        line: (message: string) => say(`${label} | ${message}`),
        done: (message?: string) => say(`${label} done ${message ?? ""}`),
        fail: (message: string) => say(`${label} failed ${message}`),
      };
    },
  }) satisfies Log;

  return { log, events };
}

// A clone is where a wrong branch or an unreachable repository shows. Folded
// into the build, it scrolled past without saying what it fetched
describe("cloning each app", () => {
  async function deployWith(options: { config?: Deployment; refuse?: string } = {}) {
    const host = fakeHost({ existing: [back.container] });
    for (const [container, body] of Object.entries(HEALTHY)) host.respond(container, body);
    if (options.refuse) host.refuse(options.refuse);

    const { log, events } = recorded();

    try {
      await deploy({
        config: options.config ?? config,
        environment: "staging",
        host: host.host,
        secrets,
        log,
        health: { sleep: async () => {} },
      });

      return { events, host, error: undefined };
    } catch (error) {
      return { events, host, error };
    }
  }

  const withBackend = (change: (app: Deployment["apps"][number]) => Deployment["apps"][number]) => ({
    ...config,
    apps: config.apps.map((app) => (app.name === "backend" ? change(app) : app)),
  });

  it("clones each app as a step of its own, before building it", async () => {
    const { events } = await deployWith();

    for (const name of ["frontend", "backend"]) {
      const cloning = events.indexOf(`step Cloning ${name}`);
      const building = events.indexOf(`step Building ${name}`);

      assert.ok(cloning >= 0, `a step for cloning ${name}`);
      assert.ok(cloning < building, `and it comes before ${name} builds`);
    }
  });

  it("says which repository and which branch it is cloning, as it starts", async () => {
    const { events } = await deployWith();

    assert.ok(
      events.includes("Cloning backend · git@github.com:acme/backend.git, branch staging"),
      events.filter((event) => event.startsWith("Cloning backend")).join("\n"),
    );
  });

  it("ends the step with the commit it landed on", async () => {
    const { events } = await deployWith();

    assert.ok(
      events.includes("Cloning backend done git@github.com:acme/backend.git, branch staging at abc1234"),
    );
  });

  it("names a pinned tag rather than the environment's branch", async () => {
    const { events } = await deployWith({ config: withBackend((app) => ({ ...app, tag: "v1.2.3" })) });

    assert.ok(events.includes("Cloning backend · git@github.com:acme/backend.git, tag v1.2.3"));
  });

  it("fails the clone, not the build, when the repository cannot be fetched", async () => {
    const { events, error } = await deployWith({
      refuse: "clone --mirror 'git@github.com:acme/backend.git'",
    });

    assert.ok(error, "the run stops");
    assert.ok(
      events.includes("Cloning backend failed backend could not clone git@github.com:acme/backend.git, branch staging"),
    );
    assert.ok(!events.includes("step Building backend"), "and never starts building it");
  });

  it("clones once, and the build does not fetch it again", async () => {
    const { host } = await deployWith();
    const mirrors = host.commands.filter((command) => command.includes("clone --mirror 'git@github.com:acme/backend.git'"));

    assert.equal(mirrors.length, 1);
  });

  it("reads a directory without a clone step, since nothing is cloned", async () => {
    const { events } = await deployWith({
      config: withBackend((app) => ({ ...app, repo: undefined, path: "/srv/backend" })),
    });

    assert.ok(!events.includes("step Cloning backend"));
    assert.ok(events.includes("step Building backend"));
  });
});

// A container that fails its check is renamed out of the way by the revert, and
// the live name goes back to the release before it. What it printed on the way
// down is the reason it failed, and nothing else was keeping it
describe("when a health check fails", () => {
  const BACK_LOGS = [
    "2026-09-14T10:00:01.000Z Listening on 3001",
    "2026-09-14T10:00:02.000Z TypeError: Cannot read properties of undefined (reading 'url')",
  ].join("\n");

  async function failing(options: { bodies?: Record<string, string>; refuse?: string } = {}) {
    const host = fakeHost({ existing: [back.container] });
    const bodies = options.bodies ?? { ...HEALTHY, [back.container]: '{"status":"down"}' };

    for (const [container, body] of Object.entries(bodies)) host.respond(container, body);
    host.logs(back.container, BACK_LOGS);
    host.logs(front.container, "2026-09-14T10:00:01.000Z ready on 3000");
    if (options.refuse) host.refuse(options.refuse);

    const { log, events } = recorded();

    const result = await deploy({
      config,
      environment: "staging",
      host: host.host,
      secrets,
      log,
      health: { sleep: async () => {} },
    });

    return { result, events, host };
  }

  it("writes out what every new container printed", async () => {
    const { events } = await failing();

    assert.ok(events.includes(`Logs of backend | ${BACK_LOGS.split("\n")[1]}`));
    assert.ok(events.includes("Logs of frontend | 2026-09-14T10:00:01.000Z ready on 3000"));
  });

  it("reads them before the revert gives the live name back to the old release", async () => {
    const { host } = await failing();

    const read = host.commands.findIndex((c) => c.startsWith("container logs") && c.includes(back.container));
    const renamed = host.commands.findIndex((c) => c === `container rename ${back.container} ${back.failed}`);

    assert.ok(read >= 0, "the logs were read");
    assert.ok(renamed >= 0, "and the revert renamed it away");
    assert.ok(read < renamed, "first");
  });

  it("marks the container that failed its check, and only that one", async () => {
    const { events } = await failing();

    assert.ok(
      events.includes(`Logs of backend failed 2 lines from ${back.container}, which failed its health check`),
    );
    assert.ok(events.includes(`Logs of frontend done 1 lines from ${front.container}`));
  });

  it("asks for the last 200 lines of both streams, stamped", async () => {
    const { host } = await failing();

    assert.ok(
      host.commands.includes(`container logs --tail 200 --timestamps ${back.container} 2>&1`),
    );
  });

  it("reads nothing when every check passes", async () => {
    const { host, events } = await failing({ bodies: HEALTHY });

    assert.ok(!host.commands.some((c) => c.startsWith("container logs")));
    assert.ok(!events.some((event) => event.startsWith("step Logs of")));
  });

  it("still reverts when the logs cannot be read", async () => {
    const { result, events } = await failing({ refuse: "container logs" });

    assert.equal(result.ok, false);
    assert.deepEqual(result.reverted.sort(), [back.container, front.container].sort());
    assert.ok(events.some((event) => event.startsWith(`Logs of backend failed could not read the logs of ${back.container}`)));
  });
});
