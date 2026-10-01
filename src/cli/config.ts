import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { Deployment, Environment } from "../types.js";

// Found by convention; the environments live beside it, one file each

const EXTENSIONS = ["ts", "mts", "js", "mjs"] as const;

const CANDIDATES = EXTENSIONS.map((extension) => `redkite.config.${extension}`);

// The .config is optional here, so a near-miss name is read and refused, not skipped
const PER_ENVIRONMENT = /^redkite[.\-_](.+?)(?:\.config)?\.(?:ts|mts|cts|js|mjs|cjs)$/;

// It becomes part of an image tag, so this is docker's limit rather than ours
const ENVIRONMENT_NAME = /^[a-z0-9][a-z0-9._-]*$/;

// The ways Node's own type stripping fails on a config it cannot read
const LOADER = new Set([
  "ERR_UNKNOWN_FILE_EXTENSION",
  "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX",
  "ERR_MODULE_NOT_FOUND",
  "ERR_INVALID_MODULE_SPECIFIER",
]);

export async function loadConfig(explicit?: string): Promise<Deployment> {
  const path = explicit ? resolve(explicit) : discover(process.cwd());
  const config = defaultOf(await load(path), path) as Deployment;

  const manifest = manifestOf(explicit ? dirname(path) : process.cwd());
  const beside = await loadEnvironments(dirname(path));

  // Read either way, so environments may sit together under a deployment at the root
  const declared = directoryOf(manifest);
  const under = declared && declared !== dirname(path) ? await loadEnvironments(declared) : {};

  const named = await loadNamed(manifest);
  const found = { ...beside, ...under };

  for (const name of Object.keys(under)) {
    if (!beside[name]) continue;

    throw new Error(
      `${name} sits both beside the deployment and in ${declared}, ` +
        "and an environment comes from one place or the other",
    );
  }

  for (const name of Object.keys(named)) {
    if (!found[name]) continue;

    throw new Error(
      `${name} is named by package.json and also sits beside the deployment. ` +
        "An environment comes from one place or the other",
    );
  }

  return { ...rooted(config, dirname(path)), environments: { ...found, ...named } };
}

// Resolved here, so a deploy from a workspace and from the root build the same tree
function rooted(config: Deployment, directory: string): Deployment {
  // A file that never called defineDeployment can export anything
  if (!(config.apps ?? []).some((app) => app.path)) return config;

  return {
    ...config,
    apps: config.apps.map((app) =>
      app.path ? { ...app, path: resolve(directory, app.path) } : app,
    ),
  };
}

// For a repository keeping them where the naming convention would not find them
async function loadNamed(manifest: Manifest | undefined) {
  const declared = manifest?.redkite.environments;
  if (!manifest || !declared) return {};

  const environments: Record<string, Environment> = {};

  for (const [name, where] of Object.entries(declared)) {
    if (typeof where !== "string") {
      throw new Error(`package.json names ${name} as something other than a path`);
    }

    const path = resolve(manifest.root, where);
    if (!existsSync(path)) {
      throw new Error(`package.json points ${name} at ${path}, which is not there`);
    }

    environments[name] = defaultOf(await load(path), path) as Environment;
  }

  return environments;
}

// A deploy is as likely to be run from a workspace inside the project as from its root
export function discover(from: string): string {
  let directory = from;
  // Naming it separates "nothing here" from "that file is an environment"
  const nearby: string[] = [];

  for (;;) {
    const declared = directoryFrom(directory);

    // A missing directory stops the run; one holding only environments does not
    if (declared && !existsSync(declared)) missing(declared, directory);

    const there = declared && found(declared);
    if (there) return there;

    const here = found(directory);
    if (here) return here;

    for (const place of declared ? [declared, directory] : [directory]) {
      for (const entry of environmentsAt(place)) nearby.push(join(place, entry));
    }

    const parent = dirname(directory);
    if (parent === directory) break;

    directory = parent;
  }

  if (nearby.length > 0) {
    throw new Error(
      `No deployment found, but ${nearby.join(" and ")} reads as an environment. ` +
        "An environment says which branch and which subnet; the deployment says " +
        "the project, the apps and the services, and is redkite.config.ts",
    );
  }

  throw new Error(
    `No redkite.config.ts found in ${from} or any directory above it. A deployment ` +
      'is one file at the root of the project, or wherever package.json\'s ' +
      '"redkite": { "directory": … } says it is',
  );
}

