import { envFlags } from "./environment.js";
import type { Built, Plan, Step } from "./pipeline.js";
import type { Topology } from "./topology.js";
import type { AppSpec, StepNetwork } from "./types.js";

// The deployment network carries the aliases, so a step can reach postgres:5432
export function attachment(network: StepNetwork, topology: Topology): string[] {
  if (network === "host") return ["--network host"];
  if (network === "none") return ["--network none"];
  if (network !== "deployment") return [`--network ${network.named}`];

  return [
    // Docker allocates from the bottom, and derived addresses start at .20
    `--network ${topology.network}`,
    ...Object.entries(topology.extraHosts).map(([name, ip]) => `--add-host ${name}:${ip}`),
  ];
}

type MigrateOptions = {
  // The app whose builder image the command runs in; every app keeps one
  app: string;
  command: string;
  // Defaults to the host's stack; a service of this deployment needs "deployment"
  network?: StepNetwork;
};

// Hung before the swap it runs while the old containers still serve, and throws
export function migrate(options: MigrateOptions): Step<`swap:before:${string}`> {
  const command = options.command.split(" ");

  return {
    point: `swap:before:migrate-${options.app}`,
    check: (plan) => assertApp(plan, options),

    run: async (input, context) => {
      const image = builderOf(input, options.app);
      context.task.detail(`${options.app}: ${options.command}`);

      // Nothing from the vault is in the image, so this reads its url from here
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

// Checked before the run starts, so the host is untouched when it fails
function assertApp(plan: Plan, options: MigrateOptions) {
  if (plan.config.apps.some((item) => item.name === options.app)) return;
  throw new Error(`${options.app} names no app in this deployment`);
}

// A deployment may replace the build step, so check the image was produced
export function builderOf(input: Built, name: string) {
  const app = input.apps.find((item) => item.name === name);
  if (app?.builderTag) return app.builderTag;

  throw new Error(`${name} has no builder image, so nothing can be run in it`);
}

export function routeOf(app: AppSpec) {
  return app.route;
}
