import { build, type BuildContext, type BuildResult } from "./build.js";
import { Docker } from "./docker.js";
import { healthcheck, type HealthDeps } from "./health.js";
import type { Host } from "./host.js";
import { silent, type Log } from "./log.js";
import { renderNginx } from "./nginx.js";
import {
  defineStep,
  merge,
  runPipeline,
  type AnyStep,
  type Built,
  type BuiltApp,
  type Context,
  type Finished,
  type Prepared,
  type Released,
  type Start,
} from "./pipeline.js";
import { readEnv, readRef, type SecretStores } from "./secrets/refs.js";
import { ensureService } from "./services/ensure.js";
import { topologyFor, type AppTopology, type Topology } from "./topology.js";
import type { AppSpec, Deployment, ServiceSpec } from "./types.js";

// Blue-green, as the four steps redkite puts in the pipeline. The order is the
// whole contract: bring the host up, build everything, run before-swap steps
// while the old containers still serve, move addresses, check, revert or stop.
//
// Nothing here is privileged. Each of these is an ordinary step at an ordinary
// point, and a deployment that registers its own at the same point replaces it.

export type DeployOptions = {
  config: Deployment;
  environment: string;
  // The machine the containers run on, and which now builds them too
  host: Host;
  // One store per provider named by a ref in the config
  secrets: SecretStores;
  health: Omit<HealthDeps, "probe">;
  log?: Log;
  // Prints what each build wrote, line by line as it runs
  verbose?: boolean;
};

export async function deploy(options: DeployOptions): Promise<Finished> {
  const log = options.log ?? silent;

  const setting: Omit<Context, "task"> = {
    config: options.config,
    environment: options.environment,
    topology: topologyFor(options.config, options.environment),
    host: options.host,
    docker: new Docker(options.host),
    secrets: options.secrets,
    log,
  };

  assertBeforeSwapReachable(options.config, options.environment);

  const steps = merge(supplied(options), options.config.steps ?? []);
  return await runPipeline(steps, setting);
}

// The four redkite puts in the pipeline, in the order it puts them
function supplied(options: DeployOptions): AnyStep[] {
  return [
    defineStep("setup", prepare),
    defineStep("build", (input, context) => compile(input, context, options.verbose ?? false)),
    defineStep("deploy", (input, context) => release(input, context, options.health)),
    defineStep("cleanup", finish),
  ];
}

// The network and the services, which outlive a run and are only built when
// they are missing. This used to overlap the builds, and now costs the round
// trips it takes rather than nothing, which is what buys a setup step a host
// it can rely on
async function prepare(input: Start, context: Context): Promise<Prepared> {
  const { docker, topology } = context;

  await docker.network.create(topology.network, topology.cidr);
  const services = await ensureServices(context);

  return { ...input, network: topology.network, services };
}

// Every image is built before anything is disturbed. A build failure has to
// leave the running deployment exactly as it was, which is why this is a step
// of its own rather than the first half of the swap
async function compile(
  input: Prepared,
  context: Context,
  verbose: boolean,
): Promise<Built> {
  return { ...input, apps: (await buildAll(context, verbose)).map(describe) };
}

async function release(
  input: Built,
  context: Context,
  health: DeployOptions["health"],
): Promise<Released> {
  const { docker, task, topology } = context;

  // Runs in the image that was just built, against the database the old
  // containers are still serving from. It throws, so nothing retires
  for (const app of context.config.apps) {
    if (!app.beforeSwap) continue;

    task.detail(`${app.name}: ${app.beforeSwap.command.join(" ")}`);
    await runBeforeSwap(app, built(input, app.name), docker);
  }

  const apps = context.config.apps.map((app) => appOf(topology, app.name));

  task.detail("retiring the running containers");
  await Promise.all(apps.map((app) => retire(docker, topology, app)));

  task.detail("creating the new ones");
  await Promise.all(apps.map((app) => create(docker, topology, app)));

  task.detail("starting them");
  await Promise.all(apps.map((app) => docker.container.start(app.container)));

  // One unhealthy app reverts all of them. A half-swapped deployment is the
  // one state nothing downstream knows how to reason about
  if (!(await checkAll(context, health))) {
    context.log.fail("Health checks failed, reverting");
    await Promise.all(apps.map((app) => revert(docker, topology, app)));

    return { ...input, ok: false, released: [], reverted: apps.map((app) => app.container) };
  }

  return { ...input, ok: true, released: apps.map((app) => app.container), reverted: [] };
}

