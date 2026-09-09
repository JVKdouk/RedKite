import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseEnv } from "../environment.js";

// The credentials a deploy needs are the one thing that cannot live in the
// config, so they live beside it. Read here rather than by a plugin, because
// which file answers depends on the environment being deployed and a plugin
// is handed neither the directory nor the name.

// Most specific first. A deploy file is for what only a deploy needs, and it
// wins over the one the application itself reads
const NAMES = (environment: string) => [
  `.env.${environment}.deploy`,
  `.env.${environment}`,
  ".env",
];

// Only what is missing. Anything already in the environment was set by the
// person running this or by the job, and neither should be talked over
export function loadDotenv(directory: string, environment: string) {
  const read: string[] = [];

  for (const name of NAMES(environment)) {
    const path = join(directory, name);
    if (!existsSync(path)) continue;

    read.push(name);
    for (const [key, value] of Object.entries(parseEnv(readFileSync(path, "utf8")))) {
      process.env[key] ??= value;
    }
  }

  return read;
}
