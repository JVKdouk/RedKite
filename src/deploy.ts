import { build, refOf, sourceOf, type BuildContext, type BuildResult } from "./build.js";
import { assertCheckable, runChecks } from "./checks.js";
import { environmentOf, withEnvironment } from "./config.js";
import { Docker } from "./docker.js";
import { envFileFor } from "./environment.js";
import { healthcheck, type HealthDeps } from "./health.js";
import { finalHost, type Host } from "./host.js";
import { localHost } from "./localHost.js";
import { silent, type Log, type Task } from "./log.js";
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
import { describeRef, describeRepo, type Source } from "./source.js";
import { topologyFor, type AppTopology, type Topology } from "./topology.js";
import type { AppSpec, Deployment } from "./types.js";

// Blue-green: bring the host up, build, move addresses, check, revert or stop. A verify stops after the build

export type DeployOptions = {
  config: Deployment;
  environment: string;
  // The machine the containers run on, and which builds them too
  host: Host;
  // One store per provider named by a ref in the config
  secrets: SecretStores;
  // How the probe waits between attempts. Absent means a real wait
  health?: Omit<HealthDeps, "probe">;
  log?: Log;
  // Prints what each build wrote, line by line as it runs
  verbose?: boolean;
  // Kills what is in flight, unwinding through the pipeline's own failure path
  signal?: AbortSignal;
};

export async function deploy(options: DeployOptions): Promise<Finished> {
  return await start("deploy", options);
}

// Stops where a deploy would start moving addresses, running the apps' own checks
export async function verify(options: DeployOptions): Promise<Finished> {
  return await start("verify", options);
}

async function start(run: Run, options: DeployOptions): Promise<Finished> {
  const log = options.log ?? silent;
  const config = withEnvironment(options.config, options.environment);

  const setting: Omit<Context, "task"> = {
    config,
    environment: options.environment,
    topology: topologyFor(config, options.environment),
    host: options.host,
    docker: new Docker(options.host),
    secrets: options.secrets,
    log,
    run,
  };

  // A plugin's steps lead, so a snapshot runs above the deployment's migration
  const added = [...pluginSteps(config.plugins), ...(config.steps ?? [])];

  return await runPipeline(run, merge(supplied(options), added), setting, options.signal);
}

// A run walks the phases it has, so the rest are never ordered in
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

// Checked before the run, so a verify-only environment fails before a build
function assertPublishable(plan: Plan) {
  // Without a proxy each app's port is the way in, and none is required
  if (plan.config.proxy === false) return;
  if (environmentOf(plan.config, plan.environment)?.publicPort) return;

  throw new Error(
    `${plan.environment} names no publicPort, so a deploy has nothing to publish ` +
      "the proxy on. Only a verify run goes without one",
  );
}

// Outlive a run and are built only when missing, so a setup step can rely on them
async function prepare(input: Start, context: Context): Promise<Prepared> {
  const { docker, topology } = context;

  await docker.network.create(topology.network, topology.cidr);

  // An earlier proxy would hold the public port with nothing left to stop it
  if (context.config.proxy === false) {
    await docker.container.stop(topology.router.container);
    await docker.container.remove(topology.router.container);
  }

  const services = await ensureServices(context);

  return { ...input, network: topology.network, services };
}

// A step of its own, so a build failure leaves the running deployment untouched
async function compile(
  input: Prepared,
  context: Context,
  verbose: boolean,
  signal?: AbortSignal,
): Promise<Built> {
  // Opened here, so the build step owns its lifetime rather than the process
  const here = buildsHere(context) ? await localHost({ signal }) : undefined;

  try {
    return { ...input, apps: (await buildAll(context, verbose, here)).map(describe) };
  } finally {
    await here?.close?.();
  }
}

