import { environmentOf, withEnvironment } from "../config.js";
import { deploy, verify } from "../deploy.js";
import { Docker } from "../docker.js";
import type { Host } from "../host.js";
import { localHost } from "../localHost.js";
import { silent, type Log } from "../log.js";
import { renderProxy } from "../services/proxy.js";
import { addressOf, RUNS, SLOTS, type Run } from "../pipeline.js";
import { listRefs, type SecretStores } from "../secrets/refs.js";
import { pluginSteps, storeFor } from "../plugin.js";
import { down, rollback } from "../recover.js";
import { driftOf, plannedServices, type Drift } from "../services/planned.js";
import { sshHost } from "../sshHost.js";
import { topologyFor, type Topology } from "../topology.js";
import type { Deployment, DeployHost } from "../types.js";

import { AGENT_STARTED, needsAgent, requireAgent } from "./agent.js";
import { loadConfig, projectRoot } from "./config.js";
import { loadDotenv } from "./dotenv.js";
import { dumpCrash, recording } from "./crash.js";
import { createLog, describeFailure } from "./log.js";

// One command: the agent, the vault, the checkout, the build, the swap, the cleanup

const USAGE = `redkite <command> [environment]

  plan [environment]     Print the derived topology, the pipeline and the nginx
  deploy [environment]   Build, swap, health check, and revert on failure
  verify [environment]   Bring the services up, build, and run each app's checks
  rollback [environment] Put back any app a run moved and did not finish
  down [environment]     Stop everything this environment named

  --config <path>        Defaults to redkite.config.ts at the root of the project
  --local                Build the images here and ship them to the host
  --full                 No step view: every line of every step, in full
  --verbose              Every host command, and every line a build printed
  --version              Print the version and exit

Environment defaults to staging. A deployment is one redkite.config.ts at the root
of the project, and everything below it is derived.
`;

// Wraps a host, so both implementations are measured the same way
function measured(host: Host, say?: (line: string) => void) {
  const totals = { commands: 0, commandMs: 0, files: 0 };

  const wrapped: Host = {
    directory: host.directory,
    cache: host.cache,
    pipe: host.pipe.bind(host),
    stop: host.stop.bind(host),
    final: host.final.bind(host),

    sh: async (command, onLine) => {
      const started = Date.now();
      const result = await host.sh(command, onLine);

      totals.commands += 1;
      totals.commandMs += Date.now() - started;

      // The exit code matters: several of these are allowed to fail
      say?.(`  $ ${command}  ${Date.now() - started}ms exit ${result.code}`);
      return result;
    },

    write: async (name, contents) => {
      totals.files += 1;
      return await host.write(name, contents);
    },

    close: host.close?.bind(host),
  };

  const summary = () =>
    `${totals.commands} commands in ${seconds(totals.commandMs)}, ` +
    `${totals.files} files written`;

  return { host: wrapped, summary };
}

function seconds(ms: number) {
  return `${(ms / 1000).toFixed(1)}s`;
}

// Read, so a published package and a linked checkout answer the same
async function version() {
  const manifest = new URL("../../package.json", import.meta.url);
  const { readFile } = await import("node:fs/promises");
  const { version: found } = JSON.parse(await readFile(manifest, "utf8")) as {
    version: string;
  };

  return found;
}

// Flags taking a value, so it is not mistaken for the environment
const VALUED = new Set(["--config"]);

function flag(argv: string[], name: string) {
  const joined = argv.find((arg) => arg.startsWith(`${name}=`));
  if (joined) return joined.slice(name.length + 1);

  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

export function positional(argv: string[]) {
  const args: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;

    if (!arg.startsWith("--")) {
      args.push(arg);
      continue;
    }

    // Only the two-word form consumes the next item
    if (VALUED.has(arg)) index += 1;
  }

  return args;
}

export async function main(argv: string[]) {
  try {
    return await dispatch(argv);
  } catch (error) {
    // Everything before the view starts, a config that will not load above all
    process.stderr.write(`${describeFailure(error)}\n`);
    process.exitCode = 1;
  }
}