// For a message that can say what was there instead of what was not
function environmentsAt(directory: string) {
  if (!existsSync(directory)) return [];

  return readdirSync(directory)
    .filter((entry) => !CANDIDATES.includes(entry))
    .filter((entry) => PER_ENVIRONMENT.test(entry))
    .sort();
}

// Every environment that lives in a file of its own, keyed by the name in it
export async function loadEnvironments(directory: string) {
  const environments: Record<string, Environment> = {};
  const seen: Record<string, string> = {};

  for (const entry of readdirSync(directory).sort()) {
    if (CANDIDATES.includes(entry)) continue;

    const name = PER_ENVIRONMENT.exec(entry)?.[1];
    if (!name) continue;

    if (!ENVIRONMENT_NAME.test(name)) {
      throw new Error(
        `${join(directory, entry)} reads as the environment ${name}, which cannot ` +
          "name one: it becomes part of an image tag, and a tag is lower case",
      );
    }

    const first = seen[name];
    if (first) {
      throw new Error(`${name} is defined by both ${first} and ${entry}`);
    }

    seen[name] = entry;
    const path = join(directory, entry);
    environments[name] = defaultOf(await load(path), path) as Environment;
  }

  return environments;
}

function found(directory: string) {
  for (const candidate of CANDIDATES) {
    const path = join(directory, candidate);
    if (existsSync(path)) return path;
  }

  return undefined;
}

function missing(declared: string, from: string): never {
  throw new Error(
    `${join(from, "package.json")} points redkite at ${declared}, which is not there`,
  );
}

// Its paths are read against its own directory rather than the working one
type Manifest = {
  root: string;
  redkite: { directory?: unknown; environments?: Record<string, unknown> };
};

function manifestAt(directory: string): Manifest | undefined {
  const path = join(directory, "package.json");
  if (!existsSync(path)) return undefined;

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      redkite?: Manifest["redkite"];
    };

    return parsed.redkite ? { root: directory, redkite: parsed.redkite } : undefined;
  } catch {
    // A package.json that does not parse is not this tool's to complain about
    return undefined;
  }
}

// The nearest package.json above, or the directory itself when there is none
export function projectRoot(explicit?: string) {
  const from = explicit ? dirname(resolve(explicit)) : process.cwd();
  return manifestOf(from)?.root ?? from;
}

// The same walk the config itself is found by
function manifestOf(from: string) {
  let directory = from;

  for (;;) {
    const found = manifestAt(directory);
    if (found) return found;

    const parent = dirname(directory);
    if (parent === directory) return undefined;

    directory = parent;
  }
}

// For a repository that would rather not keep them at its root
function directoryFrom(directory: string) {
  return directoryOf(manifestAt(directory));
}

function directoryOf(manifest: Manifest | undefined) {
  if (!manifest) return undefined;

  const declared = manifest.redkite.directory;
  return typeof declared === "string" ? resolve(manifest.root, declared) : undefined;
}

function defaultOf(module: unknown, path: string) {
  const found = module as { default?: { default?: unknown } };

  // In a CommonJS package Node hands back module.exports, wrapping the real default
  const config = found.default?.default ?? found.default;
  if (config) return config;

  throw new Error(`${path} has no default export`);
}

async function load(path: string) {
  const url = pathToFileURL(path).href;

  try {
    return await import(url);
  } catch (error) {
    if (!unreadable(error)) throw error;

    // tsx resolves a tsconfig path, and the ./thing.js specifier written for a .ts
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

// Resolved from the project, so redkite installs as one package and still reads it
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

// Each limit has a one line fix, and none is obvious from what Node throws
function cannotRead(path: string, error: Error) {
  const remedies = [
    '  · A package without "type": "module" makes a .ts file CommonJS, where',
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
