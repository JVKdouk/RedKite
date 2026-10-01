import type { BuildSpec } from "../types.js";
import { nodeApp } from "./nodeApp.js";

type NextAppOptions = {
  builder?: string;
  runtime?: string;
  port?: number;
  steps?: string[];
  dependencies?: { files: string[]; step: string } | false;
  // Whether next.config sets output: "standalone". Defaults to true
  standalone?: boolean;
};

export function nextApp(options: NextAppOptions = {}): BuildSpec {
  const port = options.port ?? 3000;
  const standalone = options.standalone ?? true;

  const shared = {
    builder: options.builder ?? "24-alpine",
    runtime: options.runtime ?? "22-alpine",
    steps: options.steps ?? ["yarn build"],
    dependencies: options.dependencies,
  };

  // Relative, because the runtime starts at the app's root, not the image top
  const start = (command: string) =>
    ["sh", "-c", `HOSTNAME=0.0.0.0 PORT=${port} ${command}`];

  if (!standalone) {
    return {
      ...nodeApp({
        ...shared,
        // The whole tree: next start reads the source layout and resolves at runtime
        output: "/app",
        // npx resolves upwards, so this works hoisted or app-owned
        entrypoint: start("npx --no-install next start"),
        caches: ["yarn", "npm", "next-app"],
      }),
      preset: "nextApp",
      keepsLayout: true,
    };
  }

  return {
    ...nodeApp({
      ...shared,
      output: "/app/.next/standalone",
      // static is built and served; public is optional, plenty of apps have none
      carry: ["/app/.next/static", { path: "/app/public", optional: true }],
      entrypoint: start("node server.js"),
      // next-app is Next's build cache; node_modules is omitted as in nodeApp
      caches: ["yarn", "npm", "next-app"],
    }),
    preset: "nextApp",
    // The standalone tree traces from the workspace root, keeping subdirectories
    keepsLayout: true,
  };
}
