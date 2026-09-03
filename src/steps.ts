import type { AppSpec, BeforeSwapSpec } from "./types.js";

type MigrateOptions = {
  command: string;
  tunnel?: { bastion: string; from: string; alias?: string; port?: number };
};

// Runs while the old containers still serve, and throws, so nothing retires
export function migrate(options: MigrateOptions): BeforeSwapSpec {
  return {
    kind: "migrate",
    command: options.command.split(" "),
    tunnel: options.tunnel && {
      bastion: options.tunnel.bastion,
      from: options.tunnel.from,
      alias: options.tunnel.alias ?? "database",
      port: options.tunnel.port ?? 5432,
    },
  };
}

type SentryOptions = { stripFromImage: string };

export function sentry(options: SentryOptions) {
  return { provider: "sentry" as const, stripFromImage: options.stripFromImage };
}

export function routeOf(app: AppSpec) {
  return app.route;
}