async function dispatch(argv: string[]) {
  const args = positional(argv);
  const command = args[0] ?? "";
  const environment = args[1] ?? "staging";

  if (argv.includes("--version") || command === "version") {
    return process.stdout.write(`${await version()}\n`);
  }

  const configPath = flag(argv, "--config");

  // Only where the environment is silent: what the job set wins over a file
  const read = loadDotenv(projectRoot(configPath), environment);

  if (command === "plan") return await plan(environment, configPath, read);
  if (command === "rollback" || command === "down") {
    return await recover(command, environment, configPath);
  }
  if (command === "deploy" || command === "verify") {
    return await run(command, environment, configPath, {
      verbose: argv.includes("--verbose"),
      full: argv.includes("--full"),
      local: argv.includes("--local"),
    });
  }

  process.stdout.write(USAGE);
  process.exitCode = command ? 1 : 0;
}

// For a run that was killed: both read the host, and both are safe with nothing to do
async function recover(
  command: "rollback" | "down",
  environment: string,
  configPath?: string,
) {
  const config = await loadConfig(configPath);
  const topology = topologyFor(config, environment);
  const deployHost = environmentOf(config, environment)?.host;

  const say = (message = "") => process.stdout.write(`${message}\n`);
  // Printed rather than drawn: a recovery has no view
  if (needsAgent(config, environment) && requireAgent().started) say(AGENT_STARTED);

  const host = await hostFor(deployHost, silent);

  try {
    if (command === "down") {
      const { stopped } = await down({ config, environment, host, log: asLog(say) });

      say(stopped.length === 0 ? "Nothing was running" : `Stopped ${stopped.join(", ")}`);
      return;
    }

    const { restored } = await rollback({ config, environment, host, log: asLog(say) });

    if (restored.length === 0) {
      return say(`Nothing to put back in ${topology.environment}`);
    }

    say(`Put back ${restored.join(", ")}`);
  } finally {
    await host.close?.();
  }
}

// A recovery runs after the view has gone, often in a job being torn down
function asLog(say: (message: string) => void): Log {
  return Object.assign(say, { warn: say, fail: say, done: say, step: () => silent.step("") });
}

async function plan(environment: string, configPath?: string, read: string[] = []) {
  const config = withEnvironment(await loadConfig(configPath), environment);
  const topology = topologyFor(config, environment);

  const say = (message = "") => process.stdout.write(`${message}\n`);

  say(`# ${config.project} · ${environment}\n`);
  if (read.length > 0) say(`read      ${read.join(", ")}`);
  say(`network   ${topology.network}  ${topology.cidr}`);
  say(`branch    ${topology.branch}`);
  say(publishedBy(config, topology));

  const sources = new Map(config.apps.map((app) => [app.name, app.path ?? app.repo]));

  for (const app of topology.apps) {
    say(`app ${app.name}`);
    say(`  source   ${sources.get(app.name) ?? "?"}`);
    say(`  current  ${app.container}  ${app.currentAddress}:${app.port}`);
    say(`  retired  ${app.retired}  ${app.retiredAddress}`);
    if (app.route) say(`  route    ${app.route}`);
    if (app.published) say(`  port     ${app.published} -> ${app.port}`);

    for (const volume of app.volumes) {
      say(`  volume   ${volume.volume} -> ${volume.mountPath}`);
    }

    for (const [name, key] of Object.entries(app.caches)) {
      say(`  cache    ${name} -> ${key}`);
    }

    say();
  }

  for (const service of topology.services) {
    say(`service ${service.name}  ${service.container}  ${service.address}`);

    for (const volume of service.volumes) {
      say(`  volume   ${volume.volume} -> ${volume.mountPath}`);
    }
  }

  // A missing port is what says verify-only; without a proxy each app is its own way in
  const serves = config.proxy === false || Boolean(topology.publicPort);

  sayPlugins(config, say);
  sayPipeline(config, serves, say);
  await sayDrift(config, topology, serves ? "deploy" : "verify", say);

  if (!serves || config.proxy === false) return;

  say(`\n# rendered nginx ${"-".repeat(44)}\n`);
  say(renderProxy(topology, config.proxy));
}

