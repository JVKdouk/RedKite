import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { Deployment, Environment } from "../types.js";

// Found by convention rather than named on the command line. A repository has
// one deployment, and requiring the path is a flag nobody ever varies.
//
// The environments live beside it, one file each, so the thing that differs
// between staging and production is a file rather than a key several levels
// down a literal.

const EXTENSIONS = ["ts", "mts", "js", "mjs"] as const;

const CANDIDATES = EXTENSIONS.map((extension) => `redkite.config.${extension}`);

// Anything beside the deployment that starts with redkite and is a module it
// could read. The .config in the middle is what people write and what the docs
// say, and it is optional here because a file that was meant to be an
// environment and is named slightly differently should be read and refused
// rather than passed over as though it were not there
const PER_ENVIRONMENT = /^redkite[.\-_](.+?)(?:\.config)?\.(?:ts|mts|cts|js|mjs|cjs)$/;

// What an environment may be called. It becomes part of an image tag, and an
// image tag cannot hold a capital, so this is docker's limit rather than ours
const ENVIRONMENT_NAME = /^[a-z0-9][a-z0-9._-]*$/;

// Node strips types itself from 22.18 on, which is what lets redkite ship with
// no dependencies. These are the ways that can fail on a config it cannot read.
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
  const config = defaultOf(await load(path), path) as Deployment;

  const manifest = manifestOf(explicit ? dirname(path) : process.cwd());
  const beside = await loadEnvironments(dirname(path));

  // The directory package.json names is read whether or not the deployment
  // turned out to be in it, so environments may sit together under one roof
  // with the deployment at the root above them
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

// A source path belongs to the file that named it, not to wherever the command
// was run. Resolving it here is what lets a deploy from a workspace and one
// from the root build the same tree
function rooted(config: Deployment, directory: string): Deployment {
  // A file that never called defineDeployment can export anything, and the
  // message worth getting is the one topologyFor gives rather than a TypeError
  if (!(config.apps ?? []).some((app) => app.path)) return config;

  return {
    ...config,
    apps: config.apps.map((app) =>
      app.path ? { ...app, path: resolve(directory, app.path) } : app,
    ),
  };
}

// package.json may name the file each environment lives in, for a repository
// that keeps them somewhere the naming convention would not find them
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

// A deployment is one file at the root of the project, and a deploy is as
// likely to be run from a workspace inside it as from there
export function discover(from: string): string {
  let directory = from;
  // Where something addressed to redkite was seen but no deployment. Naming it
  // is the difference between "there is nothing here" and "the file you have
  // is an environment, and an environment is not a deployment"
  const nearby: string[] = [];

  for (;;) {
    const declared = directoryFrom(directory);

    // Naming a directory that is not there is a mistake worth stopping for.
    // One that is there and holds no deployment is not: it may hold only the
    // environments, and the deployment may sit at the root above them
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

// The names beside a deployment that would be read as environments, for a
// message that can say what was there instead of what was not
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

// What a package.json says about redkite, and where it said it. The paths it
// names are read against its own directory rather than the working one
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

// Where the project starts, which is where a .env belongs. The nearest
// package.json above wherever this was run, and the directory itself when
// there is none
export function projectRoot(explicit?: string) {
  const from = explicit ? dirname(resolve(explicit)) : process.cwd();
  return manifestOf(from)?.root ?? from;
}

// The nearest one above wherever this was run, which is the same walk the
// config itself is found by
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

// package.json says where redkite's files live, for a repository that would
// rather not keep them at its root
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

  // A config inside a CommonJS package transpiles to CommonJS, and Node hands
  // back the whole module.exports as the default, wrapping the real one
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
