import { deploy } from "../deploy.js";
import type { Host } from "../host.js";
import { localHost } from "../localHost.js";
import type { Log } from "../log.js";
import { renderNginx } from "../nginx.js";
import { addressOf, PHASES, SLOTS, type AnyStep } from "../pipeline.js";
import { listRefs, type SecretStores } from "../secrets/refs.js";
import { bitwardenStore } from "../secrets/store.js";
import { sshHost } from "../sshHost.js";
import { topologyFor } from "../topology.js";
import type { Deployment, DeployHost } from "../types.js";

import { requireAgent } from "./agent.js";
import { loadConfig } from "./config.js";
import { createLog, describeFailure } from "./log.js";

// One command that reads the config and does everything under it: the agent,
// the vault, the checkout, the build, the swap and the cleanup.

const USAGE = `redkite <command> [environment]

  plan [environment]     Print the derived topology, the pipeline and the nginx
  deploy [environment]   Build, swap, health check, and revert on failure

  --config <path>        Defaults to redkite.config.ts at the root of the project
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
  if (command === "deploy") {
    return await run(environment, configPath, {
      verbose: argv.includes("--verbose"),
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
  say(
    `published ${topology.publicPort} -> ${topology.router.container} ${topology.router.address}\n`,
  );

  for (const app of topology.apps) {
    say(`app ${app.name}`);
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

  sayPipeline(config.steps ?? [], say);

  say(`\n# rendered nginx ${"-".repeat(44)}\n`);
  say(renderNginx(topology, config.maxBodySize));
}

// What a run will actually do, in the order it will do it. A step is addressed
// rather than called, so this is the only place the whole sequence is visible
function sayPipeline(steps: AnyStep[], say: (message?: string) => void) {
  const added = new Set(steps.map((step) => step.point));

  const at = (phase: string, slot: string) =>
    steps.filter((step) => {
      const address = addressOf(step.point);
      return address.phase === phase && address.slot === slot && step.point !== phase;
    });

  say("\npipeline");

  for (const phase of PHASES) {
    for (const slot of SLOTS) {
      // Redkite's own step leads its phase's slot. A deployment that puts one at
      // the same point replaces it, and this is where that shows
      if (slot === "main") {
        say(`  ${phase.padEnd(26)}${added.has(phase) ? "replaced" : "redkite"}`);
      }

      for (const step of at(phase, slot)) say(`  ${step.point}`);
    }
  }
}

// Without a bastion the containers are on this machine, and every command the
// deploy issues is one this process can run itself
async function hostFor(host: DeployHost | undefined, log: Log) {
  if (!host?.bastion) return await localHost();

  const task = log.step(`Opening a connection to ${host.bastion}`);

  try {
    const opened = await sshHost(host.bastion);
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
  const providers = new Set(
    config.apps
      .flatMap((app) => [...listRefs(app.secrets), ...Object.values(app.files ?? {})])
      .map((ref) => ref.provider),
  );

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

type RunOptions = { verbose: boolean };

async function run(
  environment: string,
  configPath: string | undefined,
  options: RunOptions,
) {
  const config = await loadConfig(configPath);
  const log = createLog();

  // Fail on a missing environment before opening anything for it
  const topology = topologyFor(config, environment);
  const deployHost = config.environments[environment]?.host;

  // The host clones the repositories over this, so it has to exist before the
  // connection that forwards it is opened
  requireAgent(log);

  let host: Host | undefined;

  try {
    const meter = measured(await hostFor(deployHost, log), options.verbose ? log : undefined);
    host = meter.host;

    const result = await deploy({
      config,
      environment,
      host,
      secrets: await openStores(config, log),
      health: {
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      },
      verbose: options.verbose,
      log,
    });

    log(`Host: ${meter.summary()}`);

    if (result.ok) {
      log.done(`Deployed ${result.released.join(", ")} to ${topology.environment}`);
      return;
    }

    log.fail(`Reverted ${result.reverted.join(", ")}`);
    process.exitCode = 1;
  } catch (error) {
    log.fail(describeFailure(error));
    process.exitCode = 1;
  } finally {
    await host?.close?.();
  }
}
