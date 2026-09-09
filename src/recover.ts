import { revert } from "./deploy.js";
import { Docker } from "./docker.js";
import { finalHost, type Host } from "./host.js";
import { silent, type Log } from "./log.js";
import { topologyFor, type Topology } from "./topology.js";
import type { Deployment } from "./types.js";

// Undoing a run that did not finish, from a process that is not it. A cancelled
// job is killed rather than asked, so nothing it was holding survives to tidy
// up: what the host is left in has to be readable from the host alone.

export type RecoverOptions = {
  config: Deployment;
  environment: string;
  host: Host;
  log?: Log;
};

export type RolledBack = {
  // Apps put back on the live address they were serving from
  restored: string[];
  // Apps that were already where they belong, which is most runs
  untouched: string[];
};

// A retired container is the whole signal. One exists between the swap and the
// cleanup that removes it, so finding one means a run moved an address and did
// not get to say whether that worked
export async function rollback(options: RecoverOptions): Promise<RolledBack> {
  const { log, topology, docker } = opened(options);

  const restored: string[] = [];
  const untouched: string[] = [];

  for (const app of topology.apps) {
    if (!(await docker.container.exists(app.retired))) {
      untouched.push(app.container);
      continue;
    }

    log(`Putting ${app.container} back`);
    await revert(docker, topology, app);
    restored.push(app.container);
  }

  return { restored, untouched };
}

export type TakenDown = {
  stopped: string[];
};

// Stopped rather than removed, so the next run adopts them where it left off.
// For an environment that exists to be built against rather than served from,
// which is the one a cancelled job should not leave running
export async function down(options: RecoverOptions): Promise<TakenDown> {
  const { log, topology, docker } = opened(options);
  const stopped: string[] = [];

  for (const name of every(topology)) {
    if (!(await docker.container.isRunning(name))) continue;

    log(`Stopping ${name}`);
    await docker.container.stop(name);
    stopped.push(name);
  }

  return { stopped };
}

// Everything this environment named, whether or not it was ever created. The
// proxy is derived rather than listed, so it would be missed by walking the
// config alone
function every(topology: Topology) {
  return [
    ...topology.apps.flatMap((app) => [app.container, app.retired, app.failed]),
    ...topology.services.map((service) => service.container),
    topology.router.container,
  ];
}

// Both of these exist because something was stopped, so neither may be refused
// by that same stop
function opened(options: RecoverOptions) {
  return {
    log: options.log ?? silent,
    topology: topologyFor(options.config, options.environment),
    docker: new Docker(finalHost(options.host)),
  };
}