// A verify environment publishes nothing, and a proxyless deployment publishes each app
function publishedBy(config: Deployment, topology: Topology) {
  if (config.proxy !== false) {
    return topology.publicPort
      ? `published ${topology.publicPort} -> ${topology.router.container} ${topology.router.address}\n`
      : "published nothing, this environment has no publicPort\n";
  }

  const apps = topology.apps.filter((app) => app.published !== undefined);
  if (apps.length === 0) return "published nothing, there is no proxy and no app has a port\n";

  const each = apps.map((app) => `${app.published} -> ${app.container}:${app.port}`);
  return `published ${each.join(", ")}, no proxy\n`;
}

// The only part of a plan that needs the host, since services outlive a deploy
async function sayDrift(
  config: Deployment,
  topology: Topology,
  run: Run,
  say: (message?: string) => void,
) {
  say(`\nservices on the host (${run})`);

  const bastion = environmentOf(config, topology.environment)?.host;
  let host: Host | undefined;

  try {
    host = await hostFor(bastion, silent);
    const planned = plannedServices(config, topology, run);
    const drifted = await driftOf(planned, topology, new Docker(host));

    if (drifted.length === 0) return say("  every service is what this file says");
    for (const drift of drifted) say(`  ${drift.container.padEnd(34)}${DRIFT[drift.reason]}`);
    say(`\n  a ${run} converges these`);
  } catch (error) {
    // Saying so beats printing nothing, and beats a clean bill nobody checked
    say(`  not checked: ${describeFailure(error).split("\n")[0]}`);
  } finally {
    await host?.close?.();
  }
}

const DRIFT: Record<Drift["reason"], string> = {
  missing: "not there, will be created",
  stopped: "created from this file, but not running",
  changed: "created from an earlier version of this file",
  unrecognised: "not created by redkite, will be recreated",
};

// A missing vault is why its refs will not resolve, worth seeing before a run
function sayPlugins(config: Deployment, say: (message?: string) => void) {
  const plugins = config.plugins ?? [];
  if (plugins.length === 0) return;

  say("\nplugins");

  for (const plugin of plugins) {
    const stores = Object.keys(plugin.stores ?? {});
    const resolves = stores.length > 0 ? `  resolves ${stores.join(", ")}` : "";
    const count = plugin.steps?.length ?? 0;

    say(`  ${plugin.name}${gap(plugin.name.length)}${count} ${count === 1 ? "step" : "steps"}${resolves}`);
  }
}

const COLUMN = 26;

function gap(width: number) {
  return " ".repeat(Math.max(2, COLUMN - width));
}

// A step is addressed rather than called, so this is where a sequence shows
function sayPipeline(
  config: Deployment,
  serves: boolean,
  say: (message?: string) => void,
) {
  // The plugins' steps and then the deployment's own, as the run walks them
  const steps = [...pluginSteps(config.plugins), ...(config.steps ?? [])];
  const added = new Set(steps.map((step) => step.point));

  // Says which plugin a step came from, which a point alone does not
  const from = new Map(
    (config.plugins ?? []).flatMap((plugin) =>
      (plugin.steps ?? []).map((step) => [step.point, plugin.name] as const),
    ),
  );

  const at = (phase: string, slot: string) =>
    steps.filter((step) => {
      const address = addressOf(step.point);
      return address.phase === phase && address.slot === slot && step.point !== phase;
    });

  const checked = config.apps.filter((app) => app.verify).map((app) => app.name);

  // Both refusals live on a step's check, so a printed run can be asked for
  const runs = Object.entries(RUNS).filter(
    ([run]) => (run === "verify" ? checked.length > 0 : serves),
  );

  if (runs.length === 0) {
    return say(
      "\nno pipeline. This environment publishes nothing, so it cannot deploy, " +
        "and no app declares verify",
    );
  }

  for (const [run, phases] of runs) {
    say(`\npipeline (${run})`);

    for (const phase of phases) {
      for (const slot of SLOTS) {
        // Redkite's own step leads its slot, and a replacement shows here
        if (slot === "main") {
          const who = added.has(phase) ? "replaced" : "redkite";
          const what = phase === "verify" ? `  ${checked.join(", ")}` : "";
          say(`  ${phase.padEnd(26)}${who}${what}`);
        }

        for (const step of at(phase, slot)) {
          const owner = from.get(step.point);
          if (!owner) say(`  ${step.point}`);
          // A point filling the column still gets its two spaces
          else say(`  ${step.point}${gap(step.point.length)}${owner}`);
        }
      }
    }
  }
}

