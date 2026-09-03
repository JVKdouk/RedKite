import type { BuildSpec } from "../types.js";
import { nodeApp } from "./nodeApp.js";

type NextAppOptions = {
  builder?: string;
  runtime?: string;
  port?: number;
  steps?: string[];
  dependencies?: { files: string[]; step: string } | false;
};

// The standalone layout is three directories that have to land in the right
// places, which is the only part of a Next build that is not a node build
export function nextApp(options: NextAppOptions = {}): BuildSpec {
  const port = options.port ?? 3000;

  return {
    ...nodeApp({
      builder: options.builder ?? "24-alpine",
      runtime: options.runtime ?? "22-alpine",
      steps: options.steps ?? ["yarn build"],
      dependencies: options.dependencies,
      output: "/app/.next/standalone",
      carry: ["/app/.next/static", "/app/public"],
      entrypoint: [
        "sh",
        "-c",
        `HOSTNAME=0.0.0.0 PORT=${port} node /app/server.js`,
      ],
      caches: ["yarn", "modules", "next-app"],
    }),
    preset: "nextApp",
  };
}
