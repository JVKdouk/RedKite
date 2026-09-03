import type { BuildSpec } from "../types.js";
import { nodeApp } from "./nodeApp.js";

type NextAppOptions = {
  builder?: string;
  runtime?: string;
  port?: number;
  steps?: string[];
  dependencies?: { files: string[]; step: string } | false;
  // Whether next.config sets output: "standalone". Defaults to true, which is
  // the layout worth deploying: a tree that runs on node alone
  standalone?: boolean;
};

// The standalone layout is three directories that have to land in the right
// places, which is the only part of a Next build that is not a node build
export function nextApp(options: NextAppOptions = {}): BuildSpec {
  const port = options.port ?? 3000;
  const standalone = options.standalone ?? true;

  const shared = {
    builder: options.builder ?? "24-alpine",
    runtime: options.runtime ?? "22-alpine",
    steps: options.steps ?? ["yarn build"],
    dependencies: options.dependencies,
  };

  const start = (command: string) =>
    ["sh", "-c", `HOSTNAME=0.0.0.0 PORT=${port} ${command}`];

  if (!standalone) {
    return {
      ...nodeApp({
        ...shared,
        // The whole tree, because next start reads the source layout it built
        // from and resolves its own dependencies at runtime
        output: "/app",
        // npx resolves the binary from node_modules/.bin upwards, so this
        // finds it whether a workspace hoisted it or the app owns it
        entrypoint: start("npx --no-install next start"),
        // Without the modules cache, so node_modules is a layer of the image
        // rather than a mount the runtime stage never sees
        caches: ["yarn", "next-app"],
      }),
      preset: "nextApp",
    };
  }

  return {
    ...nodeApp({
      ...shared,
      output: "/app/.next/standalone",
      carry: ["/app/.next/static", "/app/public"],
      entrypoint: start("node /app/server.js"),
      caches: ["yarn", "modules", "next-app"],
    }),
    preset: "nextApp",
  };
}
