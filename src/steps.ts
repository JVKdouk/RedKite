import { environmentOf } from "./config.js";
import { envFlags } from "./environment.js";
import type { Built, Plan, Step } from "./pipeline.js";
import type { Topology } from "./topology.js";
import type { AppSpec, StepNetwork } from "./types.js";

// The flags that attach one. The deployment network carries the aliases too,
// because a service answers to its alias rather than its container name, and a
// step reaching postgres:5432 is the whole reason to be on that network
export function attachment(network: StepNetwork, topology: Topology): string[] {
  if (network === "host") return ["--network host"];
  if (network === "none") return ["--network none"];
  if (network !== "deployment") return [`--network ${network.named}`];

  return [
    // No address is asked for. Docker allocates from the bottom of the subnet
    // and every derived address starts at .20, so an ephemeral container never
    // takes one an app is about to be created on
    `--network ${topology.network}`,
    ...Object.entries(topology.extraHosts).map(([name, ip]) => `--add-host ${name}:${ip}`),
  ];
}

type MigrateOptions = {
  // The app whose builder image the command runs in. Every app keeps one, so
  // there is nothing else a config has to set for this to work
  app: string;
  command: string;
  // Defaults to the deploy host's own stack, which is the machine that can
  // already reach whatever the app's environment file points at. A database
  // this deployment runs as a service is on "deployment" instead
  network?: StepNetwork;
  // The machine this migration reaches its database through. The step runs on
  // the deploy host, so a deployment that moved to another one is refused
  // rather than pointed at a database it may not be able to see
  through?: string;
};

// An ordinary step at an ordinary point. Hung before the swap, it runs while
// the old containers still serve, and it throws, so nothing retires
export function migrate(options: MigrateOptions): Step<`swap:before:${string}`> {
  const command = options.command.split(" ");

  return {
    point: `swap:before:migrate-${options.app}`,
    check: (plan) => assertReachable(plan, options),

    run: async (input, context) => {
      const image = builderOf(input, options.app);
      context.task.detail(`${options.app}: ${options.command}`);

      // Nothing from the vault is in the image, so a migration reads its
      // database url from the environment it is given rather than from a file
      // the build left behind
      const app = context.config.apps.find((item) => item.name === options.app);

      await context.docker.runOrThrow(
        [
          "run --rm",
          ...attachment(options.network ?? "host", context.topology),
          ...(app ? await envFlags(app, context) : []),
          "--workdir /app",
          image,
          ...command,
        ].join(" "),
        `${options.app} failed to migrate`,
      );

      return input;
    },
  };
}

// Checked before the run starts, so a config naming an app that never kept a
// builder fails without having touched the host
function assertReachable(plan: Plan, options: MigrateOptions) {
  const app = plan.config.apps.find((item) => item.name === options.app);
  if (!app) throw new Error(`${options.app} names no app in this deployment`);

  const bastion = environmentOf(plan.config, plan.environment)?.host?.bastion;
  const expected = options.through;
  if (!expected || expected === bastion) return;

  throw new Error(
    `${options.app} migrates through ${expected}, ` +
      `but ${plan.environment} deploys to ${bastion ?? "this machine"}. ` +
      "The step runs on the deploy host, so they have to be the same",
  );
}

// A deployment may replace the build step, and a command hung on the pipeline
// has to run in an image something actually produced
export function builderOf(input: Built, name: string) {
  const app = input.apps.find((item) => item.name === name);
  if (app?.builderTag) return app.builderTag;

  throw new Error(`${name} has no builder image, so nothing can be run in it`);
}

export function routeOf(app: AppSpec) {
  return app.route;
}
