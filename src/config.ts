import { assertSteps } from "./pipeline.js";
import type { Deployment, Environment } from "./types.js";

// The one selected, from the one place worth looking. A deployment that carries
// its own overrides every file, which is what makes it an override rather than
// a default nobody can displace
export function environmentOf(config: Deployment, name: string) {
  return config.environment ?? config.environments?.[name];
}

// Identity, but it pins the type so a missing health predicate fails to
// compile. Environments are excluded rather than merely unused: each lives in
// a redkite.<name>.config.ts of its own, and a second place to put one is a
// second place for them to disagree
export function defineDeployment<const T extends Deployment & { environments?: never }>(
  config: T,
): T {
  assertUniqueNames(config);
  assertOneSource(config);
  assertRoutesResolvable(config);
  assertDirsRelative(config);
  assertSteps(config.steps ?? []);
  return config;
}

// Identity, for the environment a redkite.<name>.config.ts holds. It pins the
// type the same way defineDeployment does, so a missing subnet fails to compile
export function defineEnvironment<const T extends Environment>(environment: T): T {
  return environment;
}

// Cloned or already here, and the two are built differently enough that
// guessing between them is worse than being told
function assertOneSource(config: Deployment) {
  for (const app of config.apps) {
    if (app.repo && app.path) {
      throw new Error(`${app.name} names both a repo and a path, and is built from one of them`);
    }

    if (!app.repo && !app.path) {
      throw new Error(`${app.name} names no source, so give it a repo to clone or a path to build`);
    }

    // A clone is whatever the repository holds, so there is nothing here to
    // narrow and an include would quietly do nothing
    if (app.include && !app.path) {
      throw new Error(`${app.name} says what to include, but is cloned rather than built from a path`);
    }

    if (app.include?.length === 0) {
      throw new Error(`${app.name} includes nothing, so there would be no build context`);
    }
  }
}

// A dir is joined onto /app inside the image, so an absolute one would render
// a path with two slashes and a climbing one would leave the checkout
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
}

// Two apps on the same route means one of them is unreachable, and which one
// depends on nginx location precedence rather than on anything written here
function assertRoutesResolvable(config: Deployment) {
  const routes = config.apps.map((app) => app.route);
  const duplicate = routes.find((route, i) => routes.indexOf(route) !== i);
  if (duplicate) throw new Error(`Two apps share the route ${duplicate}`);

  for (const app of config.apps) {
    if (app.route.startsWith("/")) continue;
    throw new Error(`Route for ${app.name} must start with a slash`);
  }
}