// Offered rather than taken: taking it leaves work running with nothing watching
const ASK_AT = 5;

// A press chooses the signal the wait keeps sending, and only the last one leaves
export function stopper(on: {
  abort: () => void;
  say: (message: string) => void;
  signal: (name: "TERM" | "KILL") => void;
  leave: () => void;
}) {
  let presses = 0;

  return () => {
    presses += 1;

    if (presses === 1) {
      on.say("Stopping the build (SIGTERM). Press again to kill it");
      on.abort();
      return on.signal("TERM");
    }

    if (presses < ASK_AT) {
      on.say("Killing the build (SIGKILL). Nothing exits until it is gone");
      return on.signal("KILL");
    }

    if (presses === ASK_AT) {
      for (const line of REFUSING) on.say(line);
      return on.signal("KILL");
    }

    on.leave();
  };
}

// What leaving costs, said before it is offered rather than after
const REFUSING = [
  "This is not stopping. It has had SIGKILL and is still there.",
  "Press again to leave redkite. That does not stop it: the build keeps running",
  "on the host, may finish and tag an image no deploy is waiting for, and holds",
  "the CPU and disk it is using. Nothing will clean up after it but you.",
];

// The answer is a count, and zero is the only one that ends this
async function gone(
  host: Host,
  hardest: () => "TERM" | "KILL",
  say: (message: string) => void,
) {
  let said = 0;

  for (let left = await host.stop(hardest()); left > 0; left = await host.stop(hardest())) {
    if (left !== said) {
      say(`Waiting for ${left} still running`);
      said = left;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

const POLL_MS = 400;

// Lands wherever the environment came from, so an inline one moves too
export function buildingHere(config: Deployment, environment: string): Deployment {
  if (config.environment) {
    return { ...config, environment: { ...config.environment, buildOn: "local" } };
  }

  const declared = config.environments?.[environment];
  if (!declared) return config;

  return {
    ...config,
    environments: {
      ...config.environments,
      [environment]: { ...declared, buildOn: "local" },
    },
  };
}

// Without a bastion every command is one this process can run itself
async function hostFor(
  host: DeployHost | undefined,
  log: Log,
  signal?: AbortSignal,
  startedAgent = false,
) {
  if (!host?.bastion) {
    // No connection to say it in, but a local run cloning over ssh still started one
    if (startedAgent) log.warn(AGENT_STARTED);
    return await localHost({ signal });
  }

  const task = log.step(`Opening a connection to ${host.bastion}`);
  if (startedAgent) task.detail(AGENT_STARTED);

  try {
    const opened = await sshHost(host.bastion, { signal, hostKeys: host.hostKeys });
    // Kept on the row once open, not only while it opens
    task.done(startedAgent ? AGENT_STARTED : undefined);
    return opened;
  } catch (error) {
    task.fail(`Could not reach ${host.bastion}`);
    throw error;
  }
}

// One store per provider a ref names; a ref no plugin answers for is refused
async function openStores(config: Deployment, log: Log): Promise<SecretStores> {
  // Services name refs too, which went uncounted until this
  const refs = [
    ...config.apps.flatMap((app) => [
      ...listRefs(app.secrets),
      ...Object.values(app.files ?? {}),
    ]),
    ...config.services.flatMap((service) => listRefs(service.secrets)),
  ];

  const opened: SecretStores = {};

  for (const provider of new Set(refs.map((ref) => ref.provider))) {
    const open = storeFor(config.plugins, provider);

    if (!open) {
      throw new Error(
        `Nothing resolves ${provider} secrets. Add the plugin that does to ` +
          "the plugins this deployment registers",
      );
    }

    const task = log.step(`Reading the ${provider} vault`);

    try {
      opened[provider] = await open({ detail: task.detail });
      task.done();
    } catch (error) {
      task.fail(`Could not read the ${provider} vault`);
      throw error;
    }
  }

  return opened;
}

type RunOptions = { verbose: boolean; full: boolean; local: boolean };

async function run(
  kind: Run,
  environment: string,
  configPath: string | undefined,
  options: RunOptions,
) {
  // Folded in first, so an environment naming a missing app is refused early
  const config = withEnvironment(await loadConfig(configPath), environment);

  // Fail on a missing environment before opening anything for it
  const topology = topologyFor(config, environment);
  const deployHost = environmentOf(config, environment)?.host;

  // Before the connection that forwards it, and before the view owns the terminal
  const agent = needsAgent(config, environment) ? requireAgent() : undefined;

  // The pipeline unwinds through its own failure path, and the finally tidies up
  const stopping = new AbortController();

  // The recording is what a crash log is written from, the view keeping only tails
  const recorder = recording(
    createLog({
      ...options,
      onQuit: () => stop(),
    }),
  );

  const log = recorder.log;

  // Before the view closes; a log that cannot be written must not mask the failure
  const dumped = async (outcome: string, error?: unknown) => {
    try {
      const path = await dumpCrash(config, recorder.transcript, {
        project: config.project,
        environment,
        command: kind,
        version: await version(),
        argv: process.argv.slice(2),
        outcome,
        at: Date.now(),
        error,
      });

      if (path) log.warn(`Crash logs written to ${path}`);
    } catch (failure) {
      log.warn(`Could not write the crash log: ${describeFailure(failure).split("\n")[0]}`);
    }
  };

  // Read by the wait below, so a press during it hardens what is sent
  let hardest: "TERM" | "KILL" = "TERM";

  const stop = stopper({
    say: log.warn,
    abort: () => stopping.abort(),
    signal: (name) => {
      hardest = name;
      // Nothing waits on this; it is what makes the command in flight answer
      void host?.stop(name);
    },

    leave: () => {
      log.warn("Leaving. What is still running on the host is yours to stop");
      log.close();
      process.exit(130);
    },
  });

  // The viewer reads ctrl+c as a key, holding the terminal in raw mode
  process.on("SIGINT", stop);

  let host: Host | undefined;

  try {
    const meter = measured(
      await hostFor(deployHost, log, stopping.signal, agent?.started),
      options.verbose ? log : recorder.command,
    );

    host = meter.host;

    const start = kind === "verify" ? verify : deploy;

    const result = await start({
      config: options.local ? buildingHere(config, environment) : config,
      environment,
      host,
      secrets: await openStores(config, log),
      verbose: options.verbose,
      signal: stopping.signal,
      log,
    });

    log(`Host: ${meter.summary()}`);

    if (kind === "verify") {
      log.done(`Checked ${result.checked.join(", ")} in ${topology.environment}`);
      return;
    }

    if (result.ok) {
      log.done(`Deployed ${result.released.join(", ")} to ${topology.environment}`);
      return;
    }

    log.fail(`Reverted ${result.reverted.join(", ")}`);
    process.exitCode = 1;
    await dumped("reverted");
  } catch (error) {
    // Somebody asked for it to stop, which is not a crash
    if (stopping.signal.aborted) {
      log.fail("Stopped");
      process.exitCode = 130;
    } else {
      log.fail(describeFailure(error));
      process.exitCode = 1;
      await dumped("failed", error);
    }
  } finally {
    // The chosen signal is resent every time round, so pressing again hardens it
    if (stopping.signal.aborted && host) await gone(host, () => hardest, log.warn);

    await host?.close?.();
    // Leaves the alternate screen, which is also what lets the process exit
    log.close();
  }
}
