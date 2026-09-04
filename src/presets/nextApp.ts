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

  // Relative, because the runtime starts at the app's root and a monorepo puts
  // that under its own directory rather than at the top of the image
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
      // static is what the build produced and the server serves. public is
      // whatever the repository put there, and plenty of apps have none
      carry: ["/app/.next/static", { path: "/app/public", optional: true }],
      entrypoint: start("node server.js"),
      // app-modules is what makes the build fast: node_modules on a mount
      // rather than in a layer, which the standalone tree makes safe by
      // carrying its own copy of everything the server reaches
      caches: ["yarn", "npm", "modules", "app-modules", "next-app"],
    }),
    preset: "nextApp",
    // The standalone tree traces from the workspace root, so an app in a
    // subdirectory arrives at that subdirectory and not at the top of it
    keepsLayout: true,
  };
}