// The same daemon both ends, so shipping would save and load an image that never moved
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

  // Keyed by name, since two lists walked in step breaks when one is reordered
  const environments = new Map(
    context.config.apps.map((app) => [app.name, app.environment ?? {}]),
  );

  // Nothing from the vault is in the image, so this is how the process sees it
  const files = new Map(
    await Promise.all(
      context.config.apps.map(
        async (app) => [app.name, await envFileFor(app, context)] as const,
      ),
    ),
  );

  // A stop lands between two docker commands, and only this says which side
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

    // With no proxy nothing holds traffic, so the app is down until the new one is up
    const published = apps.filter((app) => app.published !== undefined);

    if (published.length > 0) {
      task.detail("stopping the ones whose ports are published");
      await Promise.all(published.map((app) => docker.container.stop(app.retired)));
    }

    task.detail("starting them");
    await Promise.all(apps.map((app) => docker.container.start(app.container)));

    // Inside, because the swap is not over until this says so
    const unhealthy = await checkAll(context, health);

    if (unhealthy.size > 0) {
      context.log.fail("Health checks failed, reverting");

      // Before the revert, or the logs would be the previous release's
      await dumpLogs(context, apps, unhealthy);
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
    // The addresses have moved, so the revert runs on a host already told to stop
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

// Stop lifted, since undoing a swap cannot be refused by what interrupted it
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

// Without this every run adds a runtime image and a builder to the disk
async function finish(input: Released, context: Context): Promise<Finished> {
  // What would be removed is serving, and a retry would be built from those images
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
  const { docker, topology } = context;

  const results = await Promise.all(
    context.config.apps.map(async (app) => {
      const target = appOf(topology, app.name);

      // A step each, so every attempt lands on it and a crash log gives it a file
      const deps: HealthDeps = {
        ...health,
        probe: async (container, url) => {
          const result = await docker.run(`exec ${container} curl -s ${url}`);
          return { code: result.code, output: result.stdout };
        },
        task: context.task.step(`Health check of ${app.name}`),
      };

      const healthy = await healthcheck(target.container, target.port, app.health, deps);
      return healthy ? undefined : target.container;
    }),
  );

  // The containers that failed, since what is written out depends on it
  return new Set(results.filter((container): container is string => container !== undefined));
}

// Enough for a stack trace and what led up to it, not a day of access logs
const LOG_TAIL = 200;

// All of them: a backend that never came up often shows in the frontend's log
async function dumpLogs(context: Context, apps: AppTopology[], unhealthy: Set<string>) {
  await Promise.all(
    apps.map(async (app) => {
      const task = context.task.step(`Logs of ${app.name}`);
      task.detail(`the last ${LOG_TAIL} lines of ${app.container}`);

      const result = await context.docker.container.logs(app.container, LOG_TAIL);

      // Said and left there: unreadable logs are no reason to leave a release serving
      if (result.code !== 0) {
        task.fail(`could not read the logs of ${app.container}: ${result.stdout || result.stderr}`);
        return;
      }

      const lines = result.stdout.split("\n").filter((line) => line.length > 0);
      for (const line of lines) task.line(line);

      const said = `${lines.length} lines from ${app.container}`;
      if (unhealthy.has(app.container)) task.fail(`${said}, which failed its health check`);
      else task.done(said);
    }),
  );
}

// Worked out in one place, so a plan reports drift against what a deploy converges to
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
  const { config, topology } = context;
  const environment = environmentOf(config, context.environment);

  if (!environment) throw new Error(`Unknown environment ${context.environment}`);

  return await Promise.all(
    config.apps.map(async (app) => {
      const placed = appOf(topology, app.name);
      const source = await clone(app, placed, here ?? context.host, environment.branch, context.task);
      const task = context.task.step(`Building ${app.name}`);

      try {
        // Said before the reads: every ref is a call, and a silent step looks idle
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
          // Forwarded by the connection, so the build there reaches what this process holds
          agent: Boolean(process.env["SSH_AUTH_SOCK"]),
          detail: task.detail,
          output: task.line,
        };

        const result = await build(app, placed, buildContext, source);
        task.done(`${result.release.slice(0, 7)}${result.cached ? " (held)" : ""}`);

        return { app, result };
      } catch (error) {
        task.fail(`${app.name} failed to build`);
        throw error;
      }
    }),
  );
}

// Ahead of the build, so a wrong branch or unreachable repository shows here
async function clone(
  app: AppSpec,
  placed: AppTopology,
  host: Host,
  branch: string,
  // The build step, which the clone is drawn under
  parent: Task,
): Promise<Source | undefined> {
  // A directory is read where it is, not cloned
  if (!app.repo) return undefined;

  const ref = refOf(app, branch);
  const what = `${describeRepo(app.repo)} ${describeRef(ref)}`;
  const task = parent.step(`Cloning ${app.name}`);

  try {
    task.detail(what);
    const source = await sourceOf(app, placed, {
      host,
      branch,
      detail: task.detail,
      output: task.line,
    });

    // Said again at the end, where it outlasts the details that replaced it
    task.done(`${what} -> ${source.release.slice(0, 7)}`);
    return source;
  } catch (error) {
    task.fail(`${app.name} could not clone ${what}`);
    throw error;
  }
}

async function resolveFiles(app: AppSpec, stores: SecretStores) {
  const entries = await Promise.all(
    Object.entries(app.files ?? {}).map(
      async ([path, ref]) => [path, await readRef(ref, stores)] as const,
    ),
  );

  return Object.fromEntries(entries);
}

// Moved aside without stopping, so it answers on the retired address meanwhile
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

  // Only without a proxy: the retired container keeps its binding for a revert
  if (app.published !== undefined) builder.port(app.published, app.port);

  await builder.create();
}

// Answers whether there was one: a first deploy has nothing behind it
export async function revert(docker: Docker, topology: Topology, app: AppTopology) {
  await docker.container.stop(app.container);

  // A rename refuses rather than clobbers, so the slot is cleared first
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

// All but the released one, including the builder a pre-swap step ran in
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
