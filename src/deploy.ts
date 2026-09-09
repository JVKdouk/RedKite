import { build, type BuildContext, type BuildResult } from "./build.js";
import { assertCheckable, runChecks } from "./checks.js";
import { environmentOf } from "./config.js";
import { Docker } from "./docker.js";
import { envFileFor } from "./environment.js";
import { healthcheck, type HealthDeps } from "./health.js";
import { finalHost, type Host } from "./host.js";
import { localHost } from "./localHost.js";
import { silent, type Log } from "./log.js";
import {
  defineStep,
  merge,
  runPipeline,
  type AnyStep,
  type Built,
  type BuiltApp,
  type Context,
  type Finished,
  type Plan,
  type Prepared,
  type Released,
  type Run,
  type Start,
} from "./pipeline.js";
import { pluginSteps } from "./plugin.js";
import { readEnv, readRef, type SecretStores } from "./secrets/refs.js";
import { ensureService } from "./services/ensure.js";
import { plannedServices } from "./services/planned.js";
import { topologyFor, type AppTopology, type Topology } from "./topology.js";
import type { AppSpec, Deployment } from "./types.js";

// The runs redkite offers, and the steps it supplies to them. A deploy is
// blue-green: bring the host up, build everything, move addresses, check,
// revert or stop. A verify stops after the build and runs what the apps declare
// instead of swapping, which is the same host and the same images without the
// half of it that touches what is serving.
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
  // How the probe waits between attempts. Absent means a real wait, which is
  // what everything but a test wants
  health?: Omit<HealthDeps, "probe">;
  log?: Log;
  // Prints what each build wrote, line by line as it runs
  verbose?: boolean;
  // Stops the run. Whatever command is in flight is killed, and the pipeline
  // unwinds through its own failure path rather than through an exit
  signal?: AbortSignal;
};

export async function deploy(options: DeployOptions): Promise<Finished> {
  return await start("deploy", options);
}

// The same host, the same services and the same images, stopping where a deploy
// would start moving addresses. What runs instead is what each app declares
export async function verify(options: DeployOptions): Promise<Finished> {
  return await start("verify", options);
}

async function start(run: Run, options: DeployOptions): Promise<Finished> {
  const log = options.log ?? silent;

  const setting: Omit<Context, "task"> = {
    config: options.config,
    environment: options.environment,
    topology: topologyFor(options.config, options.environment),
    host: options.host,
    docker: new Docker(options.host),
    secrets: options.secrets,
    log,
    run,
  };

  // A plugin's steps lead, so a snapshot listed as a plugin runs above the
  // migration the deployment writes after it
  const added = [...pluginSteps(options.config.plugins), ...(options.config.steps ?? [])];

  return await runPipeline(run, merge(supplied(options), added), setting, options.signal);
}

