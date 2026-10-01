import { PROXY } from "./services/proxy.js";
import { assertSteps } from "./pipeline.js";
import { pluginSteps } from "./plugin.js";
import { listRefs } from "./secrets/refs.js";
import type { AnyStep } from "./pipeline.js";
import type { Deployment, Environment } from "./types.js";

// A deployment carrying its own overrides every file
export function environmentOf(config: Deployment, name: string) {
  return config.environment ?? config.environments?.[name];
}

// Folded after each app's own, so the later key wins
export function withEnvironment(config: Deployment, name: string): Deployment {
  const environment = environmentOf(config, name);
  if (!environment?.secrets && !environment?.files && !environment?.steps) return config;

  const { secrets = {}, files = {}, steps, ...rest } = environment;
  assertNamesApps(config, name, [...Object.keys(secrets), ...Object.keys(files)]);

  const apps = config.apps.map((app) => {
    const refs = secrets[app.name];
    const paths = files[app.name];
    if (!refs && !paths) return app;

    return {
      ...app,
      secrets: refs ? [...listRefs(app.secrets), ...listRefs(refs)] : app.secrets,
      files: paths ? { ...app.files, ...paths } : app.files,
    };
  });

  const folded = { ...config, apps, steps: steps ? stepsWith(config, steps) : config.steps };

  // Folding twice adds nothing, so a caller can hand the result on
  if (config.environment) return { ...folded, environment: rest };
  return { ...folded, environments: { ...config.environments, [name]: rest } };
}

// A shared point is replaced in place; a new one leads, like a plugin's
function stepsWith(config: Deployment, given: AnyStep[]) {
  // Before the replacement map, which would keep one of two without a word
  assertSteps(given);

  const shared = config.steps ?? [];
  const claimed = new Set(shared.map((step) => step.point));
  const replacing = new Map(given.map((step) => [step.point, step]));

  const steps = [
    ...given.filter((step) => !claimed.has(step.point)),
    ...shared.map((step) => replacing.get(step.point) ?? step),
  ];

  // A plugin fills points too, and landing on one is the same collision
  assertSteps([...pluginSteps(config.plugins), ...steps]);
  return steps;
}

// An environment file does not import the deployment, so a typo reads nothing
function assertNamesApps(config: Deployment, environment: string, names: string[]) {
  const apps = new Set(config.apps.map((app) => app.name));
  const unknown = names.filter((name) => !apps.has(name));
  if (unknown.length === 0) return;

  throw new Error(
    `${environment} gives secrets to ${unknown.join(", ")}, which this deployment ` +
      `has no app by that name for. Its apps are ${[...apps].join(", ")}`,
  );
}

// Pins the type, so a missing health predicate fails to compile
export function defineDeployment<const T extends Deployment & { environments?: never }>(
  config: T,
): T {
  assertUniqueNames(config);
  assertOneSource(config);
  assertRoutesResolvable(config);
  assertDirsRelative(config);
  assertUniquePlugins(config);
  // Together, because two steps at one point is the collision worth catching
  assertSteps([...pluginSteps(config.plugins), ...(config.steps ?? [])]);
  return config;
}

// Pins the type the same way, so a missing subnet fails to compile
export function defineEnvironment<const T extends Environment>(environment: T): T {
  if (environment.steps) assertSteps(environment.steps);
  return environment;
}

// Registering one twice is a mistake or two configs, and neither has a winner
function assertUniquePlugins(config: Deployment) {
  const seen = new Set<string>();

  for (const plugin of config.plugins ?? []) {
    if (seen.has(plugin.name)) {
      throw new Error(`The plugin ${plugin.name} is registered twice`);
    }

    seen.add(plugin.name);
  }
}

// Cloned or already here, and guessing between them is worse than being told
function assertOneSource(config: Deployment) {
  for (const app of config.apps) {
    if (app.repo && app.path) {
      throw new Error(`${app.name} names both a repo and a path, and is built from one of them`);
    }

    if (!app.repo && !app.path) {
      throw new Error(`${app.name} names no source, so give it a repo to clone or a path to build`);
    }

    // A clone is whatever the repository holds, so an include would do nothing
    if (app.include && !app.path) {
      throw new Error(`${app.name} says what to include, but is cloned rather than built from a path`);
    }

    const refs = ["branch", "tag", "commit"].filter((kind) => app[kind as "branch"]);

    if (refs.length > 1) {
      throw new Error(
        `${app.name} names ${refs.join(" and ")} to build from, and they are different commits`,
      );
    }

    if (app.include?.length === 0) {
      throw new Error(`${app.name} includes nothing, so there would be no build context`);
    }
  }
}

// Joined onto /app, so an absolute dir doubles a slash and a climbing one escapes
function assertDirsRelative(config: Deployment) {
  for (const app of config.apps) {
    const dir = app.dir;
    if (dir === undefined) continue;

    if (!dir || dir.startsWith("/") || dir.endsWith("/")) {
      throw new Error(`dir for ${app.name} must be a path inside the repository`);
    }

    if (dir.split("/").includes("..")) {
      throw new Error(`dir for ${app.name} must not climb out of the repository`);
    }
  }
}

function assertUniqueNames(config: Deployment) {
  const names = [...config.apps, ...config.services].map((item) => item.name);
  const duplicate = names.find((name, i) => names.indexOf(name) !== i);
  if (duplicate) throw new Error(`Duplicate name in deployment: ${duplicate}`);

  // The proxy already has this name, and a second container on it is indistinguishable
  if (!names.includes(PROXY)) return;

  throw new Error(
    `${PROXY} is the derived proxy, so a service cannot be called that. ` +
      "What it runs and what goes in its server block is proxy: nginx({ … })",
  );
}

// Two apps on one route leaves nginx precedence to decide which is unreachable
function assertRoutesResolvable(config: Deployment) {
  // Without a proxy nothing reads a route, so one written reads as a way in
  if (config.proxy === false) {
    const routed = config.apps.find((app) => app.route !== undefined);
    if (!routed) return;

    throw new Error(
      `${routed.name} has a route, and this deployment runs no proxy to resolve it. ` +
        "Its port is published by the environment's ports instead",
    );
  }

  const unrouted = config.apps.find((app) => app.route === undefined);
  if (unrouted) {
    throw new Error(`${unrouted.name} has no route, and the proxy resolves every app by one`);
  }

  const routes = config.apps.map((app) => app.route);
  const duplicate = routes.find((route, i) => routes.indexOf(route) !== i);
  if (duplicate) throw new Error(`Two apps share the route ${duplicate}`);

  for (const app of config.apps) {
    if (app.route?.startsWith("/")) continue;
    throw new Error(`Route for ${app.name} must start with a slash`);
  }
}
