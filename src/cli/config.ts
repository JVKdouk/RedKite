import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { Deployment } from "../types.js";

// Found by convention rather than named on the command line. A repository has
// one deployment, and requiring the path is a flag nobody ever varies.

const CANDIDATES = [
  "redkite.config.ts",
  "redkite.config.mts",
  "redkite.config.js",
  "redkite.config.mjs",
];

// Node strips types itself from 22.18 on, which is what lets redkite ship with no
// dependencies. These are the ways that can fail on a config it cannot read.
// A SyntaxError is the same class of failure: a package without "type":
// "module" makes a .ts file CommonJS, where an import statement is not legal
const LOADER = new Set([
  "ERR_UNKNOWN_FILE_EXTENSION",
  "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX",
  "ERR_MODULE_NOT_FOUND",
  "ERR_INVALID_MODULE_SPECIFIER",
]);

export async function loadConfig(explicit?: string): Promise<Deployment> {
  const path = explicit ? resolve(explicit) : discover(process.cwd());

  const module = (await load(path)) as {
    default?: Deployment & { default?: Deployment };
  };

  // A config inside a CommonJS package transpiles to CommonJS, and Node hands
  // back the whole module.exports as the default, wrapping the real one
  const config = module.default?.default ?? module.default;
  if (config) return config;

  throw new Error(`${path} has no default export`);
}

// The config sits at the root of the project, and a deploy is as likely to be
// run from a workspace inside it as from there
export function discover(from: string): string {
  let directory = from;

  for (;;) {
    for (const candidate of CANDIDATES) {
      const path = join(directory, candidate);
      if (existsSync(path)) return path;
    }

    const parent = dirname(directory);
    if (parent === directory) break;

    directory = parent;
  }

  throw new Error(
    `No redkite.config.ts found in ${from} or any directory above it. ` +
      "A deployment is one file at the root of the project",
  );
}

async function load(path: string) {
  const url = pathToFileURL(path).href;

  try {
    return await import(url);
  } catch (error) {
    if (!unreadable(error)) throw error;

    // tsx resolves what Node will not: a path mapped by tsconfig, and the
    // ./thing.js specifier TypeScript writes for a sibling ./thing.ts
    const register = await tsxFrom(dirname(path));

    if (!register) throw cannotRead(path, error);

    const unregister = register();

    try {
      return await import(url);
    } finally {
      await unregister();
    }
  }
}

// Resolved from the project being deployed rather than depended on, so redkite
// installs as one package and still reads a config that needs more
async function tsxFrom(directory: string) {
  try {
    const require = createRequire(join(directory, "redkite.js"));
    const api = (await import(
      pathToFileURL(require.resolve("tsx/esm/api")).href
    )) as { register: () => () => Promise<void> };

    return api.register;
  } catch {
    return undefined;
  }
}

function unreadable(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  if (error instanceof SyntaxError) return true;

  return "code" in error && typeof error.code === "string" && LOADER.has(error.code);
}

// Node reads TypeScript itself, within limits a config can run into. Each of
// them has a one line fix, and none of them is obvious from what Node throws
function cannotRead(path: string, error: Error) {
  const remedies = [
    "  · A package without \"type\": \"module\" makes a .ts file CommonJS, where",
    "    an import statement is not legal. Name it redkite.config.mts instead",
    "  · Node resolves a relative import by the file it names, so a sibling is",
    "    ./thing.ts rather than ./thing.js",
    "  · Node reads TypeScript from 22.18 on, and this is " + process.version,
    "  · Anything else: add tsx to this project and redkite will read the config",
    "    through it",
  ];

  return new Error(
    `Could not read ${path}\n\n${error.message}\n\n${remedies.join("\n")}`,
    { cause: error },
  );
}
