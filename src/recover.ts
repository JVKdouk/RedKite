import { revert } from "./deploy.js";
import { Docker } from "./docker.js";
import { finalHost, type Host } from "./host.js";
import { silent, type Log } from "./log.js";
import { topologyFor, type Topology } from "./topology.js";
import type { Deployment } from "./types.js";

// Undoing an unfinished run from elsewhere, reading only what the host holds

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

// One exists only between the swap and the cleanup, so it means a moved address
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

// Stopped rather than removed, so the next run adopts them where it left off
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

// Includes the derived proxy, which walking the config alone would miss
function every(topology: Topology) {
  return [
    ...topology.apps.flatMap((app) => [app.container, app.retired, app.failed]),
    ...topology.services.map((service) => service.container),
    topology.router.container,
  ];
}

// Both exist because something was stopped, so neither may be refused by it
function opened(options: RecoverOptions) {
  return {
    log: options.log ?? silent,
    topology: topologyFor(options.config, options.environment),
    docker: new Docker(finalHost(options.host)),
  };
}