// A build leaves its image on the host rather than sending one, so without this
// every run adds a runtime image and a builder to a disk nobody is watching
async function finish(input: Released, context: Context): Promise<Finished> {
  // What would be removed is what is serving, and the images are what a retry
  // would be built from
  if (!input.ok) return { ...input, removed: [], reclaimed: [] };

  const { docker, topology } = context;
  const apps = context.config.apps.map((app) => appOf(topology, app.name));

  const removed = await Promise.all(apps.map((app) => cleanup(docker, app)));
  const reclaimed = await Promise.all(input.apps.map((app) => reclaim(docker, app)));

  return { ...input, removed: removed.flat(), reclaimed: reclaimed.flat() };
}

// A deployment may replace the build step, and a before-swap command has to run
// in an image something actually produced
function built(input: Built, name: string) {
  const app = input.apps.find((item) => item.name === name);
  if (app) return app;

  throw new Error(`${name} has a before-swap step, but nothing built an image for it`);
}

function describe({ app, result }: Built0): BuiltApp {
  return {
    name: app.name,
    container: result.tag.split(":")[0] ?? app.name,
    release: result.release,
    fingerprint: result.fingerprint,
    cached: result.cached,
    builderTag: result.builderTag,
  };
}

async function checkAll(context: Context, health: DeployOptions["health"]) {
  const { docker, log, topology } = context;

  const results = await Promise.all(
    context.config.apps.map(async (app) => {
      const target = appOf(topology, app.name);
      const deps: HealthDeps = {
        ...health,
        probe: async (container, url) => {
          const result = await docker.run(`exec ${container} curl -s ${url}`);
          return { code: result.code, output: result.stdout };
        },
        log,
      };

      return await healthcheck(target.container, target.port, app.health, deps);
    }),
  );

  return !results.includes(false);
}

// The before-swap step runs on the deploy host, which is the bastion a config
// written against the tunnelled pipeline names. Anything else has no route
function assertBeforeSwapReachable(config: Deployment, environment: string) {
  const bastion = config.environments[environment]?.host?.bastion;

  for (const app of config.apps) {
    const tunnel = app.beforeSwap?.tunnel;
    if (!tunnel || tunnel.bastion === bastion) continue;

    throw new Error(
      `${app.name} tunnels its before-swap step through ${tunnel.bastion}, ` +
        `but ${environment} deploys to ${bastion ?? "this machine"}. ` +
        "The step runs on the deploy host, so they have to be the same",
    );
  }
}

async function ensureServices(context: Context) {
  const { config, topology } = context;

  const proxy = ensureService(router(config), topology.router, {
    ...context,
    files: {
      "/etc/nginx/conf.d/default.conf": renderNginx(topology, config.maxBodySize),
    },
    publish: topology.publicPort,
  });

  const rest = config.services.map(async (spec) => {
    const service = topology.services.find((item) => item.name === spec.name);
    if (!service) throw new Error(`No topology for service ${spec.name}`);

    await ensureService(spec, service, { ...context, files: spec.files ?? {} });
    return service.container;
  });

  await proxy;
  return [topology.router.container, ...(await Promise.all(rest))];
}

// Not something a deployment lists. Apps carry routes, routes need a proxy to
// resolve them, and the one that renders them is this
function router(config: Deployment): ServiceSpec {
  return {
    name: "nginx",
    image: config.proxyImage ?? "nginx:stable",
    restart: "always",
  };
}

type Built0 = { app: AppSpec; result: BuildResult };

