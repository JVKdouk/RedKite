import { environmentOf } from "../config.js";
import { deploy, verify } from "../deploy.js";
import { Docker } from "../docker.js";
import type { Host } from "../host.js";
import { localHost } from "../localHost.js";
import { silent, type Log } from "../log.js";
import { renderNginx } from "../nginx.js";
import { addressOf, RUNS, SLOTS, type Run } from "../pipeline.js";
import { listRefs, type SecretStores } from "../secrets/refs.js";
import { bitwardenStore } from "../secrets/store.js";
import { driftOf, plannedServices, type Drift } from "../services/planned.js";
import { sshHost } from "../sshHost.js";
import { topologyFor, type Topology } from "../topology.js";
import type { Deployment, DeployHost } from "../types.js";

import { requireAgent } from "./agent.js";
import { loadConfig } from "./config.js";
import { createLog, describeFailure } from "./log.js";

// One command that reads the config and does everything under it: the agent,
// the vault, the checkout, the build, the swap and the cleanup.

const USAGE = `redkite <command> [environment]

  plan [environment]     Print the derived topology, the pipeline and the nginx
  deploy [environment]   Build, swap, health check, and revert on failure
  verify [environment]   Bring the services up, build, and run each app's checks

  --config <path>        Defaults to redkite.config.ts at the root of the project
  --local                Build the images here and ship them to the host
  --full                 No step view: every line of every step, in full
  --verbose              Every host command, and every line a build printed
  --version              Print the version and exit

Environment defaults to staging. A deployment is one redkite.config.ts at the root
of the project, and everything below it is derived.
`;