// Every step redkite supplies, in the order the phases name. A run walks the
// phases it has, so the ones it does not are never ordered in
function supplied(options: DeployOptions): AnyStep[] {
  return [
    defineStep("setup", prepare),
    defineStep("build", (input, context) =>
      compile(input, context, options.verbose ?? false, options.signal),
    ),
    defineStep("verify", runChecks, assertCheckable),
    defineStep(
      "swap",
      (input, context) => release(input, context, options.health ?? { sleep: wait }),
      assertPublishable,
    ),
    defineStep("cleanup", finish),
  ];
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// A deploy publishes the proxy on a port, and an environment written for verify
// alone has no reason to name one. Checked before the run so the mistake lands
// before a build rather than on a proxy nobody outside can reach
function assertPublishable(plan: Plan) {
  if (environmentOf(plan.config, plan.environment)?.publicPort) return;

  throw new Error(
    `${plan.environment} names no publicPort, so a deploy has nothing to publish ` +
      "the proxy on. Only a verify run goes without one",
  );
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
  signal?: AbortSignal,
): Promise<Built> {
  // One checkout directory for every app, opened here so the build step owns
  // its lifetime rather than the process
  const here = buildsHere(context) ? await localHost({ signal }) : undefined;

  try {
    return { ...input, apps: (await buildAll(context, verbose, here)).map(describe) };
  } finally {
    await here?.close?.();
  }
}

// Building here and deploying here are the same daemon, so shipping would be a
// save and a load of an image that never moved. An app built from a path on
// this machine has no say in it: the source is here, so the build is too
function buildsHere(context: Context) {
  const environment = environmentOf(context.config, context.environment);
  if (!environment?.host?.bastion) return false;

  return environment.buildOn === "local" || context.config.apps.some((app) => app.path);
}

async function release(
  input: Built,
  context: Context,
  health: Omit<HealthDeps, "probe">,
): Promise<Released> {
  const { docker, task, topology } = context;
  const apps = context.config.apps.map((app) => appOf(topology, app.name));

  // Keyed by name rather than by index: appOf resolves the topology, and two
  // lists walked in step is a bug waiting for someone to reorder one
  const environments = new Map(
    context.config.apps.map((app) => [app.name, app.environment ?? {}]),
  );

  // Resolved now and handed over when the container is made. Nothing from the
  // vault is in the image, so this is the only way the running process sees it
  const files = new Map(
    await Promise.all(
      context.config.apps.map(
        async (app) => [app.name, await envFileFor(app, context)] as const,
      ),
    ),
  );

  // What has actually been moved, rather than what was going to be. A stop
  // lands between two docker commands, and only this says which side of it
  const moved: AppTopology[] = [];

  try {
    task.detail("retiring the running containers");

    await Promise.all(
      apps.map(async (app) => {
        await retire(docker, topology, app);
        moved.push(app);
      }),
    );

    task.detail("creating the new ones");

    await Promise.all(
      apps.map((app) =>
        create(docker, topology, app, environments.get(app.name), files.get(app.name)),
      ),
    );

    task.detail("starting them");
    await Promise.all(apps.map((app) => docker.container.start(app.container)));

    // Inside, because the swap is not over until this says so. A stop lands
    // here more often than anywhere else: it is the longest part, and by now
    // every address has already moved
    if (!(await checkAll(context, health))) {
      context.log.fail("Health checks failed, reverting");
      await Promise.all(apps.map((app) => revert(docker, topology, app)));

      return {
        ...input,
        ok: false,
        released: [],
        reverted: apps.map((app) => app.container),
        checked: [],
      };
    }
  } catch (error) {
    // Whatever ended this, the addresses have moved and something has to put
    // them back. A stop is the usual one, so the revert runs on a host that
    // has been told to stop: it is the abort that made this necessary
    if (moved.length > 0) {
      context.log.fail(`Putting ${moved.length} back where they were`);
      await putBack(context, moved);
    }

    throw error;
  }

  return {
    ...input,
    ok: true,
    released: apps.map((app) => app.container),
    reverted: [],
    checked: [],
  };
}

// Through a host with the stop lifted, because the commands that undo a swap
// cannot be refused by the same signal that interrupted it. One app failing to
// go back must not stop the others, so each is settled on its own
async function putBack(context: Context, moved: AppTopology[]) {
  const docker = new Docker(finalHost(context.host));

  const put = moved.map(async (app) => {
    try {
      await revert(docker, context.topology, app);
    } catch (error) {
      context.log.fail(`${app.container} could not be put back: ${String(error)}`);
    }
  });

  await Promise.all(put);
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

async function checkAll(context: Context, health: Omit<HealthDeps, "probe">) {
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

// The proxy is one of these, derived rather than listed. What each should be
// is worked out in one place, so a plan reports drift against the same shape a
// deploy converges to
async function ensureServices(context: Context) {
  const planned = plannedServices(context.config, context.topology, context.run);

  return await Promise.all(
    planned.map(async (item) => {
      await ensureService(item.spec, item.service, {
        ...context,
        files: item.files,
        publish: item.publish,
      });

      return item.service.container;
    }),
  );
}

type Built0 = { app: AppSpec; result: BuildResult };

async function buildAll(
  context: Context,
  verbose: boolean,
  here?: Host,
): Promise<Built0[]> {
  const { config, log, topology } = context;
  const environment = environmentOf(config, context.environment);

  if (!environment) throw new Error(`Unknown environment ${context.environment}`);

  return await Promise.all(
    config.apps.map(async (app) => {
      const task = log.step(`Building ${app.name}`);

      try {
        // Said before the reads rather than after them. Every ref is a call to
        // the vault, and a step that has not spoken yet looks like one that is
        // not doing anything
        task.detail("reading its environment");
        const env = await readEnv(app.secrets, context.secrets);

        task.detail("reading the files it ships with");
        const files = await resolveFiles(app, context.secrets);

        const buildContext: BuildContext = {
          host: here ?? context.host,
          docker: here ? new Docker(here) : context.docker,
          deliver: here && { host: context.host, docker: context.docker },
          env,
          files,
          branch: environment.branch,
          environment: context.environment,
          // Forwarded to the deploy host by the connection, so what this
          // process holds is what the build there can reach
          agent: Boolean(process.env["SSH_AUTH_SOCK"]),
          detail: task.detail,
          output: task.line,
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

// Move the running container out of the way without stopping it, so it keeps
// answering on the retired address while the new one starts
async function retire(docker: Docker, topology: Topology, app: AppTopology) {
  await docker.container.stop(app.retired);
  await docker.container.remove(app.retired);
  await docker.network.reconnect(topology.network, app.container, app.retiredAddress);
  await docker.container.rename(app.container, app.retired);
}

async function create(
  docker: Docker,
  topology: Topology,
  app: AppTopology,
  environment: Record<string, string> = {},
  envFile?: string,
) {
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

  if (envFile) builder.envFile(envFile);

  for (const volume of app.volumes) builder.volume(volume.volume, volume.mountPath);
  for (const [name, value] of Object.entries(environment)) builder.env(name, value);

  await builder.create();
}

// Put the retired container back on the live address and its original name.
// Answers with whether there was one: a first deploy has nothing behind it, and
// the container that just failed is simply left where it was renamed to
export async function revert(docker: Docker, topology: Topology, app: AppTopology) {
  await docker.container.stop(app.container);

  // The slot may still hold what an earlier interrupted run put there, and a
  // rename refuses rather than clobbers. Retiring clears its own slot the same
  // way, and a revert that skipped this would leave the new container live
  await docker.container.stop(app.failed);
  await docker.container.remove(app.failed);

  await docker.container.rename(app.container, app.failed);

  if (!(await docker.container.exists(app.retired))) return false;

  await docker.network.reconnect(topology.network, app.retired, app.currentAddress);
  await docker.container.rename(app.retired, app.container);
  await docker.container.start(app.container);

  return true;
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
// including the builder a step before the swap ran in
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
