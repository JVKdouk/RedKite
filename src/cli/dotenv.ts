import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseEnv } from "../environment.js";

// Most specific first; a deploy file wins over the one the application reads
const NAMES = (environment: string) => [
  `.env.${environment}.deploy`,
  `.env.${environment}`,
  ".env",
];

// Fills only what is missing, so the caller's own environment wins
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