// Wraps a host rather than living inside one, so both implementations are
// measured the same way and neither knows it is being timed
function measured(host: Host, log?: Log) {
  const totals = { commands: 0, commandMs: 0, files: 0 };

  const wrapped: Host = {
    directory: host.directory,
    cache: host.cache,
    pipe: host.pipe.bind(host),
    stop: host.stop.bind(host),

    sh: async (command, onLine) => {
      const started = Date.now();
      const result = await host.sh(command, onLine);

      totals.commands += 1;
      totals.commandMs += Date.now() - started;

      // The exit code matters: several of these are allowed to fail, and a
      // deploy reading verbose output is one where somebody wants to know which
      log?.(`  $ ${command}  ${Date.now() - started}ms exit ${result.code}`);
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

// Read rather than generated into the build, so a published package and a
// linked checkout answer with the same thing
async function version() {
  const manifest = new URL("../../package.json", import.meta.url);
  const { readFile } = await import("node:fs/promises");
  const { version: found } = JSON.parse(await readFile(manifest, "utf8")) as {
    version: string;
  };

  return found;
}

// Flags that take a value, so the value is not mistaken for the environment
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

    // Only the two-word form consumes the next item. --flag=value does not
    if (VALUED.has(arg)) index += 1;
  }

  return args;
}

export async function main(argv: string[]) {
  try {
    return await dispatch(argv);
  } catch (error) {
    // A deploy reports its own failure through the live view. Everything before
    // one has started, a config that will not load above all, lands here
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

  if (command === "plan") return await plan(environment, configPath);
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

async function plan(environment: string, configPath?: string) {
  const config = await loadConfig(configPath);
  const topology = topologyFor(config, environment);

  const say = (message = "") => process.stdout.write(`${message}\n`);

  say(`# ${config.project} · ${environment}\n`);
  say(`network   ${topology.network}  ${topology.cidr}`);
  say(`branch    ${topology.branch}`);
  // A verify environment publishes nothing, because nothing in one serves
  say(
    topology.publicPort
      ? `published ${topology.publicPort} -> ${topology.router.container} ${topology.router.address}\n`
      : "published nothing, this environment has no publicPort\n",
  );

  const sources = new Map(config.apps.map((app) => [app.name, app.path ?? app.repo]));

  for (const app of topology.apps) {
    say(`app ${app.name}`);
    say(`  source   ${sources.get(app.name) ?? "?"}`);
    say(`  current  ${app.container}  ${app.currentAddress}:${app.port}`);
    say(`  retired  ${app.retired}  ${app.retiredAddress}`);
    say(`  route    ${app.route}`);

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

  // An environment that publishes nothing cannot serve, so verify is the only
  // run it supports. Nothing declares that: the missing port is what says it
  const serves = Boolean(topology.publicPort);

  sayPipeline(config, serves, say);
  await sayDrift(config, topology, serves ? "deploy" : "verify", say);

  if (!serves) return;

  say(`\n# rendered nginx ${"-".repeat(44)}\n`);
  say(renderNginx(topology, config.maxBodySize));
}

// What is running against what this file says should be. Services outlive a
// deploy, so this is the only part of a plan that cannot be answered from the
// config alone, and the only part that needs the host
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
    // A plan is worth printing without a host. Saying so beats printing
    // nothing, and beats printing a clean bill of health nobody checked
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

// What each run will actually do, in the order it will do it. A step is
// addressed rather than called, so this is the only place a sequence is visible
function sayPipeline(
  config: Deployment,
  serves: boolean,
  say: (message?: string) => void,
) {
  const steps = config.steps ?? [];
  const added = new Set(steps.map((step) => step.point));

  const at = (phase: string, slot: string) =>
    steps.filter((step) => {
      const address = addressOf(step.point);
      return address.phase === phase && address.slot === slot && step.point !== phase;
    });

  const checked = config.apps.filter((app) => app.verify).map((app) => app.name);

  // Both refusals live on a step's check, so a run printed here is one this
  // environment can actually be asked for
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
        // Redkite's own step leads its phase's slot. A deployment that puts one
        // at the same point replaces it, and this is where that shows
        if (slot === "main") {
          const who = added.has(phase) ? "replaced" : "redkite";
          const what = phase === "verify" ? `  ${checked.join(", ")}` : "";
          say(`  ${phase.padEnd(26)}${who}${what}`);
        }

        for (const step of at(phase, slot)) say(`  ${step.point}`);
      }
    }
  }
}

// Five presses is a build that has ignored SIGKILL, which is a process nothing
// here can end. The way out is offered rather than taken, because taking it is
// the one thing that leaves work running with nothing watching it
const ASK_AT = 5;

// The first ask is polite, every one after it is not. What a press does is
// choose the signal the wait keeps sending, and only the last one leaves
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

// What leaving costs, said before it is offered rather than after it is done
const REFUSING = [
  "This is not stopping. It has had SIGKILL and is still there.",
  "Press again to leave redkite. That does not stop it: the build keeps running",
  "on the host, may finish and tag an image no deploy is waiting for, and holds",
  "the CPU and disk it is using. Nothing will clean up after it but you.",
];

// A stopped deploy is not over until what it started is gone. The host is asked
// again and again because the answer is a count, and zero is the only one that
// ends this
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

// --local says it for this run alone, without the config having to change. It
// lands wherever the environment came from, so an inline one moves too
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

// Without a bastion the containers are on this machine, and every command the
// deploy issues is one this process can run itself
async function hostFor(host: DeployHost | undefined, log: Log, signal?: AbortSignal) {
  if (!host?.bastion) return await localHost({ signal });

  const task = log.step(`Opening a connection to ${host.bastion}`);

  try {
    const opened = await sshHost(host.bastion, { signal });
    task.done();
    return opened;
  } catch (error) {
    task.fail(`Could not reach ${host.bastion}`);
    throw error;
  }
}

// Only the stores the config actually names. A deployment that keeps its
// environment somewhere else, or nowhere, needs no credentials to deploy
async function openStores(config: Deployment, log: Log): Promise<SecretStores> {
  // Services name refs too, and a deployment whose only secret is a database
  // password opened no store at all until this counted them
  const refs = [
    ...config.apps.flatMap((app) => [
      ...listRefs(app.secrets),
      ...Object.values(app.files ?? {}),
    ]),
    ...config.services.flatMap((service) => listRefs(service.secrets)),
  ];

  const providers = new Set(refs.map((ref) => ref.provider));

  if (!providers.has("bitwarden")) return {};

  const vault = log.step("Reading the vault");

  try {
    const bitwarden = await bitwardenStore({
      detail: vault.detail,
      clientId: required("BW_CLIENT_ID"),
      clientSecret: required("BW_CLIENT_SECRET"),
      password: required("BW_PASSWORD"),
    });

    vault.done();
    return { bitwarden };
  } catch (error) {
    vault.fail("Could not read the vault");
    throw error;
  }
}

function required(name: string) {
  const value = process.env[name];
  if (value) return value;

  throw new Error(
    `${name} is not set, and this deployment reads its environment from Bitwarden`,
  );
}

type RunOptions = { verbose: boolean; full: boolean; local: boolean };

async function run(
  kind: Run,
  environment: string,
  configPath: string | undefined,
  options: RunOptions,
) {
  const config = await loadConfig(configPath);

  // Fail on a missing environment before opening anything for it
  const topology = topologyFor(config, environment);
  const deployHost = environmentOf(config, environment)?.host;

  // The host clones the repositories over this, so it has to exist before the
  // connection that forwards it is opened. Before the view too: ssh-add asks
  // for a passphrase on the terminal, and by then the view owns it
  requireAgent((message) => process.stderr.write(`${message}\n`));

  // Whatever is in flight is killed, the pipeline unwinds through its own
  // failure path, and the finally below removes the scratch directory
  const stopping = new AbortController();

  const log = createLog({
    ...options,
    onQuit: () => stop(),
  });

  // Read by the wait below, so a press during it hardens what that is sending
  let hardest: "TERM" | "KILL" = "TERM";

  const stop = stopper({
    say: log.warn,
    abort: () => stopping.abort(),
    signal: (name) => {
      hardest = name;
      // Nothing waits on this: the wait is in the finally, and this is what
      // makes the command in flight answer so the run can get there
      void host?.stop(name);
    },

    leave: () => {
      log.warn("Leaving. What is still running on the host is yours to stop");
      log.close();
      process.exit(130);
    },
  });

  // The viewer reads ctrl+c as a key, because it holds the terminal in raw
  // mode. Everything else arrives here as a signal
  process.on("SIGINT", stop);

  let host: Host | undefined;

  try {
    const meter = measured(
      await hostFor(deployHost, log, stopping.signal),
      options.verbose ? log : undefined,
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
  } catch (error) {
    // Whatever the command in flight said about being killed is noise: what
    // happened is that somebody asked for it to stop
    if (stopping.signal.aborted) {
      log.fail("Stopped");
      process.exitCode = 130;
    } else {
      log.fail(describeFailure(error));
      process.exitCode = 1;
    }
  } finally {
    // Nothing leaves while the build is still running. The signal a press
    // chose is resent every time round, so pressing again hardens it
    if (stopping.signal.aborted && host) await gone(host, () => hardest, log.warn);

    await host?.close?.();
    // Leaves the alternate screen and writes the run out on the screen the
    // person keeps, which is also what lets the process exit
    log.close();
  }
}