async function buildAll(context: Context, verbose: boolean): Promise<Built0[]> {
  const { config, log, topology } = context;
  const environment = config.environments[context.environment];

  if (!environment) throw new Error(`Unknown environment ${context.environment}`);

  return await Promise.all(
    config.apps.map(async (app) => {
      const task = log.step(`Building ${app.name}`);

      try {
        const buildContext: BuildContext = {
          host: context.host,
          docker: context.docker,
          env: await readEnv(app.secrets, context.secrets),
          files: await resolveFiles(app, context.secrets),
          branch: environment.branch,
          environment: context.environment,
          detail: task.detail,
          output: verbose ? (line) => log(`  ${app.name} │ ${line}`) : undefined,
        };

        const result = await build(app, appOf(topology, app.name), buildContext);
        task.done(`${result.release.slice(0, 7)}${result.cached ? " (held)" : ""}`);

        return { app, result };
      } catch (error) {
        task.fail(`${app.name} failed to build`);
        throw error;
      }
    }),
  );
}

async function resolveFiles(app: AppSpec, stores: SecretStores) {
  const entries = await Promise.all(
    Object.entries(app.files ?? {}).map(
      async ([path, ref]) => [path, await readRef(ref, stores)] as const,
    ),
  );

  return Object.fromEntries(entries);
}

// Host networking, because the deploy host is the one machine that can already
// reach whatever the app's own environment file points at
async function runBeforeSwap(app: AppSpec, image: BuiltApp, docker: Docker) {
  const step = app.beforeSwap;
  if (!step) return;

  if (!image.builderTag) {
    throw new Error(`${app.name} has a before-swap step but no builder image`);
  }

  await docker.runOrThrow(
    ["run --rm --network host --workdir /app", image.builderTag, ...step.command].join(" "),
    `${app.name} before-swap step failed`,
  );
}

// Move the running container out of the way without stopping it, so it keeps
// answering on the retired address while the new one starts
async function retire(docker: Docker, topology: Topology, app: AppTopology) {
  await docker.container.stop(app.retired);
  await docker.container.remove(app.retired);
  await docker.network.reconnect(topology.network, app.container, app.retiredAddress);
  await docker.container.rename(app.container, app.retired);
}

async function create(docker: Docker, topology: Topology, app: AppTopology) {
  const builder = docker.container
    .builder()
    .name(app.container)
    .image(app.container)
    .network(topology.network)
    .ip(app.currentAddress)
    .restart("unless-stopped");

  for (const [host, ip] of Object.entries(topology.extraHosts)) {
    // An app resolving its own name to the live address would loop
    if (host === app.container || host === app.retired) continue;
    builder.extraHost(host, ip);
  }

  for (const volume of app.volumes) builder.volume(volume.volume, volume.mountPath);

  await builder.create();
}

// Put the retired container back on the live address and its original name
async function revert(docker: Docker, topology: Topology, app: AppTopology) {
  await docker.container.stop(app.container);
  await docker.container.rename(app.container, app.failed);
  await docker.network.reconnect(topology.network, app.retired, app.currentAddress);
  await docker.container.rename(app.retired, app.container);
  await docker.container.start(app.container);
}

async function cleanup(docker: Docker, app: AppTopology) {
  const removed: string[] = [];

  for (const name of [app.retired, app.failed]) {
    await docker.container.stop(name);
    if (await docker.container.remove(name)) removed.push(name);
  }

  return removed;
}

// Every version of this app's images except the one that was just released,
// including the builder a before-swap step ran in
async function reclaim(docker: Docker, app: BuiltApp) {
  const version = `${app.release}-${app.fingerprint}`;
  const reclaimed: string[] = [];

  for (const repository of [app.container, `${app.container}-builder`]) {
    for (const held of await docker.image.versionsOf(repository)) {
      if (held === `${repository}:${version}`) continue;

      await docker.image.remove(held);
      reclaimed.push(held);
    }
  }

  return reclaimed;
}

function appOf(topology: Topology, name: string) {
  const app = topology.apps.find((item) => item.name === name);
  if (app) return app;

  throw new Error(`No topology for app ${name}`);
}
